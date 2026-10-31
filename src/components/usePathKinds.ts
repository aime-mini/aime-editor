import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PathKindsCache, type PathKind } from "../lib/pathKindsCache";
import { useWorkspace } from "../stores/workspace";

export type { PathKind } from "../lib/pathKindsCache";

const cache = new PathKindsCache((paths) => invoke<(PathKind | null)[]>("path_kinds", { paths }));

// Followed here, once, rather than by every message: a message subscribed to
// the tree would re-render on every change on disk, and a long conversation is
// a thousand of them.
useWorkspace.subscribe((state, previous) => {
  if (state.treeVersion !== previous.treeVersion) cache.recheck(state.treeVersion);
});

/**
 * Which of `paths` exist, and as what. Paths not yet answered are simply not
 * in the map, so a mention shows as the plain words it is until the disk has
 * said it is real. A message re-renders only when one of its own paths turns
 * out to name something else than before.
 */
export function usePathKinds(paths: readonly string[]): ReadonlyMap<string, PathKind> {
  // Only its setter is used: an answer arriving is what re-renders the message.
  const [, setAnswers] = useState(0);

  useEffect(() => {
    if (paths.length === 0) return;
    return cache.watch(paths, () => {
      setAnswers((count) => count + 1);
    });
  }, [paths]);

  const found = new Map<string, PathKind>();
  for (const path of paths) {
    const kind = cache.kindOf(path);
    if (kind) found.set(path, kind);
  }
  return found;
}
