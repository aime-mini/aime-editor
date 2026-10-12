import type * as Monaco from "monaco-editor";
import { useWorkspace } from "../stores/workspace";
import { samePath } from "./dap/paths";
import { modelPath } from "./lsp/convert";
import { activeEditor } from "./monacoAccess";

/**
 * Opens the file a jump lands in, as a tab, with the cursor on the place.
 *
 * The standalone editor stays inside the model it shows: asked to go to
 * another file - F12, Ctrl+click, a row of a peek - it hands the request to
 * whoever registered an opener, and with none it does nothing at all. That
 * was every jump across files, in every language, until 2026-10-11.
 */
export function openJumpsInTabs(api: typeof Monaco): void {
  api.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selectionOrPosition) =>
      openAt(modelPath({ uri: resource }), selectionOrPosition),
  });
}

/** How long the editor is given to show the file that was just opened. */
const SHOW_TIMEOUT_MS = 5_000;

async function openAt(path: string, place: Monaco.IRange | Monaco.IPosition | undefined): Promise<boolean> {
  const workspace = useWorkspace.getState();
  // The tab's own spelling, when the file is already open under another one.
  const tab = workspace.openTabs.find((open) => samePath(open, path)) ?? path;
  try {
    await workspace.openFile(tab);
  } catch (error: unknown) {
    console.error("could not open", tab, error);
    return false;
  }
  const editor = await editorShowing(tab);
  if (editor === null) return false;
  if (place !== undefined) {
    if ("startLineNumber" in place) editor.setSelection(place);
    else editor.setPosition(place);
    editor.revealRangeInCenterIfOutsideViewport(editorRangeAt(place));
  }
  editor.focus();
  return true;
}

/** A collapsed range at a position, for revealing it. */
function editorRangeAt(place: Monaco.IRange | Monaco.IPosition): Monaco.IRange {
  if ("startLineNumber" in place) return place;
  return {
    startLineNumber: place.lineNumber,
    startColumn: place.column,
    endLineNumber: place.lineNumber,
    endColumn: place.column,
  };
}

/** The editor once it is showing `path`: opening a tab re-renders it on the next frame, not now. */
async function editorShowing(path: string): Promise<Monaco.editor.IStandaloneCodeEditor | null> {
  const deadline = Date.now() + SHOW_TIMEOUT_MS;
  for (;;) {
    const editor = activeEditor();
    const model = editor?.getModel();
    if (editor && model && samePath(modelPath(model), path)) return editor;
    if (Date.now() >= deadline) {
      console.error("the editor never showed", path);
      return null;
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}
