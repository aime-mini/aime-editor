/**
 * Files the person saved from the editor, as they are saved.
 *
 * A task run works in the person's own tree, and a person who comes back
 * mid-run and saves a file there changes what every later check measures -
 * the run has to know, and say so (`stores/run.ts`). Only the editor's own
 * saves are announced here: they are the one kind of write that is certainly
 * a person's, where the file watcher cannot tell a keystroke from the agent.
 */
type SavedListener = (path: string) => void;

const listeners = new Set<SavedListener>();

/** Hears every file the editor saves from now on; the answer stops hearing. */
export function onFileSaved(listener: SavedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every listener that the editor wrote `path` to disk. */
export function announceFileSaved(path: string): void {
  for (const listener of listeners) listener(path);
}
