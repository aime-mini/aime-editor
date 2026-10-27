import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import type { LanguageSession, ProjectOpenMethods } from "../lib/lsp/session";
import { translate } from "../i18n";
import { activeEditor } from "../lib/monacoAccess";
import { useWorkspace } from "./workspace";

/** Mirror of the Rust `ServerAvailability` (lsp/mod.rs). */
interface ServerAvailability {
  languageId: string;
  command: string;
  available: boolean;
  installHint: string;
  /** Whether the program that would run the install is on this machine. */
  installable: boolean;
  /** True when Aime downloads this server itself rather than the user. */
  downloadable: boolean;
  /** The methods this server accepts a project through, when it needs one. */
  projectOpen: ProjectOpenMethods | null;
}

export type LanguageState =
  /** No server is defined for this language - nothing to report. */
  | { kind: "unsupported" }
  /**
   * A server exists but is not installed; the hint says how to get it, and
   * `installable` says whether Aime could run that hint here.
   */
  | { kind: "missing"; command: string; installHint: string; installable: boolean }
  | { kind: "starting" }
  /**
   * `outline` is the server's own answer about `textDocument/documentSymbol`.
   * The editor turns sticky scroll on only for a language that has one, because
   * Monaco's fallback reads indentation and pins bare braces instead.
   */
  | { kind: "running"; outline: boolean }
  /**
   * The server refused to start or crashed; `reason` is the CLI's own words.
   * `command` names the binary that failed, so the offer banner can hand the
   * agent a brief instead of a shrug.
   */
  | { kind: "failed"; reason: string; command: string };

/** Live sessions by language; the providers below read this map. */
const sessions = new Map<string, LanguageSession>();

/**
 * The server serving a language right now, if one is.
 *
 * For the callers that are not Monaco providers - a Task Run asking who
 * depends on the files it is about to change. They must go through `ensure`
 * first; this only answers what is already running.
 */
export function sessionOf(languageId: string): LanguageSession | undefined {
  return sessions.get(languageId);
}

/** Monaco, once the workbench has loaded it; nothing here works without it. */
let editor: typeof Monaco | null = null;
const providersRegistered = new Set<string>();

/** Characters that should re-open the completion list mid-word. */
const TRIGGER_CHARACTERS = [".", ":", ">", "<", '"', "'", "/", "@", "(", ","];

/**
 * A jump's places, each with a model for the peek to show it in
 * (`lib/lsp/locations.ts`). Imported on first use: that module is Monaco's,
 * and this store is on screen before Monaco is.
 */
async function previewed(locations: Monaco.languages.Location[]): Promise<Monaco.languages.Location[]> {
  const { withPreviews } = await import("../lib/lsp/locations");
  return withPreviews(locations);
}

/**
 * How long a jump waits for a server still loading its project. Measured on
 * nopCommerce (40 projects): Roslyn answers `[]` for every symbol
 * for the first ~40 s, then in milliseconds; a solution of hundreds of projects
 * takes minutes.
 */
const JUMP_WAIT_MS = 180_000;

/**
 * A jump - definition, implementation, references - that does not give up on a
 * server that is still getting ready.
 *
 * Asked while the server starts, it waits for it; answered "nowhere" while the
 * server is still loading its project - what Roslyn says about every symbol
 * until it has read the solution - it waits for the load and asks again. Both
 * waits are said at the cursor: a click in that first minute that does nothing
 * at all reads as broken.
 */
async function jump(
  languageId: string,
  model: Monaco.editor.ITextModel,
  position: Monaco.IPosition,
  token: Monaco.CancellationToken,
  ask: (session: LanguageSession) => Promise<Monaco.languages.Location[]>,
): Promise<Monaco.languages.Location[]> {
  const cancelled = () => token.isCancellationRequested;
  let session = sessions.get(languageId);
  if (!session && useLsp.getState().languages[languageId]?.kind === "starting") {
    tellAtCursor(model, position, translate("lsp.jumpWaitsForStart", { language: languageId }));
    session = await startedSession(languageId, token);
  }
  if (!session || cancelled()) return [];
  let locations = await ask(session);
  if (locations.length === 0 && session.loading && !cancelled()) {
    tellAtCursor(model, position, translate("lsp.jumpWaitsForLoad", { language: languageId }));
    if (await session.whenLoaded(JUMP_WAIT_MS, cancelled)) locations = await ask(session);
  }
  return previewed(locations);
}

/** The session of a language whose server is starting, once it has started or failed to. */
function startedSession(
  languageId: string,
  token: Monaco.CancellationToken,
): Promise<LanguageSession | undefined> {
  return new Promise((resolve) => {
    const finish = () => {
      unsubscribe();
      cancellation.dispose();
      resolve(sessions.get(languageId));
    };
    const unsubscribe = useLsp.subscribe((state) => {
      if (state.languages[languageId]?.kind !== "starting") finish();
    });
    const cancellation = token.onCancellationRequested(finish);
  });
}

/** Monaco's own line at the cursor - where it says "No definition found". */
interface MessageController extends Monaco.editor.IEditorContribution {
  showMessage(message: string, position: Monaco.IPosition): void;
}

/** Says something at the cursor of the editor showing `model`, if one is. */
function tellAtCursor(model: Monaco.editor.ITextModel, position: Monaco.IPosition, text: string): void {
  const shown = activeEditor();
  if (shown?.getModel() !== model) return;
  shown.getContribution<MessageController>("editor.contrib.messageController")?.showMessage(text, position);
}

/**
 * Providers are registered once per language and outlive any single session:
 * a server that crashes and restarts must not leave stale providers behind,
 * and Monaco offers no way to unregister cheaply. With no session they answer
 * "nothing", which is exactly how the editor behaves without LSP - except the
 * jumps, which wait for a server that is starting (`jump`).
 */
function registerProviders(languageId: string): void {
  if (providersRegistered.has(languageId) || !editor) return;
  providersRegistered.add(languageId);
  const monaco = editor;
  const session = () => sessions.get(languageId);

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: TRIGGER_CHARACTERS,
    provideCompletionItems: (model, position, context) =>
      session()?.completion(model, position, context) ?? { suggestions: [] },
  });
  monaco.languages.registerHoverProvider(languageId, {
    provideHover: (model, position) => session()?.hover(model, position) ?? null,
  });
  monaco.languages.registerDefinitionProvider(languageId, {
    provideDefinition: (model, position, token) =>
      jump(languageId, model, position, token, (server) => server.definition(model, position)),
  });
  monaco.languages.registerImplementationProvider(languageId, {
    provideImplementation: (model, position, token) =>
      jump(languageId, model, position, token, (server) => server.implementation(model, position)),
  });
  monaco.languages.registerTypeDefinitionProvider(languageId, {
    provideTypeDefinition: (model, position, token) =>
      jump(languageId, model, position, token, (server) => server.typeDefinition(model, position)),
  });
  monaco.languages.registerReferenceProvider(languageId, {
    provideReferences: (model, position, _context, token) =>
      jump(languageId, model, position, token, (server) => server.references(model, position)),
  });
  monaco.languages.registerRenameProvider(languageId, {
    provideRenameEdits: (model, position, newName) =>
      session()?.rename(model, position, newName) ?? { edits: [] },
  });
  monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: (model, position) => session()?.signatureHelp(model, position) ?? null,
  });
  monaco.languages.registerDocumentSymbolProvider(languageId, {
    displayName: "Aime",
    provideDocumentSymbols: (model) => session()?.documentSymbols(model) ?? [],
  });
}

interface LspStoreState {
  /** What Aime can say about each language it has been asked about. */
  languages: Record<string, LanguageState | undefined>;
  /**
   * Languages whose server has Aime fetching packages (`dotnet restore`) right
   * now. A layer over `running`, not a state of its own: the session keeps
   * serving while it restores, and completions are just thin until it is done -
   * which is exactly what the status bar owes the user an explanation for.
   */
  restoring: Record<string, boolean | undefined>;
  /**
   * Languages whose server is still loading its project or indexing - the same
   * kind of layer: it answers, but only for what it has read so far.
   */
  loading: Record<string, boolean | undefined>;
  /** Starts the server for a language if it is installed and not running yet. */
  ensure: (languageId: string) => Promise<void>;
  /** Stops every server (workspace closed or app shutting down). */
  stopAll: () => Promise<void>;
  /** Drops what was learned about a language, so the next file re-probes it. */
  forget: (languageId: string) => void;
}

export const useLsp = create<LspStoreState>((set, get) => ({
  languages: {},
  restoring: {},
  loading: {},

  ensure: async (languageId) => {
    const { rootPath } = useWorkspace.getState();
    const known = get().languages[languageId];
    if (!rootPath || sessions.has(languageId) || known?.kind === "starting") return;
    // A missing server is re-probed only when the workspace changes, so opening
    // twenty files does not run twenty probes.
    if (known && known.kind !== "failed") return;

    // Claimed before the first await: the tabs a workspace reopens with create
    // their models in one go, and each asks for a server. Claimed after it,
    // both got past the check above - measured: two Roslyn servers
    // loading the same solution side by side, one of them at 4.6 GB.
    set((s) => ({ languages: { ...s.languages, [languageId]: { kind: "starting" } } }));
    const availability = await invoke<ServerAvailability | null>("lsp_availability", { languageId }).catch(
      (err: unknown) => {
        // A claim left behind by a failed probe would keep the language from ever starting.
        get().forget(languageId);
        throw err;
      },
    );
    if (!availability) {
      set((s) => ({ languages: { ...s.languages, [languageId]: { kind: "unsupported" } } }));
      return;
    }
    if (!availability.available) {
      set((s) => ({
        languages: {
          ...s.languages,
          [languageId]: {
            kind: "missing",
            command: availability.command,
            installHint: availability.installHint,
            installable: availability.installable,
          },
        },
      }));
      return;
    }

    // Before the server starts, not after: a big project's server takes seconds
    // to come up, and until the providers exist the context menu has no Go to
    // Definition at all. Asked meanwhile, a jump waits for the server (`jump`).
    registerProviders(languageId);
    try {
      // Imported here, not at the top: a language session speaks to Monaco,
      // and the status bar imports this store long before an editor exists.
      const { LanguageSession } = await import("../lib/lsp/session");
      const session = await LanguageSession.start(
        languageId,
        rootPath,
        () => {
          sessions.delete(languageId);
          set((s) => ({
            languages: {
              ...s.languages,
              [languageId]: { kind: "failed", reason: "server stopped", command: availability.command },
            },
          }));
        },
        availability.projectOpen ?? undefined,
      );
      sessions.set(languageId, session);
      session.onRestore = (running) => {
        set((s) => ({ restoring: { ...s.restoring, [languageId]: running } }));
      };
      const showLoading = (loading: boolean) => {
        set((s) => ({ loading: { ...s.loading, [languageId]: loading } }));
      };
      session.onLoading = showLoading;
      showLoading(session.loading);
      set((s) => ({
        languages: {
          ...s.languages,
          [languageId]: { kind: "running", outline: session.providesOutline },
        },
      }));
      // Files opened while the server was starting still need syncing.
      editor?.editor.getModels().forEach((model) => {
        if (model.getLanguageId() === languageId) session.openModel(model);
      });
    } catch (err: unknown) {
      set((s) => ({
        languages: {
          ...s.languages,
          [languageId]: { kind: "failed", reason: String(err), command: availability.command },
        },
      }));
    }
  },

  forget: (languageId) => {
    set((s) => ({
      languages: { ...s.languages, [languageId]: undefined },
      restoring: { ...s.restoring, [languageId]: undefined },
      loading: { ...s.loading, [languageId]: undefined },
    }));
  },

  stopAll: async () => {
    const running = [...sessions.values()];
    sessions.clear();
    set({ languages: {}, restoring: {}, loading: {} });
    await Promise.all(running.map((session) => session.dispose()));
  },
}));

/**
 * Hands the editor to the store, once Monaco exists.
 *
 * The store is imported by the status bar, which is on screen before any
 * editor is - so it must not import Monaco itself. `lib/monaco.ts` calls this
 * the moment it has loaded, and from then on every file the user opens asks
 * its language for a server, once.
 */
export function attachEditor(api: typeof Monaco): void {
  if (editor) return;
  editor = api;
  api.editor.onDidCreateModel((model) => {
    const languageId = model.getLanguageId();
    const session = sessions.get(languageId);
    if (session) {
      session.openModel(model);
      return;
    }
    void useLsp
      .getState()
      .ensure(languageId)
      .then(() => {
        sessions.get(languageId)?.openModel(model);
      });
  });
}

// Language servers are per workspace: closing or switching projects stops them,
// and the next opened file starts the right ones again.
useWorkspace.subscribe((state, prev) => {
  if (state.rootPath !== prev.rootPath) void useLsp.getState().stopAll();
});
