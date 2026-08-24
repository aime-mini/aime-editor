import { invoke } from "@tauri-apps/api/core";
import type { GitStatus } from "../stores/git";
import { collectEvidence } from "./runReport";

/**
 * What one run left behind, and the strict rules for cleaning it up.
 *
 * A run makes files: its own evidence, the folders test runners drop, the odd
 * scratch file an agent forgot. The reader gets a button to sweep them — but a
 * cleaner that guesses deletes somebody's work, so this one holds three lines
 * it never crosses. Only files the *run* created are candidates: new untracked
 * files, told apart by comparing git's untracked list from the baseline with
 * the one taken now, plus the artifacts written where Aime itself puts them.
 * Tracked files and untracked files that predate the run are never listed at
 * all. And nothing is deleted until the reader has seen the list and asked —
 * the preview *is* the confirmation.
 *
 * The run's paperwork — the test cases, the journal, the report — is not here
 * either way: it is the record of the work, not a by-product of it.
 */

/** One deletable thing, and whether it is worth keeping by default. */
export interface TrashItem {
  /** Absolute path, ready for deletion or for revealing in the file manager. */
  path: string;
  /** The same path relative to the project root, for reading. */
  shown: string;
  /**
   * True for the run's own evidence: it proves the work, so the default is to
   * keep it. Runner droppings and stray files default to being swept.
   */
  keeper: boolean;
}

/**
 * The files git calls untracked right now, repository-relative.
 *
 * Taken at the baseline this is the "was already there" list; taken at cleanup
 * time, whatever is new against that list is the run's own doing. `.aime/`
 * ignores itself in git, so the run's paperwork never appears here.
 */
export async function untrackedNow(root: string): Promise<string[]> {
  const status = await invoke<GitStatus>("git_status", { root });
  return status.files.filter((file) => file.unstaged === "?").map((file) => file.path);
}

/** The untracked files that were not there before the run. */
export function freshUntracked(before: readonly string[], now: readonly string[]): string[] {
  const known = new Set(before);
  return now.filter((path) => !known.has(path));
}

/**
 * Everything this run left that could be swept, evidence marked as worth
 * keeping. `since` is the run's own start: an artifact folder is shared between
 * runs, and one run's button must not offer another run's files.
 */
export async function trashOf(
  root: string,
  untrackedBefore: readonly string[],
  since: number,
): Promise<TrashItem[]> {
  const base = root.replace(/[\\/]+$/, "");
  const items = new Map<string, TrashItem>();
  const put = (absolute: string, keeper: boolean) => {
    const normal = absolute.replace(/\\/g, "/");
    const shown = normal.startsWith(`${base.replace(/\\/g, "/")}/`) ? normal.slice(base.length + 1) : normal;
    // A file found by both collectors is one file; the evidence collector's
    // verdict wins because "worth keeping" must never be downgraded by a tie.
    const seen = items.get(normal);
    items.set(normal, { path: absolute, shown, keeper: keeper || (seen?.keeper ?? false) });
  };

  for (const path of freshUntracked(untrackedBefore, await untrackedNow(root))) {
    put(`${base}/${path}`, false);
  }
  for (const path of await collectEvidence(root, since)) {
    put(path, path.replace(/\\/g, "/").includes("/.aime/evidence/"));
  }
  return [...items.values()].sort((a, b) => a.shown.localeCompare(b.shown));
}

/**
 * Deletes exactly what the reader ticked, and answers what would not go.
 *
 * Each failure is kept by path rather than thrown, because one locked file must
 * not stop the other nine from being swept — and the reader deserves the list
 * of what is still there, not a stack trace.
 */
export async function emptyTrash(paths: readonly string[]): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];
  for (const path of paths) {
    try {
      await invoke("delete_path", { path });
      deleted += 1;
    } catch {
      failed.push(path);
    }
  }
  return { deleted, failed };
}
