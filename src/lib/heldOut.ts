import { invoke } from "@tauri-apps/api/core";
import { runFolder } from "./runSweep";

/**
 * The change, set aside for a moment and put back exactly.
 *
 * To learn whether a case's test can tell the change apart, the test has to
 * run on the code as it was before the change. That means taking the change
 * out of the tree, and nothing about doing so may cost the change itself:
 *
 * - The changed files are moved aside, never copied through the editor's text
 *   path, which drops a byte order mark - a moved file comes back byte for byte.
 * - What was moved, and where to, is written down before the first file moves,
 *   in the run's own folder and outside the scratch folder the sweep deletes.
 *   An app that dies mid-check finds that list when the run is carried on and
 *   puts everything back first.
 * - Putting back is safe to repeat: a file already back is left alone.
 */

/** How one file differs from HEAD, as far as setting it aside goes. */
export type HeldState = "modified" | "added" | "deleted";

/** One file set aside: where it lives, how it differed from HEAD, and where its own bytes wait. */
export interface HeldFile {
  path: string;
  state: HeldState;
  /** Where the file's own bytes were moved; null for a file the change deleted, which has none. */
  backup: string | null;
}

/** Where a run sets its change aside. Not under the scratch folder: the sweep must never reach it. */
export function heldOutFolderOf(root: string, runId: string): string {
  return `${runFolder(root, runId)}/held-out`;
}

function manifestOf(root: string, runId: string): string {
  return `${heldOutFolderOf(root, runId)}/manifest.json`;
}

function absolute(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${path}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await invoke<number>("path_size", { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sets the change aside, leaving every file as HEAD has it. The list goes to
 * disk first, so a failure at any later step can be undone by `putChangeBack`.
 */
export async function setChangeAside(
  root: string,
  runId: string,
  files: readonly { path: string; state: HeldState }[],
): Promise<void> {
  const folder = heldOutFolderOf(root, runId);
  const held: HeldFile[] = files.map((file, index) => ({
    ...file,
    backup: file.state === "deleted" ? null : `${folder}/${String(index)}.held`,
  }));
  await invoke("write_file", { path: manifestOf(root, runId), content: JSON.stringify(held) });
  for (const file of held) {
    const path = absolute(root, file.path);
    if (file.backup !== null) await invoke("rename_path", { from: path, to: file.backup });
    if (file.state !== "added") {
      const before = await invoke<string>("git_show_head", { root, path: file.path });
      await invoke("write_file", { path, content: before });
    }
  }
}

/**
 * Puts the change back where `setChangeAside` took it from, and answers what it could
 * not - each path with why. Nothing set aside, nothing to do.
 */
export async function putChangeBack(root: string, runId: string): Promise<string[]> {
  let held: HeldFile[];
  try {
    held = JSON.parse(await invoke<string>("read_file", { path: manifestOf(root, runId) })) as HeldFile[];
  } catch {
    return [];
  }
  const problems: string[] = [];
  for (const file of held) {
    const path = absolute(root, file.path);
    try {
      // The HEAD version written in its place goes first; a file already put
      // back has no backup left and is not touched.
      if (file.backup === null) {
        if (await exists(path)) await invoke("delete_path", { path });
      } else if (await exists(file.backup)) {
        if (await exists(path)) await invoke("delete_path", { path });
        await invoke("rename_path", { from: file.backup, to: path });
      }
    } catch (error: unknown) {
      problems.push(`${file.path}: ${String(error)}`);
    }
  }
  if (problems.length === 0) await invoke("delete_path", { path: heldOutFolderOf(root, runId) });
  return problems;
}
