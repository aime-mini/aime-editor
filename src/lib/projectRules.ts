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
  "ARCHITECTURE.md",
  "docs/ARCHITECTURE.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
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
  text: string;
  /** True when the file was longer than what is carried. */
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
  for (const path of RULE_FILES) {
    if (budget <= 0) break;
    let whole: string;
    try {
      whole = await invoke<string>("read_file", { path: `${base}/${path}` });
    } catch {
      continue;
    }
    const trimmed = whole.trim();
    if (trimmed === "") continue;
    const room = Math.min(PER_FILE_LIMIT, budget);
    const text = trimmed.slice(0, room);
    found.push({ path, text, truncated: trimmed.length > room });
    // Charged by what was actually carried, not by the room it was offered:
    // billing every file the full allowance let two short files use up a budget
    // meant for seven.
    budget -= text.length;
  }
  return found;
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
      `--- ${file.path}${file.truncated ? " (first part)" : ""} ---`,
      file.text,
    ]),
  ];
}
