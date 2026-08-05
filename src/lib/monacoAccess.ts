import type { editor as MonacoEditor } from "monaco-editor";

/**
 * The editor the user is looking at, for the few things that genuinely need it.
 *
 * A module-level handle rather than a store field: an editor instance has
 * identity and no meaningful equality, so putting it in zustand would re-render
 * every subscriber for nothing. `EditorPane` owns it and keeps this honest —
 * everything else (plugins, future automation) asks here.
 *
 * Why an instance at all: an edit applied through Monaco is one entry in *its*
 * undo stack, so Ctrl+Z takes it back. Replacing the buffer behind Monaco's back
 * loses that, and a plugin that cannot be undone is a plugin nobody dares run.
 */
let active: MonacoEditor.IStandaloneCodeEditor | null = null;

export function setActiveEditor(editor: MonacoEditor.IStandaloneCodeEditor | null): void {
  active = editor;
}

export function activeEditor(): MonacoEditor.IStandaloneCodeEditor | null {
  return active;
}
