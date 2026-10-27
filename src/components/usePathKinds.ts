import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspace } from "../stores/workspace";

/** What a path names on disk (`fs_cmds::PathKind`). */
export type PathKind = "file" | "dir";

/**
 * What the disk said about each path, shared by every message on screen, with
 * the file-tree version it was said at. A path that was missing is asked again
 * after the next change on disk: an answer often names a file in the same
 * breath as the AI writes it.
 */
const known = new Map<string, { kind: PathKind | null; version: number }>();

function needsAsking(path: string, version: number): boolean {
  const answer = known.get(path);
  return answer === undefined || (answer.kind === null && answer.version !== version);
}

/**
 * Which of `paths` exist, and as what. Paths not yet answered are simply not
 * in the map, so a mention shows as the plain words it is until the disk has
 * said it is real.
 */
export function usePathKinds(paths: readonly string[]): ReadonlyMap<string, PathKind> {
  const version = useWorkspace((s) => s.treeVersion);
  // Only its setter is used: an answer arriving is what re-renders the message.
  const [, setAnswers] = useState(0);

  useEffect(() => {
    const asking = [...new Set(paths)].filter((path) => needsAsking(path, version));
    if (asking.length === 0) return;
    let stale = false;
    invoke<(PathKind | null)[]>("path_kinds", { paths: asking })
      .then((kinds) => {
        asking.forEach((path, index) => known.set(path, { kind: kinds[index] ?? null, version }));
        if (!stale) setAnswers((count) => count + 1);
      })
      .catch((error: unknown) => {
        console.error("could not ask the disk about the paths an answer mentions:", error);
      });
    return () => {
      stale = true;
    };
  }, [paths, version]);

  const found = new Map<string, PathKind>();
  for (const path of paths) {
    const kind = known.get(path)?.kind;
    if (kind) found.set(path, kind);
  }
  return found;
}
