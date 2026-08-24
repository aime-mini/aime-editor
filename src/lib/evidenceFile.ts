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
    if (!isFresh(entry, since)) continue;
    const id = caseOf(entry.name, caseIds);
    if (id !== null) found.get(id)?.push(entry.path);
  }
  return found;
}

/** The files proving the deployed software answered, written during this run. */
export async function deployProof(root: string, since: number): Promise<string[]> {
  const entries = await filesUnder(`${base(root)}/${DEPLOY_PROOF_DIR}`);
  return entries.filter((entry) => isFresh(entry, since)).map((entry) => entry.path);
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
