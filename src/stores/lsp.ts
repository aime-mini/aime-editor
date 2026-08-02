import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "../lib/monaco";
import { LanguageSession } from "../lib/lsp/session";
import { useWorkspace } from "./workspace";

/** Mirror of the Rust `ServerAvailability` (lsp/mod.rs). */
interface ServerAvailability {
  languageId: string;
  command: string;
  available: boolean;
  installHint: string;
}

export type LanguageState =
  /** No server is defined for this language - nothing to report. */
  | { kind: "unsupported" }
  /** A server exists but is not installed; the hint says how to get it. */
  | { kind: "missing"; command: string; installHint: string }
  | { kind: "starting" }
  | { kind: "running" }
  /** The server refused to start or crashed; `reason` is the CLI's own words. */
  | { kind: "failed"; reason: string };

/** Live sessions by language; the providers below read this map. */
const sessions = new Map<string, LanguageSession>();
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
  if (providersRegistered.has(languageId)) return;
  providersRegistered.add(languageId);
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
  monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: (model, position) => session()?.signatureHelp(model, position) ?? null,
  });
}

interface LspStoreState {
  /** What Aime can say about each language it has been asked about. */
  languages: Record<string, LanguageState | undefined>;
  /** Starts the server for a language if it is installed and not running yet. */
  ensure: (languageId: string) => Promise<void>;
  /** Stops every server (workspace closed or app shutting down). */
  stopAll: () => Promise<void>;
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
          },
        },
      }));
      return;
    }

    set((s) => ({ languages: { ...s.languages, [languageId]: { kind: "starting" } } }));
    try {
      const session = await LanguageSession.start(languageId, rootPath, () => {
        sessions.delete(languageId);
        set((s) => ({
          languages: { ...s.languages, [languageId]: { kind: "failed", reason: "server stopped" } },
        }));
      });
      sessions.set(languageId, session);
      registerProviders(languageId);
      set((s) => ({ languages: { ...s.languages, [languageId]: { kind: "running" } } }));
      // Files opened while the server was starting still need syncing.
      monaco.editor.getModels().forEach((model) => {
        if (model.getLanguageId() === languageId) session.openModel(model);
      });
    } catch (err: unknown) {
      set((s) => ({
        languages: { ...s.languages, [languageId]: { kind: "failed", reason: String(err) } },
      }));
    }
  },

  stopAll: async () => {
    const running = [...sessions.values()];
    sessions.clear();
    set({ languages: {} });
    await Promise.all(running.map((session) => session.dispose()));
  },
}));

/** Every file the user opens asks its language for a server, once. */
monaco.editor.onDidCreateModel((model) => {
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

// Language servers are per workspace: closing or switching projects stops them,
// and the next opened file starts the right ones again.
useWorkspace.subscribe((state, prev) => {
  if (state.rootPath !== prev.rootPath) void useLsp.getState().stopAll();
});
