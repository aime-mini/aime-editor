import { invoke } from "@tauri-apps/api/core";
import {
  INDEX_DIR,
  MEMORY_DIR,
  memoryBlock,
  parseMemory,
  recall,
  renderIndex,
  renderMemory,
  type FileChanged,
  type Focus,
  type Memory,
  type Recalled,
} from "./knowledge";
import { conventionsLearned } from "./runLearning";

/**
 * Reading and writing a project's memories (`lib/knowledge.ts`).
 *
 * Built for a project that has kept them for years: one directory listing per
 * turn, and a file is read again only when its modified time moved, so a
 * thousand memories cost a thousand reads once and one listing afterwards. The
 * index the AI browses is rewritten only when a memory changed.
 */

/** Mirror of the Rust `DirEntry`, for the fields this needs. */
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified_ms: number | null;
}

interface Cached {
  modified: number;
  memory: Memory | null;
}

/** Per project root: each memory file as last read, by file name. */
const cache = new Map<string, Map<string, Cached>>();
/** Per project root: the index as last written, so an unchanged one is not written again. */
const indexWritten = new Map<string, string>();

/** Every memory of the project; an unreadable file is left out, never guessed at. */
export async function loadMemories(root: string): Promise<Memory[]> {
  const base = trim(root);
  if (!cache.has(base)) await carryOverLegacy(base);
  const entries = await listOrEmpty(`${base}/${MEMORY_DIR}`);
  const known = cache.get(base) ?? new Map<string, Cached>();
  const now = new Map<string, Cached>();
  for (const entry of entries) {
    if (entry.is_dir || !entry.name.endsWith(".md") || entry.name === "INDEX.md") continue;
    const modified = entry.modified_ms ?? 0;
    const before = known.get(entry.name);
    if (before !== undefined && before.modified === modified) {
      now.set(entry.name, before);
      continue;
    }
    now.set(entry.name, { modified, memory: await readMemory(entry.path, entry.name) });
  }
  cache.set(base, now);
  const memories = [...now.values()].flatMap(({ memory }) => (memory === null ? [] : [memory]));
  await writeIndex(base, memories);
  return memories;
}

/** The memory block a turn about `focus` should carry, or null when the project has none. */
export async function memoryFor(root: string, focus: Focus): Promise<string | null> {
  const memories = await loadMemories(root);
  if (memories.length === 0) return null;
  const changed = await changeTimes(root, memories);
  const recalled: Recalled[] = recall(memories, focus, changed, today());
  return memoryBlock(recalled, memories.length);
}

/**
 * Writes memories Aime learned itself - from a task run's reading of the code,
 * from what its reviewer had fixed. One with the name of an existing memory
 * replaces it only when it says something new, so a person's own edit to a
 * memory is never overwritten by the same lesson learned again.
 */
export async function rememberAll(root: string, learned: readonly Memory[]): Promise<void> {
  const existing = new Map((await loadMemories(root)).map((memory) => [memory.name, memory]));
  for (const memory of learned) {
    const before = existing.get(memory.name);
    if (before !== undefined && before.summary === memory.summary) continue;
    await invoke("write_file", {
      path: `${trim(root)}/${MEMORY_DIR}/${memory.name}.md`,
      content: renderMemory(memory),
    });
  }
}

/** What an earlier Aime kept as one page of read conventions (`.aime/project.json`, 2026-10-01). */
const LEGACY_JSON = ".aime/project.json";
const LEGACY_PAGE = ".aime/PROJECT.md";

/**
 * Turns the single page an earlier Aime kept into memories, once, and removes
 * it: nothing it learned is lost, and nothing is said twice in two places.
 */
async function carryOverLegacy(base: string): Promise<void> {
  let text: string;
  try {
    text = await invoke<string>("read_file", { path: `${base}/${LEGACY_JSON}` });
  } catch {
    return; // nothing from before
  }
  const learned = (JSON.parse(text) as { learned?: { text?: unknown; kind?: unknown; seen?: unknown }[] })
    .learned;
  const memories = (learned ?? []).flatMap((one): Memory[] => {
    if (typeof one.text !== "string" || one.text.trim() === "") return [];
    const seen = typeof one.seen === "string" ? one.seen : today();
    return one.kind === "tests"
      ? conventionsLearned({ files: [], patterns: [], testsLiveIn: one.text, suites: [], raw: "" }, seen)
      : conventionsLearned({ files: [], patterns: [one.text], testsLiveIn: "", suites: [], raw: "" }, seen);
  });
  for (const memory of memories) {
    await invoke("write_file", {
      path: `${base}/${MEMORY_DIR}/${memory.name}.md`,
      content: renderMemory(memory),
    });
  }
  await invoke("delete_path", { path: `${base}/${LEGACY_JSON}` });
  try {
    await invoke("delete_path", { path: `${base}/${LEGACY_PAGE}` });
  } catch {
    // Already gone, which is the state this asks for.
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** When each file a memory cites last changed, read once per folder per turn. */
async function changeTimes(root: string, memories: readonly Memory[]): Promise<FileChanged> {
  const base = trim(root);
  const folders = new Set(memories.flatMap((memory) => memory.files.map(folderOf)));
  const times = new Map<string, number>();
  for (const folder of folders) {
    for (const entry of await listOrEmpty(folder === "" ? base : `${base}/${folder}`)) {
      if (!entry.is_dir && entry.modified_ms !== null) {
        times.set(folder === "" ? entry.name : `${folder}/${entry.name}`, entry.modified_ms);
      }
    }
  }
  return (file) => times.get(file) ?? null;
}

async function readMemory(path: string, name: string): Promise<Memory | null> {
  try {
    return parseMemory(await invoke<string>("read_file", { path }), name);
  } catch (error: unknown) {
    console.warn(`memory ${name} could not be read:`, error);
    return null;
  }
}

async function writeIndex(base: string, memories: readonly Memory[]): Promise<void> {
  if (memories.length === 0) return;
  const pages = renderIndex(memories);
  const signature = pages.map((page) => `${page.path}\n${page.content}`).join("\n");
  if (indexWritten.get(base) === signature) return;
  for (const page of pages)
    await invoke("write_file", { path: `${base}/${page.path}`, content: page.content });
  // A folder whose memories are all gone keeps no page of its own.
  const current = new Set(pages.map((page) => `${base}/${page.path}`.replace(/\\/g, "/")));
  for (const entry of await listOrEmpty(`${base}/${INDEX_DIR}`)) {
    if (!current.has(entry.path.replace(/\\/g, "/"))) await invoke("delete_path", { path: entry.path });
  }
  indexWritten.set(base, signature);
}

async function listOrEmpty(path: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("list_dir", { path });
  } catch {
    return []; // not there yet: nothing has been remembered
  }
}

function folderOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
}

function trim(root: string): string {
  return root.replace(/[\\/]+$/, "");
}
