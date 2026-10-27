import { useEffect, useLayoutEffect, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { rememberView, takeUnseenView } from "../stores/workspaceSession";

/**
 * Keeps where each file is being looked at - cursor, selection, scroll, folds -
 * and puts a file back there the first time it is shown after a restart.
 *
 * Within a run Monaco keeps every model's view itself; what it cannot do is
 * remember any of it past the window closing, and that is the part this adds.
 */
export function useKeptViewState(
  editor: MonacoEditor.IStandaloneCodeEditor | null,
  path: string | null,
): void {
  const pathRef = useRef(path);

  // A layout effect, so the path is current before the editor's own passive
  // effect swaps the model: the cursor events that swap fires belong to the
  // file being shown, and credited to the one before they would overwrite it.
  useLayoutEffect(() => {
    pathRef.current = path;
  }, [path]);

  useEffect(() => {
    if (editor === null) return;
    const keep = () => {
      const current = pathRef.current;
      const view = editor.saveViewState();
      if (current !== null && view !== null) rememberView(current, view);
    };
    const listeners = [editor.onDidChangeCursorSelection(keep), editor.onDidScrollChange(keep)];
    return () => {
      listeners.forEach((listener) => {
        listener.dispose();
      });
    };
  }, [editor]);

  // A passive effect of the parent runs after the editor's own, so the model
  // for `path` is already in place when its old view is put back.
  useEffect(() => {
    if (editor === null || path === null) return;
    const view = takeUnseenView(path);
    if (view !== undefined) editor.restoreViewState(view as MonacoEditor.ICodeEditorViewState);
  }, [editor, path]);
}
