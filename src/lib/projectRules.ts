import { invoke } from "@tauri-apps/api/core";

/**
 * The rules a project wrote down, read off disk and handed to every phase that
 * decides or writes code.
 *
 * A run used to work only from conventions a model *observed* while reading the
 * repository. That misses the strongest evidence there is: a team that already
 * settled its architecture and wrote it in a file. Aime cannot lean on the CLI
 * picking those files up on its own either - each CLI reads a different set, and
 * the review phase goes through a one-shot call that carries none of them.
 *
 * So the files are read here, by name, and put in the prompt where a phase
 * cannot miss them.
 */

/**
 * The files that hold a project's own rules, in the order they are read.
 *
 * Every one of them is a file some tool or team already treats as instructions -
 * the two canonical AI memory files, the architecture and contribution notes a
 * repository keeps for people, and the rule files Cursor and Copilot read. None
 * of it is guessed: a path invented here would put a missing file's name in
 * front of the model as if it mattered.
 */
export const RULE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  // Gemini CLI's context file (its docs, 0.68.0).
  "GEMINI.md",
  "ARCHITECTURE.md",
  "docs/ARCHITECTURE.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
] as const;

/**
 * Folders whose every file of one kind is a rule file: Cursor's project rules
 * (`.cursor/rules/*.mdc`) and GitHub Copilot's path-specific instructions
 * (`.github/instructions/NAME.instructions.md`), as each tool's docs name them.
 */
export const RULE_FOLDERS = [
  { folder: ".cursor/rules", ending: ".mdc" },
  { folder: ".github/instructions", ending: ".instructions.md" },
] as const;

/**
 * How much of one file is carried, and how much of all of them together.
 *
 * A cap rather than the whole file because these grow: this project's own
 * architecture notes are tens of thousands of words, and a prompt that spends
 * its context on paragraph 400 of a design document has nothing left for the
 * code. The head of the file is where a rule document states its rules.
 */
const PER_FILE_LIMIT = 6_000;
const TOTAL_LIMIT = 12_000;

/** One rule file, as much of it as is carried. */
export interface RuleFile {
  path: string;
  /** Its opening, or nothing once the budget is spent - the file is then named and not quoted. */
  text: string;
  /** True when the file was longer than what is carried: the AI is told to read the rest itself. */
  truncated: boolean;
}

/**
 * Reads whichever rule files this project has.
 *
 * A missing file is the normal case and says nothing, so it is skipped in
 * silence. A file that exists but cannot be read is skipped too: a run is not
 * worth stopping over a permission on a document, and the phases below say
 * plainly which rules they were given.
 */
export async function readProjectRules(root: string): Promise<RuleFile[]> {
  const base = root.replace(/[\\/]+$/, "");
  const found: RuleFile[] = [];
  let budget = TOTAL_LIMIT;
  for (const path of [...RULE_FILES, ...(await filesInRuleFolders(base))]) {
    let whole: string;
    try {
      whole = await invoke<string>("read_file", { path: `${base}/${path}` });
    } catch {
      continue;
    }
    const trimmed = whole.trim();
    if (trimmed === "") continue;
    // Past the budget a rule file is still named: the AI reads it itself, since
    // a rule nobody mentioned is a rule nobody follows.
    const room = Math.max(0, Math.min(PER_FILE_LIMIT, budget));
    const text = trimmed.slice(0, room);
    found.push({ path, text, truncated: trimmed.length > room });
    // Charged by what was actually carried, not by the room it was offered:
    // billing every file the full allowance let two short files use up a budget
    // meant for seven.
    budget -= text.length;
  }
  return found;
}

/** The rule files in the rule folders, in name order; a folder the project does not have holds none. */
async function filesInRuleFolders(base: string): Promise<string[]> {
  const files: string[] = [];
  for (const { folder, ending } of RULE_FOLDERS) {
    let entries: { name: string; is_dir: boolean }[];
    try {
      entries = await invoke<{ name: string; is_dir: boolean }[]>("list_dir", { path: `${base}/${folder}` });
    } catch {
      continue;
    }
    files.push(
      ...entries
        .filter((entry) => !entry.is_dir && entry.name.toLowerCase().endsWith(ending))
        .map((entry) => `${folder}/${entry.name}`)
        .sort(),
    );
  }
  return files;
}

/**
 * The rules as a prompt block, or nothing at all.
 *
 * Empty when the project wrote none, because a heading with nothing under it
 * reads as "this project has no rules" - which is a claim, and the wrong one.
 */
export function rulesBlock(files: readonly RuleFile[]): string[] {
  if (files.length === 0) return [];
  return [
    "",
    "This project wrote its own rules down. They outrank your defaults and outrank anything you infer",
    "from the code - where they and the code disagree, follow these and say so in your final message:",
    ...files.flatMap((file) => [
      "",
      `--- ${file.path}${carriedNote(file)} ---`,
      ...(file.text === "" ? [] : [file.text]),
    ]),
  ];
}

/** What a heading says about how much of its file is below it. */
function carriedNote(file: RuleFile): string {
  if (!file.truncated) return "";
  return file.text === ""
    ? " (not quoted here - open and read the whole file before you write code)"
    : " (its first part - open the file and read the rest before you write code)";
}
