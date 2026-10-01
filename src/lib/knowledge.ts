/**
 * Aime's knowledge of a project: a tree of small memories, and the choice of
 * which ones a turn needs.
 *
 * One file per memory under `.aime/memory/`, each one fact - a decision the
 * person made, how this codebase does something, a trap someone fell into,
 * work left unfinished - with the folder it applies to and the files it can be
 * checked against. The folders make the tree: a memory about `src/cart` is
 * inherited by every file under it, the way a stylesheet or `.gitignore` is,
 * and one scoped to `/` holds for the whole project.
 *
 * Which memories a turn needs is the AI's call, not Aime's: matching words
 * cannot see that "how prices are rounded" is about "money is integer cents",
 * and the model can. So every turn carries the index - one line per memory,
 * the summary being the fact itself - and the AI opens the files that bear on
 * the request, the way a person reads a table of contents. Past what one turn
 * should carry, the index is the whole project's lines, the folders in view,
 * and a page per folder for the rest. Nothing is summarised and nothing is
 * thrown away, and a memory whose evidence changed since it was written is
 * marked for checking rather than trusted.
 *
 * Pure: reading the files is `knowledgeStore.ts`.
 */

export const MEMORY_DIR = ".aime/memory";
export const INDEX_FILE = `${MEMORY_DIR}/INDEX.md`;

export type MemoryKind = "decision" | "convention" | "pitfall" | "work";
const KINDS: readonly MemoryKind[] = ["decision", "convention", "pitfall", "work"];

/** The whole project, as a scope. */
export const ROOT_SCOPE = "/";

export interface Memory {
  /** Kebab-case, unique; the file is `<name>.md`. */
  name: string;
  kind: MemoryKind;
  /** The folder it applies to, relative to the project root with forward slashes; `/` for all of it. */
  scope: string;
  summary: string;
  /** Where it can be checked, relative to the project root. */
  files: string[];
  /** The day it was last written, `YYYY-MM-DD`. */
  updated: string;
  body: string;
}

/** The files a turn works on, relative to the project root: which folders' pages a large index opens on. */
export type Focus = readonly string[];

/** When each cited file was last changed, or null for one that no longer exists. */
export type FileChanged = (file: string) => number | null;

/**
 * Index lines a turn carries whole. About five thousand tokens at the most -
 * a fraction of any provider's context - and past it the index goes by folder.
 */
const INDEX_LINES = 200;

/** Reads one memory file; null when it is not a memory. */
export function parseMemory(text: string, fileName: string): Memory | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const kind = fields.get("kind") as MemoryKind | undefined;
  const summary = fields.get("summary") ?? "";
  if (kind === undefined || !KINDS.includes(kind) || summary === "") return null;
  return {
    name: fields.get("name") || fileName.replace(/\.md$/i, ""),
    kind,
    scope: normalizeScope(fields.get("scope") ?? ROOT_SCOPE),
    summary,
    files: (fields.get("files") ?? "")
      .split(",")
      .map((file) => file.trim().replace(/\\/g, "/"))
      .filter(Boolean),
    updated: fields.get("updated") ?? "",
    body: match[2].trim(),
  };
}

/** One memory as its file reads. */
export function renderMemory(memory: Memory): string {
  return [
    "---",
    `name: ${memory.name}`,
    `kind: ${memory.kind}`,
    `scope: ${memory.scope}`,
    `summary: ${memory.summary}`,
    `files: ${memory.files.join(", ")}`,
    `updated: ${memory.updated}`,
    "---",
    memory.body,
    "",
  ].join("\n");
}

/** A name for a memory from what it says: lowercase words joined by dashes. */
export function nameFor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join("-");
}

/**
 * What every turn carries: the index, and how to use it. Null for a project
 * that remembers nothing yet - the standing instructions already say where
 * memories go.
 */
export function memoryBlock(memories: readonly Memory[], focus: Focus, changed: FileChanged): string | null {
  if (memories.length === 0) return null;
  const listed = (held: readonly Memory[]) => held.map((memory) => turnLine(memory, changed));
  const tree = treeOf(memories);
  const lines =
    memories.length <= INDEX_LINES
      ? tree.flatMap(({ scope, memories: held }) => [`## ${scope}`, ...listed(held)])
      : largeIndex(tree, focus, listed);
  return [
    "<aime_memory>",
    `The index of what Aime remembers about this project, ${String(memories.length)} memories in ${MEMORY_DIR}/, one line each. Before you act, decide by meaning - not by matching words - which of them bear on this request, and open those files for the detail. The user's decisions outrank your defaults. A line marked STALE cites code that changed since it was written: check it before relying on it, then update or delete it.`,
    ...lines,
    "</aime_memory>",
  ].join("\n");
}

/** The whole project's lines, every folder on the path to the files in view, and the rest by page. */
function largeIndex(
  tree: readonly { scope: string; memories: Memory[] }[],
  focus: Focus,
  listed: (held: readonly Memory[]) => string[],
): string[] {
  const open = tree.filter(({ scope }) => scope === ROOT_SCOPE || focus.some((file) => covers(scope, file)));
  const shut = tree.filter((node) => !open.includes(node));
  return [
    ...open.flatMap(({ scope, memories: held }) => [`## ${scope}`, ...listed(held)]),
    "## Other folders - open the page of any that bears on the request",
    ...shut.map(({ scope, memories: held }) => `- ${scope}: ${String(held.length)} · ${pagePath(scope)}`),
  ];
}

/** One page of the index: where it is written, and what it says. */
export interface IndexPage {
  path: string;
  content: string;
}

/**
 * The index every AI can open: every memory, by the folder it applies to.
 *
 * One page while it is small. Past `INDEX_LINES` memories the index itself
 * would be the file too large to read in a turn - which is the one thing an
 * index must never be - so the first page lists the folders with how many
 * memories each holds, and each folder gets a page of its own.
 */
export function renderIndex(memories: readonly Memory[]): IndexPage[] {
  const tree = treeOf(memories);
  const header = [
    "# Project memory - index",
    "",
    `Written by Aime from the files in ${MEMORY_DIR}/; edit those, not this. One line per memory: kind, name, summary.`,
  ];
  if (memories.length <= INDEX_LINES) {
    return [
      {
        path: INDEX_FILE,
        content: [
          ...header,
          ...tree.flatMap(({ scope, memories: held }) => ["", `## ${scope}`, ...held.map(line)]),
          "",
        ].join("\n"),
      },
    ];
  }
  const pages = tree.map(({ scope, memories: held }) => ({
    path: pagePath(scope),
    content: [`# Memories for ${scope}`, "", ...held.map(line), ""].join("\n"),
  }));
  return [
    {
      path: INDEX_FILE,
      content: [
        ...header,
        "",
        `${String(memories.length)} memories - open the page of the folder you are working in:`,
        ...tree.map(
          ({ scope, memories: held }, index) => `- ${scope}: ${String(held.length)} · ${pages[index].path}`,
        ),
        "",
      ].join("\n"),
    },
    ...pages,
  ];
}

/** Where the per-folder pages of a split index live. */
export const INDEX_DIR = `${MEMORY_DIR}/index`;

function line(memory: Memory): string {
  return `- ${memory.kind} \`${memory.name}\` - ${memory.summary}`;
}

function pagePath(scope: string): string {
  return `${INDEX_DIR}/${scope === ROOT_SCOPE ? "_root" : scope.replace(/[^\w.-]+/g, "_")}.md`;
}

/** Every folder that has memories, with its own, the whole project first. */
export function treeOf(memories: readonly Memory[]): { scope: string; memories: Memory[] }[] {
  return [...new Set(memories.map((memory) => memory.scope))]
    .sort((a, b) => (a === ROOT_SCOPE ? -1 : b === ROOT_SCOPE ? 1 : a.localeCompare(b)))
    .map((scope) => ({
      scope,
      memories: memories.filter((memory) => memory.scope === scope).sort(newestFirst),
    }));
}

/** The cited files that are gone, or changed after the day the memory was written. */
function staleFiles(memory: Memory, changed: FileChanged): string[] {
  const writtenUntil = Date.parse(`${memory.updated}T23:59:59Z`);
  return memory.files.filter((file) => {
    const at = changed(file);
    return at === null || (Number.isFinite(writtenUntil) && at > writtenUntil);
  });
}

/** An index line as a turn reads it: the same line, and why it may no longer hold. */
function turnLine(memory: Memory, changed: FileChanged): string {
  const stale = staleFiles(memory, changed);
  return stale.length === 0
    ? line(memory)
    : `${line(memory)} - STALE since ${memory.updated}: ${stale.join(", ")}`;
}

function covers(scope: string, file: string): boolean {
  return scope === ROOT_SCOPE || file === scope || file.startsWith(`${scope}/`);
}

function normalizeScope(scope: string): string {
  const clean = scope.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  return clean === "" || clean === "." ? ROOT_SCOPE : clean;
}

function newestFirst(a: Memory, b: Memory): number {
  return b.updated.localeCompare(a.updated);
}
