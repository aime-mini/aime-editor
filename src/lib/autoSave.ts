import { useSettings } from "../stores/settings";
import { useWorkspace } from "../stores/workspace";

/**
 * A second after the typing stops, not on every keystroke.
 *
 * The number is VS Code's own `files.autoSaveDelay` default, and the delay is
 * the whole point: every write wakes the workspace watcher, which refreshes the
 * git status, the tree and the diff view. One of those per character typed is a
 * different feature - a slow editor.
 */
const SAVE_DELAY_MS = 1000;

/**
 * Armed saves, keyed by file.
 *
 * By file rather than "the file in front of you": moving to another tab parks
 * the text of the one just left, and a save that has not fired yet still has to
 * be about the file it was armed for. Keyed by the editor's own path, so the
 * same file can never hold two timers.
 */
const armed = new Map<string, ReturnType<typeof setTimeout>>();

function arm(path: string) {
  const waiting = armed.get(path);
  if (waiting !== undefined) clearTimeout(waiting);
  armed.set(
    path,
    setTimeout(() => {
      armed.delete(path);
      // Switched off while this one waited: the user asked for manual saves
      // before it fired, and that answer is more recent than this timer.
      if (!useSettings.getState().autoSave) return;
      useWorkspace
        .getState()
        .saveBuffer(path)
        .catch((err: unknown) => {
          // A locked or read-only file must not cost the user their text. The
          // buffer stays dirty, so the next keystroke and Ctrl+S both try again.
          console.error("auto save failed:", err);
        });
    }, SAVE_DELAY_MS),
  );
}

/**
 * Saves edited files without the user asking, while the setting is on.
 *
 * Returns the unsubscribe, so the app root can wire it like any other listener.
 */
export function startAutoSave(): () => void {
  return useWorkspace.subscribe((state, previous) => {
    if (!useSettings.getState().autoSave) return;
    if (!state.openFilePath || !state.dirty) return;
    // Only an edit arms the timer. Everything else the workspace publishes -
    // a tree refresh, a diff being opened - leaves the file exactly as it was.
    const edited = state.fileContent !== previous.fileContent || state.openFilePath !== previous.openFilePath;
    if (edited) arm(state.openFilePath);
  });
}
