import { invoke } from "@tauri-apps/api/core";

/**
 * The artifacts the deliver phase must leave, and how Aime checks them.
 *
 * The agent is told to drive the running software and save what it saw —
 * a screenshot, a response body, a captured test run — one artifact per test
 * case, named after the case, plus proof that the deployed thing answered at
 * all. Aime never takes any of that on trust: a claim of evidence is checked
 * as a file that exists, is not empty, and was written during this run. A
 * screenshot from last Tuesday proves nothing about today, and an empty file
 * proves nothing about anything.
 */

/** Where a run's own evidence lives, inside the project's `.aime/`. */
export const EVIDENCE_DIR = ".aime/evidence";

/** Where the proof that the deployed software answered lives. */
export const DEPLOY_PROOF_DIR = ".aime/evidence/deploy";

/** Mirror of the Rust `DirEntry`, for the fields the checks need. */
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified_ms: number | null;
  size_bytes: number | null;
}

/** Whether this entry is a real artifact of this run, not a leftover or a stub. */
function isFresh(entry: DirEntry, since: number): boolean {
  return (
    !entry.is_dir &&
    entry.modified_ms !== null &&
    entry.modified_ms >= since &&
    entry.size_bytes !== null &&
    entry.size_bytes > 0
  );
}

/**
 * Which case an artifact's file name claims to be about, or null.
 *
 * The convention the prompt states: the name starts with the case id, followed
 * by a dot or a dash — `TC1.png`, `TC1-after-save.png`. Exported for the tests;
 * matching is case-insensitive because Windows file names are.
 */
export function caseOf(name: string, caseIds: readonly string[]): string | null {
  const lower = name.toLowerCase();
  return (
    caseIds.find(
      (id) => lower.startsWith(`${id.toLowerCase()}.`) || lower.startsWith(`${id.toLowerCase()}-`),
    ) ?? null
  );
}

/**
 * The evidence on disk for each case: fresh, non-empty files named after it.
 *
 * Every case id appears in the answer, mapped to an empty list when nothing on
 * disk vouches for it — so a caller reads "no evidence" from the map itself
 * rather than from a missing key.
 */
export async function caseEvidence(
  root: string,
  caseIds: readonly string[],
  since: number,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>(caseIds.map((id) => [id, []]));
  for (const entry of await filesUnder(`${base(root)}/${EVIDENCE_DIR}`)) {
    if (!isFresh(entry, since) || isUnprovedNote(entry.name)) continue;
    const id = caseOf(entry.name, caseIds);
    if (id !== null) found.get(id)?.push(entry.path);
  }
  return found;
}

/**
 * What the builder writes for a case it could not prove on this machine, named
 * `TC2.unproved.md`: why, and the exact steps a person would take. Never
 * evidence - a note that a case was not proved cannot prove it.
 */
export const UNPROVED_SUFFIX = ".unproved.md";

function isUnprovedNote(name: string): boolean {
  return name.toLowerCase().endsWith(UNPROVED_SUFFIX);
}

/** How much of an "unproved here" note the report carries; the file itself has the rest. */
const UNPROVED_NOTE_CHARS = 600;

/** The cases the builder said it could not prove on this machine, each with the start of its note. */
export async function unprovedCases(
  root: string,
  caseIds: readonly string[],
  since: number,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await filesUnder(`${base(root)}/${EVIDENCE_DIR}`)) {
    if (!isFresh(entry, since) || !isUnprovedNote(entry.name)) continue;
    const id = caseOf(entry.name, caseIds);
    if (id === null) continue;
    try {
      const note = await invoke<string>("read_file", { path: entry.path });
      found.set(id, note.trim().slice(0, UNPROVED_NOTE_CHARS));
    } catch (error: unknown) {
      found.set(id, `(the note could not be read: ${String(error)})`);
    }
  }
  return found;
}

/** The files proving the deployed software answered, written during this run. */
export async function deployProof(root: string, since: number): Promise<string[]> {
  const entries = await filesUnder(`${base(root)}/${DEPLOY_PROOF_DIR}`);
  return entries.filter((entry) => isFresh(entry, since)).map((entry) => entry.path);
}

/** What a screenshot is called, for the reviewer who is pointed at them. */
const IMAGE = /\.(png|jpe?g|webp)$/i;

/** The screenshots the run left as evidence, relative to the project root. */
export async function screenshotsIn(root: string): Promise<string[]> {
  const entries = await filesUnder(`${base(root)}/${EVIDENCE_DIR}`);
  return entries
    .filter((entry) => !entry.is_dir && IMAGE.test(entry.name))
    .map((entry) => `${EVIDENCE_DIR}/${entry.name}`);
}

/** One directory level of files; a folder that is not there is simply empty. */
async function filesUnder(path: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("list_dir", { path });
  } catch {
    return [];
  }
}

function base(root: string): string {
  return root.replace(/[\\/]+$/, "");
}
