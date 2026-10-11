import {
  citedPath,
  isStale,
  nameFor,
  normalizeScope,
  ROOT_SCOPE,
  type Evidence,
  type Memory,
  type MemoryKind,
} from "./knowledge";
import { asArray, asRecord, asString, objectIn } from "./replyJson";

/**
 * Learning a project before anyone asks about it: what to study next, what to
 * tell the AI, and how its answer becomes memories. Pure - the turns and the
 * files are `projectLearner.ts`.
 *
 * A project is learned the way a developer joining it learns it: the whole
 * first - what it is, how it is built, how its parts fit - then each part on
 * its own. The AI names the parts, because only reading the code tells an
 * application from a folder of assets. Each study is one read-only turn whose
 * answer Aime writes as memories (`lib/knowledge.ts`), so the next
 * conversation, with any CLI, starts already knowing the codebase.
 *
 * What has been learned is read back from the memories themselves: a structure
 * memory for `/` means the whole was studied, one for a folder means that part
 * was. That travels with the memories, through a re-clone too
 * (`memory_mirror.rs`); only the parts still waiting and the folders already
 * looked at are kept beside them (`LearningState`).
 */

/** The parts a study of the whole may name: enough for a large monorepo, few enough to bound what learning costs. */
export const PART_LIMIT = 20;

/** Memories one study may write: one fact each, so a part rarely needs more. */
const MEMORIES_PER_STUDY = 15;

/** A memory's detail, in characters - a few lines, as the memories the CLIs write themselves. */
const BODY_LIMIT = 600;

/** Folder levels the outline shows, and its length: a map, not a listing. */
const OUTLINE_DEPTH = 3;
const OUTLINE_LINES = 300;
const ROOT_FILES_SHOWN = 40;

/** Remembered lines a study is shown for the folder it reads. */
const KNOWN_LINES = 80;

/** What a study may write. A decision is the user's word and work is a conversation's; neither is read off code. */
const LEARNED_KINDS: readonly MemoryKind[] = ["structure", "convention", "pitfall"];

/** What a learning run left to do, kept beside the memories. */
export interface LearningState {
  /** Parts named by a study of the whole and not studied yet, in the order to study them. */
  pending: string[];
  /** The top-level folders the last study of the whole was shown; one missing here is new. */
  considered: string[];
}

/** What one study answered, already shaped as memories. */
export interface Learned {
  memories: Memory[];
  /** Parts worth a study of their own; named only by a study of the whole. */
  parts: string[];
  /** Memories the code proved wrong, by name. */
  forget: string[];
}

export function parseState(text: string): LearningState {
  const object = objectIn(text);
  return {
    pending: asArray(object.pending).map(asString).filter(Boolean),
    considered: asArray(object.considered).map(asString).filter(Boolean),
  };
}

export function renderState(state: LearningState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * The studies due, in order: the whole project when it was never studied, its
 * structure memory went stale, or a top-level folder appeared that no study
 * has seen; then every part still waiting, then every part whose code changed.
 */
export function studiesDue(input: {
  files: readonly string[];
  memories: readonly Memory[];
  evidence: Evidence;
  state: LearningState;
}): string[] {
  const { files, memories, evidence, state } = input;
  const structures = memories.filter((memory) => memory.kind === "structure");
  const studied = structures.map((memory) => memory.scope);
  const stale = structures.filter((memory) => isStale(memory, evidence)).map((memory) => memory.scope);
  const parts = studied.filter((scope) => scope !== ROOT_SCOPE);
  const unseen = topFolders(files).filter(
    (folder) => !state.considered.includes(folder) && !parts.some((part) => overlaps(part, folder)),
  );
  const wholeDue = !studied.includes(ROOT_SCOPE) || stale.includes(ROOT_SCOPE) || unseen.length > 0;
  // A part whose folder is gone has nothing to read; its memories stay marked STALE for a conversation to settle.
  const partsDue = unique([...state.pending, ...stale.filter((scope) => scope !== ROOT_SCOPE)]).filter(
    (part) => files.some((file) => within(part, file)),
  );
  return wholeDue ? [ROOT_SCOPE, ...partsDue] : partsDue;
}

/** The parts studied so far: every folder with a structure memory of its own. */
export function studiedParts(memories: readonly Memory[]): string[] {
  return unique(
    memories
      .filter((memory) => memory.kind === "structure" && memory.scope !== ROOT_SCOPE)
      .map((memory) => memory.scope),
  );
}

/** The project's top-level folders, tooling folders (`.git`, `.aime`) left out. */
export function topFolders(files: readonly string[]): string[] {
  return unique(
    files
      .filter((file) => file.includes("/") && !file.startsWith("."))
      .map((file) => file.slice(0, file.indexOf("/"))),
  ).sort();
}

/** The files under `scope`, the whole list for the root. */
export function filesWithin(files: readonly string[], scope: string): string[] {
  return files.filter((file) => within(scope, file));
}

/**
 * The folders of a file list with how many files each holds, three levels
 * deep - what the AI plans its reading from, so it does not spend a dozen
 * tool calls listing directories. The shallowest folders are kept when the
 * outline would run long.
 */
export function outlineOf(files: readonly string[]): string {
  const counts = new Map<string, number>();
  const atRoot: string[] = [];
  for (const file of files) {
    const segments = file.split("/");
    if (segments.some((segment) => segment.startsWith("."))) continue;
    if (segments.length === 1) {
      atRoot.push(file);
      continue;
    }
    for (let depth = 1; depth <= Math.min(OUTLINE_DEPTH, segments.length - 1); depth++) {
      const folder = segments.slice(0, depth).join("/");
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  const folders = [...counts.keys()];
  const shown = folders
    .sort((a, b) => depthOf(a) - depthOf(b) || byPath(a, b))
    .slice(0, OUTLINE_LINES)
    .sort(byPath);
  const left = folders.length - shown.length;
  return [
    ...(atRoot.length === 0
      ? []
      : [
          `Files at the top: ${atRoot.sort().slice(0, ROOT_FILES_SHOWN).join(", ")}${atRoot.length > ROOT_FILES_SHOWN ? ", …" : ""}`,
        ]),
    ...shown.map((folder) => `${folder}/ - ${String(counts.get(folder) ?? 0)} files`),
    ...(left === 0 ? [] : [`… and ${String(left)} deeper folders`]),
  ].join("\n");
}

/**
 * The same prompt again, after an answer that could not be used: not the JSON,
 * or without the structure memory that records the study.
 */
export function askedAgain(prompt: string, scope: string): string {
  return [
    prompt,
    "",
    `Your previous answer could not be used. Answer with ONLY the JSON asked for, and include the structure memory for \`${scope}\`.`,
  ].join("\n");
}

/** The prompt for one study: of the whole project when `scope` is the root, of one part otherwise. */
export function studyPrompt(input: {
  scope: string;
  outline: string;
  known: readonly Memory[];
  evidence: Evidence;
  studied: readonly string[];
}): string {
  const { scope, outline, known, evidence, studied } = input;
  const whole = scope === ROOT_SCOPE;
  return [
    "You are reading this project for Aime, the editor it is open in. Aime keeps the project's memory - one fact per file in .aime/memory/ - so that every later conversation, with any AI, starts already knowing the codebase. Nobody is waiting on this turn. Read the code with whatever your tools allow, but change nothing: do not edit files and do not run anything that writes, installs or reaches the network. Aime writes the memories from your answer.",
    "",
    whole ? wholeTask(outline, studied) : partTask(scope, outline),
    "",
    "What Aime already remembers here. Keep a memory's name when you update it, and list in \"forget\" any memory the code proves wrong. One marked STALE cites code that changed since it was written: check it - update it, forget it, or leave it out of your answer to say it still holds. A decision is the user's word: never contradict or forget one.",
    knownLines(known, evidence),
    "",
    `Write only what you saw in the files yourself, citing them - never a guess. One fact per memory: the summary is the fact in one sentence, the body a few lines on why it holds and how to apply it. At most ${String(MEMORIES_PER_STUDY)} memories, and always the structure memory for \`${scope}\`.`,
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    whole
      ? `${MEMORY_SCHEMA},"parts":["folder/path"],"forget":["memory-name"]}`
      : `${MEMORY_SCHEMA},"forget":["memory-name"]}`,
  ].join("\n");
}

function wholeTask(outline: string, studied: readonly string[]): string {
  return [
    "Study the project as a whole, the way a developer joining it does on the first day. Its folders, with how many files each holds (dependencies, build output and tooling folders left out):",
    outline,
    "",
    '1. Write the memories every conversation about this project should start with, scope "/": one structure memory saying what the project is and does, its stack, and how its parts fit together; how it is built, run and tested, with the commands the project itself declares; and the conventions and traps that hold across the whole codebase.',
    `2. Name the parts that need a study of their own: an application, a service or a library with more code than this study can read closely. A part is a folder, and parts never overlap - name a folder or folders inside it, never both. Each part costs a turn as long as this one, so a project this study covers well needs none: do not split a small codebase. At most ${String(PART_LIMIT)}, the most central first.`,
    ...(studied.length === 0
      ? []
      : [`Parts already studied - do not name them again: ${studied.join(", ")}`]),
  ].join("\n");
}

function partTask(scope: string, outline: string): string {
  return [
    `Study one part of this project: \`${scope}\`. Read its entry points and the files the rest of the project uses from it. Its folders:`,
    outline,
    "",
    `Write memories scoped to \`${scope}\` or a folder inside it: one structure memory for \`${scope}\` itself - what it is for, where it starts, what it depends on and what uses it - then the conventions this code follows and the traps in it, one memory each.`,
  ].join("\n");
}

const MEMORY_SCHEMA =
  '{"memories":[{"name":"kebab-case-name","kind":"structure | convention | pitfall","scope":"folder/path, or / for the whole project","summary":"the fact in one sentence","files":["path/from/the/project/root"],"body":"why it holds, and how to apply it"}]';

function knownLines(known: readonly Memory[], evidence: Evidence): string {
  if (known.length === 0) return "(nothing yet)";
  return known
    .map(
      (memory) =>
        `- ${memory.kind} \`${memory.name}\` (${memory.scope}) - ${memory.summary}${isStale(memory, evidence) ? " - STALE" : ""}`,
    )
    .join("\n");
}

/**
 * A study's answer, or null when it is not one: not the JSON asked for, or no
 * structure memory for the folder studied - the one memory that records the
 * study happened, without which the same part would be studied again on every
 * open. Memories about a folder outside the one studied are dropped.
 */
export function parseLearned(reply: string, context: { scope: string; day: string }): Learned | null {
  const object = objectIn(reply);
  if (!Array.isArray(object.memories)) return null;
  const memories = asArray(object.memories)
    .map((entry) => learnedMemory(asRecord(entry), context))
    .filter((memory): memory is Memory => memory !== null)
    .slice(0, MEMORIES_PER_STUDY);
  if (!memories.some((memory) => memory.kind === "structure" && memory.scope === context.scope)) return null;
  return {
    memories,
    parts: context.scope === ROOT_SCOPE ? separateParts(asArray(object.parts).map(asString)) : [],
    forget: unique(asArray(object.forget).map(asString).filter(Boolean)),
  };
}

/**
 * The parts as folders, none inside another: a folder studied after a folder
 * holding it would be read twice. The first named is kept, since the order is
 * the AI's ranking.
 */
function separateParts(named: readonly string[]): string[] {
  const parts: string[] = [];
  for (const part of named.map(normalizeScope)) {
    if (part === ROOT_SCOPE || parts.some((kept) => overlaps(kept, part))) continue;
    parts.push(part);
  }
  return parts.slice(0, PART_LIMIT);
}

function learnedMemory(row: Record<string, unknown>, context: { scope: string; day: string }): Memory | null {
  const kind = asString(row.kind) as MemoryKind;
  const summary = asString(row.summary);
  if (!LEARNED_KINDS.includes(kind) || summary === "") return null;
  const scope = normalizeScope(asString(row.scope) || context.scope);
  if (!within(context.scope, scope)) return null;
  return {
    name: kebab(asString(row.name)) || nameFor(summary),
    kind,
    scope,
    summary,
    files: unique(
      asArray(row.files)
        .map((file) => citedPath(asString(file)))
        .filter((file) => file !== "" && !file.includes(" ")),
    ),
    updated: context.day,
    body: asString(row.body).slice(0, BODY_LIMIT),
  };
}

/**
 * What of a study's answer is acted on: the memories it wrote, the ones it
 * forgot, and the STALE ones it was shown and left out - which the prompt says
 * means they still hold, so they are written again to record the check.
 * Without that, a part whose memory went stale would be studied on every open.
 * A decision or a piece of work is never rewritten or removed, whatever the
 * answer says.
 */
export function changesFrom(input: {
  learned: Learned;
  existing: readonly Memory[];
  shown: readonly Memory[];
  evidence: Evidence;
  day: string;
}): { write: Memory[]; forget: string[] } {
  const { learned, existing, shown, evidence, day } = input;
  const byName = new Map(existing.map((memory) => [memory.name, memory]));
  const ours = (memory: Memory | undefined) => memory === undefined || LEARNED_KINDS.includes(memory.kind);
  const answered = learned.memories.filter((memory) => ours(byName.get(memory.name)));
  const written = new Set(answered.map((memory) => memory.name));
  const forget = learned.forget.filter(
    (name) => byName.has(name) && ours(byName.get(name)) && !written.has(name),
  );
  const confirmed = shown
    .filter((memory) => LEARNED_KINDS.includes(memory.kind) && isStale(memory, evidence))
    .filter((memory) => !written.has(memory.name) && !forget.includes(memory.name))
    .map((memory) => ({ ...memory, updated: day }));
  return { write: [...answered, ...confirmed], forget };
}

/**
 * The memories a study of `scope` is shown: those about it and the folders
 * inside it, the user's decisions first and then what earlier studies wrote.
 */
export function memoriesShown(memories: readonly Memory[], scope: string): Memory[] {
  const rank = (memory: Memory) => (memory.kind === "decision" ? 0 : memory.kind === "structure" ? 1 : 2);
  return memories
    .filter((memory) => within(scope, memory.scope))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, KNOWN_LINES);
}

function within(scope: string, path: string): boolean {
  return scope === ROOT_SCOPE || path === scope || path.startsWith(`${scope}/`);
}

/** Whether one folder holds the other. */
function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function kebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function depthOf(folder: string): number {
  return folder.split("/").length;
}

/** Path order that keeps a folder next to what is inside it: `src`, `src/a`, `src-x`. */
function byPath(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = left[i].localeCompare(right[i]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
