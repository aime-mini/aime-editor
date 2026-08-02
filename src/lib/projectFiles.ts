import { invoke } from "@tauri-apps/api/core";

/**
 * The project's file list, fetched once per project.
 *
 * Both the command palette's quick-open and the composer's `@` mentions need
 * the same list, and walking a large tree twice for the same answer is the
 * kind of waste a user feels as lag. Cached by root, and dropped when the
 * project changes - a stale list is worse than a slow one.
 */
let cache: { root: string; files: Promise<string[]> } | null = null;

export function projectFiles(root: string): Promise<string[]> {
  if (cache?.root !== root) {
    cache = { root, files: invoke<string[]>("list_files", { root }) };
  }
  return cache.files;
}

/** Called when the tree changed enough that the list cannot be trusted. */
export function forgetProjectFiles(): void {
  cache = null;
}
