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
 * and the model can. So a conversation is handed the index - one line per
 * memory, the summary being the fact itself - and the AI opens the files that
 * bear on the request, the way a person reads a table of contents. Past what
 * one turn should carry, the index is the whole project's lines and the
 * folders in view, up to a ceiling, and a page per folder for the rest.
 * Nothing is summarised and nothing is thrown away, and a memory whose
 * evidence changed since it was written is marked for checking rather than
 * trusted.
 *
 * Pure: reading the files is `knowledgeStore.ts`.
 */

export const MEMORY_DIR = ".aime/memory";

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
  /** The day it was last written, `YYYY-MM-DD`, as the writer stated it. */
  updated: string;
  body: string;
}

/** The files a turn works on, relative to the project root: which folders a large index opens on. */
export type Focus = readonly string[];

/**
 * What a memory can be checked against: when each cited file was last changed
 * (null for one that no longer exists), and when the memory's own file was
 * last written. Both are the filesystem's word, not the writer's - a date the
 * AI puts in the header is a claim like the rest of the memory.
 */
export interface Evidence {
  changed: (file: string) => number | null;
  written: (memory: Memory) => number;
}

/**
 * Index lines a turn carries whole. About five thousand tokens at the most -
 * a fraction of any provider's context - and past it the index goes by folder.
 * The same ceiling holds for the part of a large index that is opened: the
 * whole project's lines plus the folders in view could otherwise outgrow the
 * small index they replace.
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
 * What a conversation is handed: the index, and how to use it. Null for a
 * project that remembers nothing yet - the standing instructions already say
 * where memories go.
 */
export function memoryBlock(memories: readonly Memory[], focus: Focus, evidence: Evidence): string | null {
  if (memories.length === 0) return null;
  const listed = (held: readonly Memory[]) => held.map((memory) => turnLine(memory, evidence));
  const tree = treeOf(memories);
  const lines =
    memories.length <= INDEX_LINES
      ? tree.flatMap(({ scope, memories: held }) => [`## ${scope}`, ...listed(held)])
      : largeIndex(tree, focus, listed);
  return [
    "<aime_memory>",
    `The index of what Aime remembers about this project, ${String(memories.length)} memories in ${MEMORY_DIR}/, one line each. Before you act, decide by meaning - not by matching words - which of them bear on this request, and open those files for the detail. The user's decisions outrank your defaults. A line marked STALE cites code that changed after it was written: check it before relying on it, then update or delete it.`,
    ...lines,
    "</aime_memory>",
  ].join("\n");
}

/** A folder that has memories, and its own. */
interface Node {
  scope: string;
  memories: Memory[];
}

/**
 * The whole project's lines and every folder on the path to the files in
 * view, up to the ceiling, and the rest by page.
 *
 * When the open folders alone hold more than a turn should carry, the
 * decisions are kept first - the user's word, which outranks the AI's
 * defaults - then the newest of the rest, and each folder's remaining lines
 * are on its page like any other folder's.
 */
function largeIndex(tree: readonly Node[], focus: Focus, listed: (held: readonly Memory[]) => string[]) {
  const open = tree.filter(({ scope }) => scope === ROOT_SCOPE || focus.some((file) => covers(scope, file)));
  const shut = tree.filter((node) => !open.includes(node));
  const kept = new Set(
    open
      .flatMap((node) => node.memories)
      .sort(decisionsFirst)
      .slice(0, INDEX_LINES),
  );
  return [
    ...open.flatMap(({ scope, memories: held }) => {
      const shown = held.filter((memory) => kept.has(memory));
      const left = held.length - shown.length;
      return [
        `## ${scope}`,
        ...listed(shown),
        ...(left === 0 ? [] : [`- … ${String(left)} more in this folder · ${pagePath(scope)}`]),
      ];
    }),
    "## Other folders - open the page of any that bears on the request",
    ...shut.map(({ scope, memories: held }) => `- ${scope}: ${String(held.length)} · ${pagePath(scope)}`),
  ];
}

/** One page of the index: where it is written, and what it says. */
export interface IndexPage {
  path: string;
  content: string;
}

/** Where the per-folder pages of a large index live. */
export const INDEX_DIR = `${MEMORY_DIR}/index`;

/**
 * The pages a large index refers to: every memory of a folder, one line each,
 * on a page of its own. None while the index is small - the block a
 * conversation is handed already lists every memory, and a page nobody is
 * sent to is a file to keep in step for nothing.
 */
export function renderPages(memories: readonly Memory[]): IndexPage[] {
  if (memories.length <= INDEX_LINES) return [];
  return treeOf(memories).map(({ scope, memories: held }) => ({
    path: pagePath(scope),
    content: [`# Memories for ${scope}`, "", ...held.map(line), ""].join("\n"),
  }));
}

function line(memory: Memory): string {
  return `- ${memory.kind} \`${memory.name}\` - ${memory.summary}`;
}

function pagePath(scope: string): string {
  return `${INDEX_DIR}/${scope === ROOT_SCOPE ? "_root" : scope.replace(/[^\w.-]+/g, "_")}.md`;
}

/** Every folder that has memories, with its own, the whole project first. */
export function treeOf(memories: readonly Memory[]): Node[] {
  return [...new Set(memories.map((memory) => memory.scope))]
    .sort((a, b) => (a === ROOT_SCOPE ? -1 : b === ROOT_SCOPE ? 1 : a.localeCompare(b)))
    .map((scope) => ({
      scope,
      memories: memories.filter((memory) => memory.scope === scope).sort(newestFirst),
    }));
}

/** The cited files that are gone, or changed after the memory's own file was last written. */
function staleFiles(memory: Memory, evidence: Evidence): string[] {
  const writtenAt = evidence.written(memory);
  return memory.files.filter((file) => {
    const at = evidence.changed(file);
    return at === null || at > writtenAt;
  });
}

/** An index line as a turn reads it: the same line, and why it may no longer hold. */
function turnLine(memory: Memory, evidence: Evidence): string {
  const stale = staleFiles(memory, evidence);
  return stale.length === 0 ? line(memory) : `${line(memory)} - STALE, changed since: ${stale.join(", ")}`;
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

function decisionsFirst(a: Memory, b: Memory): number {
  if ((a.kind === "decision") !== (b.kind === "decision")) return a.kind === "decision" ? -1 : 1;
  return newestFirst(a, b);
}
