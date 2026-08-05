import { invoke } from "@tauri-apps/api/core";
import { monaco } from "../monaco";
import { LspClient } from "./client";
import {
  hoverToMarkdown,
  pathToUri,
  toLspPosition,
  toMonacoRange,
  toOutline,
  uriToPath,
  type LspRange,
  type OutlineSymbol,
} from "./convert";

/** LSP DiagnosticSeverity: 1 Error, 2 Warning, 3 Information, 4 Hint. */
function toMarkerSeverity(severity: number | undefined): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 4:
      return monaco.MarkerSeverity.Hint;
    // 3 is Information, and a diagnostic with no severity is the server saying
    // "up to the client" — treating it as information is the safe reading.
    default:
      return monaco.MarkerSeverity.Info;
  }
}

/**
 * LSP CompletionItemKind (1-based) → Monaco's own enum. The two lists agree in
 * meaning but not in numbering, so the mapping is explicit; anything a newer
 * server invents falls back to Text rather than rendering as a random icon.
 */
const COMPLETION_KINDS: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter,
};

function toCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  return (kind && COMPLETION_KINDS[kind]) ?? monaco.languages.CompletionItemKind.Text;
}

/**
 * LSP SymbolKind → Monaco's. No table this time: the two enums name the same
 * kinds in the same order and differ only in where they start, checked against
 * monaco-editor's own `editor.api.d.ts` (File 1 → 0 … TypeParameter 26 → 25).
 * A kind outside that range comes from a newer specification than this build
 * knows, and shows as a variable rather than as a random icon.
 */
const FIRST_SYMBOL_KIND: number = monaco.languages.SymbolKind.File;
const LAST_SYMBOL_KIND: number = monaco.languages.SymbolKind.TypeParameter;

function toSymbolKind(kind: number | undefined): monaco.languages.SymbolKind {
  const shifted = (kind ?? 0) - 1;
  const known = shifted >= FIRST_SYMBOL_KIND && shifted <= LAST_SYMBOL_KIND;
  return known ? shifted : monaco.languages.SymbolKind.Variable;
}

function toMonacoSymbol(symbol: OutlineSymbol): monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: toSymbolKind(symbol.kind),
    tags: [],
    range: symbol.range,
    selectionRange: symbol.selectionRange,
    children: symbol.children.map(toMonacoSymbol),
  };
}

/** Shapes of the few LSP results Aime consumes; every field is optional by design. */
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: unknown;
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
  filterText?: string;
  textEdit?: { range?: LspRange; newText: string };
}

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** Servers answer a rename with either shape; both are handled. */
interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: { textDocument?: { uri?: string }; edits?: LspTextEdit[] }[];
}

interface LspLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetSelectionRange?: LspRange;
}

/** LSP InsertTextFormat: 1 PlainText, 2 Snippet. */
const SNIPPET_FORMAT = 2;
/** Diagnostics from a server are grouped under this marker owner. */
const MARKER_OWNER = "aime-lsp";

/**
 * One language server, driven for one workspace.
 *
 * Document sync is always a full replacement (a change event without a range),
 * which the specification allows whichever sync kind the server declared. It
 * costs a string copy per keystroke and removes a whole class of desync bugs.
 */
/** Mirror of the Rust `ProjectOpenMethods` (lsp/mod.rs). */
export interface ProjectOpenMethods {
  solutionMethod: string;
  projectMethod: string;
}

/** What the project holds, as `lsp_project_files` answers. */
interface ProjectFiles {
  solutions: string[];
  projects: string[];
}

/**
 * Tells a server which project it is looking at.
 *
 * A solution wins when the repository has one - it is the unit the toolchain
 * itself works in, and the server loads every project inside it. Measured
 * against Roslyn: the two methods are not interchangeable, since handing a
 * `.csproj` to `solution/open` throws `InvalidProjectFileException` inside
 * MSBuild, and sending neither leaves the workspace empty for ever.
 */
async function openProject(client: LspClient, root: string, methods: ProjectOpenMethods): Promise<void> {
  const files = await invoke<ProjectFiles>("lsp_project_files", { root });
  if (files.solutions.length > 0) {
    const [solution] = files.solutions;
    client.notify(methods.solutionMethod, { solution: pathToUri(solution) });
    return;
  }
  if (files.projects.length > 0) {
    client.notify(methods.projectMethod, { projects: files.projects.map(pathToUri) });
  }
}

export class LanguageSession {
  private readonly openDocuments = new Map<string, { version: number; disposables: monaco.IDisposable[] }>();
  /**
   * Whether the server answers `textDocument/documentSymbol`, taken from its own
   * `initialize` reply. Asked because an outline is not decoration: sticky scroll
   * only turns on for a language that has one (see EditorPane).
   */
  private outline = false;

  private constructor(
    readonly languageId: string,
    private readonly client: LspClient,
  ) {}

  get providesOutline(): boolean {
    return this.outline;
  }

  static async start(
    languageId: string,
    root: string,
    onExit: () => void,
    /** The two method names this server accepts a project through, if any. */
    projectOpen?: ProjectOpenMethods,
  ): Promise<LanguageSession> {
    const client = await LspClient.start(languageId, root, onExit);
    const session = new LanguageSession(languageId, client);
    client.onNotification = (method, params) => {
      if (method === "textDocument/publishDiagnostics") session.publishDiagnostics(params);
    };

    const answer = await client.request<{ capabilities?: { documentSymbolProvider?: unknown } } | null>(
      "initialize",
      {
        processId: null,
        rootUri: pathToUri(root),
        workspaceFolders: [{ uri: pathToUri(root), name: root.split(/[\\/]/).pop() ?? root }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            publishDiagnostics: {},
            completion: {
              completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
      },
    );
    // Servers answer this as `true` or as an options object; both mean yes.
    session.outline = Boolean(answer?.capabilities?.documentSymbolProvider);
    client.notify("initialized", {});
    // Some servers do nothing at all until they are told which project this is.
    // Measured against Roslyn: without it every completion answers nothing, and
    // the server never says why.
    if (projectOpen) await openProject(client, root, projectOpen);
    return session;
  }

  /** Starts syncing a model and keeps syncing it until the model is disposed. */
  openModel(model: monaco.editor.ITextModel): void {
    const uri = pathToUri(model.uri.fsPath || model.uri.path);
    if (this.openDocuments.has(uri)) return;

    const entry = { version: 1, disposables: [] as monaco.IDisposable[] };
    this.openDocuments.set(uri, entry);
    this.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.languageId, version: entry.version, text: model.getValue() },
    });

    entry.disposables.push(
      model.onDidChangeContent(() => {
        entry.version += 1;
        this.client.notify("textDocument/didChange", {
          textDocument: { uri, version: entry.version },
          contentChanges: [{ text: model.getValue() }],
        });
      }),
      model.onWillDispose(() => {
        this.closeDocument(uri);
      }),
    );
  }

  private closeDocument(uri: string): void {
    const entry = this.openDocuments.get(uri);
    if (!entry) return;
    entry.disposables.forEach((disposable) => {
      disposable.dispose();
    });
    this.openDocuments.delete(uri);
    this.client.notify("textDocument/didClose", { textDocument: { uri } });
  }

  private publishDiagnostics(params: unknown): void {
    const { uri, diagnostics } = (params ?? {}) as { uri?: string; diagnostics?: LspDiagnostic[] };
    if (!uri) return;
    const model = monaco.editor
      .getModels()
      .find((candidate) => pathToUri(candidate.uri.fsPath || candidate.uri.path) === uri);
    if (!model) return;

    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      (diagnostics ?? []).map((diagnostic) => ({
        ...toMonacoRange(diagnostic.range),
        message: diagnostic.message,
        severity: toMarkerSeverity(diagnostic.severity),
        source: diagnostic.source,
        code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
      })),
    );
  }

  private documentPosition(model: monaco.editor.ITextModel, position: monaco.IPosition) {
    return {
      textDocument: { uri: pathToUri(model.uri.fsPath || model.uri.path) },
      position: toLspPosition(position),
    };
  }

  async completion(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
  ): Promise<monaco.languages.CompletionList> {
    const answer = await this.client.request<unknown>(
      "textDocument/completion",
      this.documentPosition(model, position),
    );
    const items = Array.isArray(answer)
      ? (answer as LspCompletionItem[])
      : (((answer ?? {}) as { items?: LspCompletionItem[] }).items ?? []);

    // Monaco needs a range for every item; the word under the cursor is the
    // right default when the server does not send an explicit edit.
    const word = model.getWordUntilPosition(position);
    const defaultRange: monaco.IRange = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };

    return {
      suggestions: items.map((item) => ({
        label: item.label,
        kind: toCompletionKind(item.kind),
        detail: item.detail,
        documentation: hoverToMarkdown(item.documentation) || undefined,
        sortText: item.sortText,
        filterText: item.filterText,
        insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
        insertTextRules:
          item.insertTextFormat === SNIPPET_FORMAT
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
        range: item.textEdit?.range ? toMonacoRange(item.textEdit.range) : defaultRange,
      })),
    };
  }

  async hover(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
  ): Promise<monaco.languages.Hover | null> {
    const answer = await this.client.request<{ contents?: unknown; range?: LspRange } | null>(
      "textDocument/hover",
      this.documentPosition(model, position),
    );
    const markdown = hoverToMarkdown(answer?.contents);
    if (!markdown) return null;
    return {
      contents: [{ value: markdown }],
      range: answer?.range ? toMonacoRange(answer.range) : undefined,
    };
  }

  async definition(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
  ): Promise<monaco.languages.Definition | null> {
    const answer = await this.client.request<unknown>(
      "textDocument/definition",
      this.documentPosition(model, position),
    );
    const locations = (Array.isArray(answer) ? answer : answer ? [answer] : []) as LspLocation[];
    const targets = locations.flatMap((location) => {
      // Servers answer with either a Location or a LocationLink.
      const uri = location.uri ?? location.targetUri;
      const range = location.range ?? location.targetSelectionRange;
      if (!uri || !range) return [];
      return [{ uri: monaco.Uri.file(uriToPath(uri)), range: toMonacoRange(range) }];
    });
    return targets.length > 0 ? targets : null;
  }

  async signatureHelp(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
  ): Promise<monaco.languages.SignatureHelpResult | null> {
    const answer = await this.client.request<monaco.languages.SignatureHelp | null>(
      "textDocument/signatureHelp",
      this.documentPosition(model, position),
    );
    if (!answer?.signatures.length) return null;
    return {
      value: answer,
      dispose: () => undefined,
    };
  }

  /**
   * The file's outline: what Ctrl+Shift+O lists and what sticky scroll pins.
   *
   * Empty when the server does not do outlines, rather than an error: Monaco asks
   * every provider on every edit, and a server that never answers this must not
   * fill the console with rejections.
   */
  async documentSymbols(model: monaco.editor.ITextModel): Promise<monaco.languages.DocumentSymbol[]> {
    if (!this.outline) return [];
    const answer = await this.client.request<unknown>("textDocument/documentSymbol", {
      textDocument: { uri: pathToUri(model.uri.fsPath || model.uri.path) },
    });
    return toOutline(answer).map(toMonacoSymbol);
  }

  async references(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
  ): Promise<monaco.languages.Location[]> {
    const answer = await this.client.request<LspLocation[] | null>("textDocument/references", {
      ...this.documentPosition(model, position),
      context: { includeDeclaration: true },
    });
    return (answer ?? []).flatMap((location) => {
      const uri = location.uri ?? location.targetUri;
      const range = location.range ?? location.targetSelectionRange;
      if (!uri || !range) return [];
      return [{ uri: monaco.Uri.file(uriToPath(uri)), range: toMonacoRange(range) }];
    });
  }

  /**
   * Renames a symbol across the project.
   *
   * A rename reaches files that are not open, and Monaco can only edit buffers
   * it holds. Those files are rewritten on disk instead - the watcher picks the
   * change up - while open files get real editor edits, so they stay undoable
   * and the user decides when to save them.
   */
  async rename(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    newName: string,
  ): Promise<monaco.languages.WorkspaceEdit> {
    const answer = await this.client.request<LspWorkspaceEdit | null>("textDocument/rename", {
      ...this.documentPosition(model, position),
      newName,
    });

    const byUri = answer?.changes ?? {};
    for (const documentChange of answer?.documentChanges ?? []) {
      const uri = documentChange.textDocument?.uri;
      if (uri) byUri[uri] = [...(byUri[uri] ?? []), ...(documentChange.edits ?? [])];
    }

    const openModels = new Map(
      monaco.editor
        .getModels()
        .map((candidate) => [pathToUri(candidate.uri.fsPath || candidate.uri.path), candidate]),
    );
    const edits: monaco.languages.IWorkspaceTextEdit[] = [];
    const onDisk: Promise<unknown>[] = [];

    for (const [uri, fileEdits] of Object.entries(byUri)) {
      const target = openModels.get(uri);
      if (target) {
        for (const edit of fileEdits) {
          edits.push({
            resource: target.uri,
            versionId: undefined,
            textEdit: { range: toMonacoRange(edit.range), text: edit.newText },
          });
        }
      } else {
        onDisk.push(
          invoke("apply_text_edits", { path: uriToPath(uri), edits: fileEdits }).catch((err: unknown) => {
            console.error("rename could not update", uri, err);
          }),
        );
      }
    }
    await Promise.all(onDisk);
    return { edits };
  }

  async dispose(): Promise<void> {
    for (const uri of [...this.openDocuments.keys()]) this.closeDocument(uri);
    monaco.editor.getModels().forEach((model) => {
      if (model.getLanguageId() === this.languageId) {
        monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      }
    });
    await this.client.stop();
  }
}
