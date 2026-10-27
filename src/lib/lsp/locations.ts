import { invoke } from "@tauri-apps/api/core";
import { useWorkspace } from "../../stores/workspace";
import { samePath } from "../dap/paths";
import { languageOf } from "../languages";
import { monaco } from "../monaco";
import { inWorkspaceSpelling, modelPath, toMonacoRange, uriToPath, type LspRange } from "./convert";

/**
 * Where a server says something is, as places the editor can go.
 *
 * Two things stood between a correct answer and a jump that happens. Monaco
 * compares URIs as strings, and `@monaco-editor/react` names a tab's model
 * `Uri.parse(path)` - `C:%5CProjects%5Ca.cs` - while the answer was named
 * `Uri.file(path)` - `file:///c%3A/Projects/a.cs`. Measured: the two
 * never match, so even a definition in the same file read as "another file",
 * and F12 did nothing. And a peek shows each place inside the text around it,
 * which the standalone editor only finds in a model that already exists - for
 * a file nobody has open there is none, and the list had nothing to show.
 */

/** A `Location`, or the `LocationLink` a server sends when the client says it can read one. */
export interface LspLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetSelectionRange?: LspRange;
}

/** The URI the editor knows a file by: its open model's, or the one a tab of it would get. */
export function editorUri(path: string): monaco.Uri {
  const open = monaco.editor.getModels().find((model) => samePath(modelPath(model), path));
  return open?.uri ?? monaco.Uri.parse(inWorkspaceSpelling(path, useWorkspace.getState().rootPath));
}

/** A definition, reference or implementation answer - one location, several, or none. */
export function toEditorLocations(answer: unknown): monaco.languages.Location[] {
  const locations = (Array.isArray(answer) ? answer : answer ? [answer] : []) as LspLocation[];
  return locations.flatMap((location) => {
    const uri = location.uri ?? location.targetUri;
    const range = location.range ?? location.targetSelectionRange;
    if (!uri || !range) return [];
    return [{ uri: editorUri(uriToPath(uri)), range: toMonacoRange(range) }];
  });
}

/**
 * Models opened only so a peek can show where each place is. Kept rather than
 * disposed when the peek closes - Monaco does not say when that is - and capped,
 * the oldest let go first, so a search across a large solution does not hold
 * every file it touched.
 */
const previews: monaco.editor.ITextModel[] = [];
const PREVIEW_LIMIT = 40;

/** The locations, once every file among them has a model for the peek to read. */
export async function withPreviews(
  locations: monaco.languages.Location[],
): Promise<monaco.languages.Location[]> {
  const missing = new Map<string, monaco.Uri>();
  for (const { uri } of locations) {
    if (monaco.editor.getModel(uri) === null) missing.set(uri.toString(), uri);
  }
  await Promise.all([...missing.values()].map(openPreview));
  return locations;
}

async function openPreview(uri: monaco.Uri): Promise<void> {
  const path = modelPath({ uri });
  const text = await invoke<string>("read_file", { path }).catch((error: unknown) => {
    // A place the server knows and the disk does not - generated or decompiled
    // source. The jump can still be offered; only its preview is missing.
    console.warn("no preview for", path, error);
    return null;
  });
  // Opened by the user meanwhile, or by a second answer that got there first.
  if (text === null || monaco.editor.getModel(uri) !== null) return;
  previews.push(monaco.editor.createModel(text, languageOf(path), uri));
  letGoOfOldPreviews();
}

function letGoOfOldPreviews(): void {
  const { openTabs } = useWorkspace.getState();
  const inUse = (model: monaco.editor.ITextModel) => openTabs.some((tab) => samePath(tab, modelPath(model)));
  while (previews.length > PREVIEW_LIMIT) {
    const oldest = previews.shift();
    // A file that became a tab belongs to the editor now, not to the peek.
    if (oldest && !oldest.isDisposed() && !inUse(oldest)) oldest.dispose();
  }
}
