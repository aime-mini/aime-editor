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
 * A turn gets only what bears on it: the person's project-wide decisions
 * always, then what lies on the path from the files in view up to the root,
 * then what shares the rarer words of the request - weighted by rarity, so a
 * memory about "cents" outranks one that merely says "the". Nothing is
 * summarised and nothing is thrown away: a memory not chosen is still in the
 * index the AI can open, and one whose evidence changed since it was written
 * is handed over marked for checking rather than trusted.
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

/** What a turn is about: the files in view, and the words of the request. */
export interface Focus {
  /** Relative to the project root; the first is the file in front. */
  files: string[];
  text: string;
}

/** A memory chosen for a turn, and why it may no longer hold. */
export interface Recalled {
  memory: Memory;
  /** Files it cites that are gone or changed after it was written; empty when it stands. */
  stale: string[];
}

/** When each cited file was last changed, or null for one that no longer exists. */
export type FileChanged = (file: string) => number | null;

/** Characters of memory a turn carries. About two thousand tokens: room for what bears on it, no more. */
export const TURN_BUDGET = 8_000;
/** Project-wide decisions carried on every turn, newest first, before the budget has a say. */
const PINNED_DECISIONS = 20;
/** Below this score a memory has too little to do with the turn to spend its room on. */
const RELEVANT = 1.5;
/** How much of one memory's body a turn carries; the rest is a file the AI can open. */
const BODY_KEPT = 600;
const RECENT_DAYS = 14;
/** A memory citing the very file in view: above any folder it sits in, however deep. */
const FILE_MATCH = 12;
const DAY_MS = 86_400_000;

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
 * The memories a turn carries: project-wide decisions first, then the most
 * relevant of the rest, as many as the budget holds.
 */
export function recall(
  memories: readonly Memory[],
  focus: Focus,
  changed: FileChanged,
  today: string,
  budget = TURN_BUDGET,
): Recalled[] {
  const pinned = memories
    .filter((memory) => memory.kind === "decision" && memory.scope === ROOT_SCOPE)
    .sort(newestFirst)
    .slice(0, PINNED_DECISIONS);
  const weights = rarity(memories);
  const words = wordsOf(focus.text);
  const ranked = memories
    .filter((memory) => !pinned.includes(memory))
    .map((memory) => ({ memory, score: scoreOf(memory, focus, words, weights, today) }))
    .filter(({ score }) => score >= RELEVANT)
    .sort((a, b) => b.score - a.score || newestFirst(a.memory, b.memory))
    .map(({ memory }) => memory);

  const chosen: Recalled[] = [];
  let room = budget;
  for (const memory of [...pinned, ...ranked]) {
    const size = entryOf(memory, []).length;
    if (size > room) continue;
    room -= size;
    chosen.push({ memory, stale: staleFiles(memory, changed) });
  }
  return chosen;
}

/** The block a turn carries, or null when nothing bears on it. */
export function memoryBlock(recalled: readonly Recalled[], total: number): string | null {
  if (recalled.length === 0) return null;
  return [
    "<aime_memory>",
    `What Aime knows about this project that bears on this turn, chosen from ${String(total)} memories in ${MEMORY_DIR}/ - ${INDEX_FILE} lists every one; open any you need. The user's decisions outrank your defaults. Check a memory marked stale against the code before relying on it, then update or delete it.`,
    ...recalled.map(({ memory, stale }) => entryOf(memory, stale)),
    "</aime_memory>",
  ].join("\n");
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
    path: `${INDEX_DIR}/${pageName(scope)}.md`,
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

/** Memories an index lists on one page before it splits into a page per folder. */
const INDEX_LINES = 200;
/** Where the per-folder pages of a split index live. */
export const INDEX_DIR = `${MEMORY_DIR}/index`;

function line(memory: Memory): string {
  return `- ${memory.kind} \`${memory.name}\` - ${memory.summary}`;
}

function pageName(scope: string): string {
  return scope === ROOT_SCOPE ? "_root" : scope.replace(/[^\w.-]+/g, "_");
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

function scoreOf(
  memory: Memory,
  focus: Focus,
  words: ReadonlySet<string>,
  weights: ReadonlyMap<string, number>,
  today: string,
): number {
  let score = 0;
  focus.files.forEach((file, index) => {
    // The file in front counts in full, the other open ones by half.
    const weight = index === 0 ? 1 : 0.5;
    if (memory.files.includes(file)) score += FILE_MATCH * weight;
    else if (covers(memory.scope, file)) score += (2 + depthOf(memory.scope)) * weight;
  });
  for (const word of wordsOf(`${memory.name} ${memory.summary} ${memory.body}`)) {
    if (words.has(word)) score += weights.get(word) ?? 0;
  }
  if (memory.kind === "work") score += 1;
  if (daysBetween(memory.updated, today) <= RECENT_DAYS) score += 0.5;
  return score;
}

/** How telling each word is: words most memories share say little about any one of them. */
function rarity(memories: readonly Memory[]): Map<string, number> {
  const holding = new Map<string, number>();
  for (const memory of memories) {
    for (const word of wordsOf(`${memory.name} ${memory.summary} ${memory.body}`)) {
      holding.set(word, (holding.get(word) ?? 0) + 1);
    }
  }
  const weights = new Map<string, number>();
  for (const [word, count] of holding) weights.set(word, Math.log(1 + memories.length / count));
  return weights;
}

/** The cited files that are gone, or changed after the day the memory was written. */
function staleFiles(memory: Memory, changed: FileChanged): string[] {
  const writtenUntil = Date.parse(`${memory.updated}T23:59:59Z`);
  return memory.files.filter((file) => {
    const at = changed(file);
    return at === null || (Number.isFinite(writtenUntil) && at > writtenUntil);
  });
}

function entryOf(memory: Memory, stale: readonly string[]): string {
  const body =
    memory.body.length > BODY_KEPT
      ? `${memory.body.slice(0, BODY_KEPT)}… (the rest: ${MEMORY_DIR}/${memory.name}.md)`
      : memory.body;
  return [
    `- [${memory.kind} · ${memory.scope}] ${memory.name}: ${memory.summary}`,
    ...(body === "" ? [] : [`  ${body.replace(/\n/g, "\n  ")}`]),
    ...(stale.length === 0 ? [] : [`  STALE - changed or gone since ${memory.updated}: ${stale.join(", ")}`]),
  ].join("\n");
}

function covers(scope: string, file: string): boolean {
  return scope === ROOT_SCOPE || file === scope || file.startsWith(`${scope}/`);
}

function depthOf(scope: string): number {
  return scope === ROOT_SCOPE ? 0 : scope.split("/").length;
}

function normalizeScope(scope: string): string {
  const clean = scope.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  return clean === "" || clean === "." ? ROOT_SCOPE : clean;
}

/** Common words that say nothing about which memory a turn needs. */
const STOP_WORDS = new Set(
  "the a an and or of to in on for with is are be this that it as at by from not no can will use when what how why".split(
    " ",
  ),
);

function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function newestFirst(a: Memory, b: Memory): number {
  return b.updated.localeCompare(a.updated);
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) ? (end - start) / DAY_MS : Number.POSITIVE_INFINITY;
}
