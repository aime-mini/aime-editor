import { invoke } from "@tauri-apps/api/core";
import { monaco } from "../monaco";
import { LspClient, STARTUP_TIMEOUT_MS } from "./client";
import {
  hoverToMarkdown,
  modelPath,
  pathToUri,
  toLspPosition,
  toLspRange,
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
 * Document sync follows the kind the server declared in `initialize`: a server
 * asking for incremental sync gets Monaco's own edit ranges, everything else a
 * full replacement. The old reading - "a rangeless full text is always
 * acceptable" - was measured wrong on 2026-08-12: Roslyn dies on it (see
 * `incrementalSync`), it merely happened to be tolerated by the others.
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
 * Tells a server which project it is looking at, and answers with what it told:
 * the solution path when one was opened, `null` otherwise. A later package
 * restore targets that same solution - one restore covers all of its projects.
 *
 * A solution wins when the repository has one - it is the unit the toolchain
 * itself works in, and the server loads every project inside it. Measured
 * against Roslyn: the two methods are not interchangeable, since handing a
 * `.csproj` to `solution/open` throws `InvalidProjectFileException` inside
 * MSBuild, and sending neither leaves the workspace empty for ever.
 */
async function openProject(
  client: LspClient,
  root: string,
  methods: ProjectOpenMethods,
): Promise<string | null> {
  const files = await invoke<ProjectFiles>("lsp_project_files", { root });
  if (files.solutions.length > 0) {
    const [solution] = files.solutions;
    client.notify(methods.solutionMethod, { solution: pathToUri(solution) });
    return solution;
  }
  if (files.projects.length > 0) {
    client.notify(methods.projectMethod, { projects: files.projects.map(pathToUri) });
  }
  return null;
}

/**
 * The one server-to-client request that needs real work before it is answered:
 * Roslyn asking the client to fetch NuGet packages. Restoring is the client's
 * job by design - VS Code does the same - and skipping it loads every project
 * with its references missing (measured: 132× CS0234 in one file, member
 * completions empty while keyword completions work).
 */
const NEEDS_RESTORE_METHOD = "workspace/_roslyn_projectNeedsRestore";

/** LSP TextDocumentSyncKind.Incremental. */
const INCREMENTAL_SYNC = 2;

/** How often `whenIndexed` looks again while the server is still working. */
const INDEX_POLL_MS = 100;

/**
 * How long a server that never says it is working is given anyway.
 *
 * Some index without announcing it, and waiting out the deadline for an
 * announcement that is not coming would be worse than asking a moment early.
 */
const INDEX_GRACE_MS = 2_000;

/** The longest an index is waited for; a huge solution is slow, not stuck. */
const INDEX_DEADLINE_MS = 60_000;

/** `initialize` answers the sync kind as a bare number or inside options. */
interface InitializeAnswer {
  capabilities?: {
    documentSymbolProvider?: unknown;
    textDocumentSync?: number | { change?: number };
  };
}

export class LanguageSession {
  private readonly openDocuments = new Map<string, { version: number; disposables: monaco.IDisposable[] }>();
  /**
   * Whether the server answers `textDocument/documentSymbol`, taken from its own
   * `initialize` reply. Asked because an outline is not decoration: sticky scroll
   * only turns on for a language that has one (see EditorPane).
   */
  private outline = false;

  /**
   * Whether the server asked for edits as ranges rather than whole documents.
   * This is the server's call, not a client convenience: Roslyn declares
   * incremental sync and throws `NullReferenceException` inside
   * `ProtocolConversions.RangeToTextSpan` on a change without a range - the
   * server dies on the user's first keystroke (measured 2026-08-12).
   */
  private incrementalSync = false;

  /** The solution `openProject` announced, which is what a restore targets. */
  private solution: string | null = null;

  /** Work-done progress the server has begun and not ended yet. */
  private readonly working = new Set<string>();

  /** Whether the server has ever announced background work at all. */
  private announcesWork = false;

  /** Restores in flight by target list, so a repeated ask joins the running one. */
  private readonly restores = new Map<string, Promise<null>>();

  /** The tail of the restore queue: restores run one at a time (NuGet locks). */
  private restoreTurn: Promise<unknown> = Promise.resolve();

  /**
   * Fires with `true` while the session has a package restore running, so the
   * UI can say why completions have not arrived yet. Set by the lsp store.
   */
  onRestore: (running: boolean) => void = () => undefined;

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
      if (method === "$/progress") session.trackProgress(params);
    };
    client.onRequest = (method, params) =>
      method === NEEDS_RESTORE_METHOD ? session.restore(params) : undefined;

    const answer = await client.request<InitializeAnswer | null>(
      "initialize",
      {
        processId: null,
        rootUri: pathToUri(root),
        workspaceFolders: [{ uri: pathToUri(root), name: root.split(/[\\/]/).pop() ?? root }],
        capabilities: {
          // Not decoration: a server only reports its background work when the
          // client says it can receive it. Measured 2026-08-23 against
          // typescript-language-server 5.3 - without this line it announces
          // nothing at all, and `whenIndexed` has no way to tell an index that
          // is still running from one that has finished.
          window: { workDoneProgress: true },
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
      STARTUP_TIMEOUT_MS,
    );
    // Servers answer this as `true` or as an options object; both mean yes.
    session.outline = Boolean(answer?.capabilities?.documentSymbolProvider);
    const sync = answer?.capabilities?.textDocumentSync;
    session.incrementalSync = (typeof sync === "number" ? sync : sync?.change) === INCREMENTAL_SYNC;
    client.notify("initialized", {});
    // Some servers do nothing at all until they are told which project this is.
    // Measured against Roslyn: without it every completion answers nothing, and
    // the server never says why.
    if (projectOpen) session.solution = await openProject(client, root, projectOpen);
    return session;
  }

  /**
   * Runs `dotnet restore` for what the server asked, answering when it is done.
   *
   * The target is the opened solution when there is one - one restore covers
   * every project in it, where restoring 791 projects one by one (a real
   * repository) would not finish. Identical asks join the run already going;
   * different ones queue behind it, because parallel restores fight over
   * NuGet's own locks. The answer is always `null`: a failed restore is logged
   * and the server is answered anyway, since leaving it waiting stops every
   * other request it would serve.
   */
  private restore(params: unknown): Promise<null> {
    const asked = ((params ?? {}) as { projectFilePaths?: string[] }).projectFilePaths ?? [];
    const targets = this.solution !== null ? [this.solution] : asked;
    if (targets.length === 0) return Promise.resolve(null);

    const key = targets.join(";");
    const joined = this.restores.get(key);
    if (joined) return joined;

    const run = this.restoreTurn
      .then(async () => {
        this.onRestore(true);
        try {
          await invoke("lsp_restore", { paths: targets });
        } finally {
          this.onRestore(false);
        }
        return null;
      })
      .catch((err: unknown) => {
        console.error("package restore failed:", err);
        return null;
      })
      .finally(() => {
        this.restores.delete(key);
      });
    this.restores.set(key, run);
    this.restoreTurn = run;
    return run;
  }

  /** Starts syncing a model and keeps syncing it until the model is disposed. */
  openModel(model: monaco.editor.ITextModel): void {
    const uri = pathToUri(modelPath(model));
    if (this.openDocuments.has(uri)) return;

    const entry = { version: 1, disposables: [] as monaco.IDisposable[] };
    this.openDocuments.set(uri, entry);
    this.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.languageId, version: entry.version, text: model.getValue() },
    });

    entry.disposables.push(
      model.onDidChangeContent((event) => {
        entry.version += 1;
        // A server that declared incremental sync gets Monaco's own edits.
        // Monaco reports them against the pre-change document, sorted from the
        // end of the file backwards, so applying them in array order is sound -
        // an earlier-in-file edit never shifts what a later one refers to
        // (the same convention vscode-languageclient forwards verbatim).
        const contentChanges = this.incrementalSync
          ? event.changes.map((change) => ({ range: toLspRange(change.range), text: change.text }))
          : [{ text: model.getValue() }];
        this.client.notify("textDocument/didChange", {
          textDocument: { uri, version: entry.version },
          contentChanges,
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

  private trackProgress(params: unknown): void {
    const { token, value } = (params ?? {}) as { token?: string | number; value?: { kind?: string } };
    if (token === undefined) return;
    if (value?.kind === "begin") {
      this.announcesWork = true;
      this.working.add(String(token));
    }
    if (value?.kind === "end") this.working.delete(String(token));
  }

  /**
   * Waits for the background indexing a server does after a file is opened.
   *
   * Measured 2026-08-23 against typescript-language-server 5.3 on this
   * repository: `references` on a freshly opened file answers **from that file
   * alone** until the project has loaded, and the server says exactly when that
   * is - a work-done progress titled "Initializing JS/TS language features…"
   * whose `end` landed at 2.9 s, one query before the answers began crossing
   * files. Asking before it is not a slow answer, it is a wrong one: an empty
   * list reads as "nothing depends on this", which is the single thing a blast
   * radius must never say by accident.
   *
   * Only for callers that ask about a file the user is not looking at. The
   * editor's own providers must never wait: Monaco asks on every keystroke, and
   * an early hover is worth more than a late one.
   */
  async whenIndexed(): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const waited = Date.now() - startedAt;
      if (this.announcesWork ? this.working.size === 0 : waited >= INDEX_GRACE_MS) return;
      if (waited >= INDEX_DEADLINE_MS) {
        console.warn(`${this.languageId} server is still indexing after ${String(waited)}ms; asking anyway`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, INDEX_POLL_MS));
    }
  }

  private publishDiagnostics(params: unknown): void {
    const { uri, diagnostics } = (params ?? {}) as { uri?: string; diagnostics?: LspDiagnostic[] };
    if (!uri) return;
    const model = monaco.editor.getModels().find((candidate) => pathToUri(modelPath(candidate)) === uri);
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
      textDocument: { uri: pathToUri(modelPath(model)) },
      position: toLspPosition(position),
    };
  }

  async completion(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    context?: monaco.languages.CompletionContext,
  ): Promise<monaco.languages.CompletionList> {
    const answer = await this.client.request<unknown>("textDocument/completion", {
      ...this.documentPosition(model, position),
      // Monaco's trigger kinds are LSP's shifted by one (Invoke 0 → Invoked 1),
      // checked against both declarations. The context is not decoration:
      // measured 2026-08-12 against Roslyn, one member-access position answers
      // 0 items without it and the full member list with it.
      context: {
        triggerKind: (context?.triggerKind ?? monaco.languages.CompletionTriggerKind.Invoke) + 1,
        ...(context?.triggerCharacter === undefined ? {} : { triggerCharacter: context.triggerCharacter }),
      },
    });
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
      textDocument: { uri: pathToUri(modelPath(model)) },
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
      monaco.editor.getModels().map((candidate) => [pathToUri(modelPath(candidate)), candidate]),
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
