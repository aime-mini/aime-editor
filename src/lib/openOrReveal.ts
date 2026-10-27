import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useWorkspace } from "../stores/workspace";
import { openAtLine } from "./editorOpener";

/**
 * Opens a file the way a person asked to: in a tab when the editor can show
 * it, and otherwise selected in the system's file manager, where the program
 * that plays a video or shows a PDF is one double-click away. Doing nothing
 * for a file the editor cannot read looks broken; showing it as text shows
 * noise.
 */
export async function openOrReveal(path: string, line?: number): Promise<void> {
  if (!(await invoke<boolean>("opens_as_text", { path }))) {
    await revealItemInDir(path);
    return;
  }
  if (line === undefined) await useWorkspace.getState().openFile(path);
  else await openAtLine(path, line);
}
