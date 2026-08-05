import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import type { LanguageSession, ProjectOpenMethods } from "../lib/lsp/session";
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
  /** The server refused to start or crashed; `reason` is the CLI's own words. */
  | { kind: "failed"; reason: string };

/** Live sessions by language; the providers below read this map. */
const sessions = new Map<string, LanguageSession>();

/** Monaco, once the workbench has loaded it; nothing here works without it. */
let editor: typeof Monaco | null = null;
const providersRegistered = new Set<string>();

/** Characters that should re-open the completion list mid-word. */
const TRIGGER_CHARACTERS = [".", ":", ">", "<", '"', "'", "/", "@", "(", ","];

/**
 * Providers are registered once per language and outlive any single session:
 * a server that crashes and restarts must not leave stale providers behind,
 * and Monaco offers no way to unregister cheaply. With no session they simply
 * answer "nothing", which is exactly how the editor behaves without LSP.
 */
function registerProviders(languageId: string): void {
  if (providersRegistered.has(languageId) || !editor) return;
  providersRegistered.add(languageId);
  const monaco = editor;
  const session = () => sessions.get(languageId);

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: TRIGGER_CHARACTERS,
    provideCompletionItems: (model, position) =>
      session()?.completion(model, position) ?? { suggestions: [] },
  });
  monaco.languages.registerHoverProvider(languageId, {
    provideHover: (model, position) => session()?.hover(model, position) ?? null,
  });
  monaco.languages.registerDefinitionProvider(languageId, {
    provideDefinition: (model, position) => session()?.definition(model, position) ?? null,
  });
  monaco.languages.registerReferenceProvider(languageId, {
    provideReferences: (model, position) => session()?.references(model, position) ?? [],
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
  /** Starts the server for a language if it is installed and not running yet. */
  ensure: (languageId: string) => Promise<void>;
  /** Stops every server (workspace closed or app shutting down). */
  stopAll: () => Promise<void>;
  /** Drops what was learned about a language, so the next file re-probes it. */
  forget: (languageId: string) => void;
}

export const useLsp = create<LspStoreState>((set, get) => ({
  languages: {},

  ensure: async (languageId) => {
    const { rootPath } = useWorkspace.getState();
    const known = get().languages[languageId];
    if (!rootPath || sessions.has(languageId) || known?.kind === "starting") return;
    // A missing server is re-probed only when the workspace changes, so opening
    // twenty files does not run twenty probes.
    if (known && known.kind !== "failed") return;

    const availability = await invoke<ServerAvailability | null>("lsp_availability", { languageId });
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

    set((s) => ({ languages: { ...s.languages, [languageId]: { kind: "starting" } } }));
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
            languages: { ...s.languages, [languageId]: { kind: "failed", reason: "server stopped" } },
          }));
        },
        availability.projectOpen ?? undefined,
      );
      sessions.set(languageId, session);
      registerProviders(languageId);
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
        languages: { ...s.languages, [languageId]: { kind: "failed", reason: String(err) } },
      }));
    }
  },

  forget: (languageId) => {
    set((s) => ({ languages: { ...s.languages, [languageId]: undefined } }));
  },

  stopAll: async () => {
    const running = [...sessions.values()];
    sessions.clear();
    set({ languages: {} });
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
