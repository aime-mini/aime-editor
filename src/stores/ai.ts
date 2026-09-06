import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { translate } from "../i18n";
import { createEventParser, type EventParser } from "../lib/aiParsers";
import { formatProviderError } from "../lib/providerErrors";
import { effortsOf } from "../lib/providers";
import { Typewriter } from "../lib/typewriter";
import { useWorkspace } from "./workspace";
import {
  addUsage,
  EMPTY_USAGE,
  PERMISSION_ORDER,
  type ChatMessage,
  type Checkpoint,
  type Permission,
  type TokenUsage,
  type UiAiEvent,
} from "../lib/types";

interface StreamPayload {
  run_id: string;
  event: unknown;
}

interface ExitPayload {
  run_id: string;
  code: number | null;
}

/** Mirror of the Rust `ProviderSummary` (providers/mod.rs). */
export interface ProviderSummary {
  id: string;
  displayName: string;
  builtIn: boolean;
  installCommand: string;
  parser: string;
  textField: string;
  /** How this CLI takes an API key; null = it takes none, so no key field. */
  apiKeyRoute: ApiKeyRoute | null;
}

/**
 * The two doors a CLI opens for an API key (Rust `ApiKeyRoute`).
 *
 * `env`: Aime keeps the key and passes it to its own runs — the CLI's own login
 * is untouched. `cliLogin`: the CLI stores the key itself, so Aime hands it over
 * once and keeps nothing — and that **replaces** whatever that CLI was signed in
 * with, which is why the UI warns first.
 */
export type ApiKeyRoute = { kind: "env"; variable: string } | { kind: "cliLogin"; args: string[] };

/** What Aime could confirm about a key it just accepted (Rust `ApiKeyOutcome`). */
export interface ApiKeyOutcome {
  /** null = this CLI reports nothing about keys, so nothing is claimed. */
  cliConfirmed: boolean | null;
}

/** Mirror of the Rust `ProviderHealth` (providers/mod.rs). */
interface ProviderHealth {
  installed: boolean;
  version: string | null;
  signedIn: boolean | null;
  loginCommand: string;
  /** An API key is configured in Aime for this provider. */
  apiKey: boolean;
}

/** One chat session, persisted per project (schema is owned here, Rust just stores JSON). */
export interface StoredSession {
  /** App-side identity — exists before the CLI assigns its own session id. */
  localId: string;
  /** Provider session id; lets the CLI resume its full context across app restarts. */
  sessionId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  totalCostUsd: number;
  messages: ChatMessage[];
  /** AI CLI that owns `sessionId` — resume ids are not portable across CLIs. */
  providerId?: string;
  /** Provider overrides chosen for this session ("" = provider default). */
  model?: string;
  effort?: string;
  usage?: TokenUsage;
}

interface SessionFile {
  version: 1;
  sessions: StoredSession[];
}

const MAX_SESSIONS_PER_PROJECT = 20;
const TITLE_MAX_CHARS = 60;
const PERMISSION_KEY = "aime.permission";
/** Key of the boolean this setting replaced; read once, to keep the old choice. */
const LEGACY_AUTO_APPROVE_KEY = "aime.autoApprove";
const PROVIDER_KEY = "aime.provider";
const DEFAULT_PROVIDER = "claude";

/** The CLI the user last picked. Their choice outlives any one conversation. */
function preferredProvider(): string {
  return localStorage.getItem(PROVIDER_KEY) ?? DEFAULT_PROVIDER;
}

/**
 * The conversation to reopen when a project is opened, if any.
 *
 * A conversation cannot change CLI half way - the resume id belongs to the
 * one that made it - so only the newest conversation of the chosen provider
 * is continued. Picking Claude and finding Codex selected on the next launch
 * was this, before: the user's pick was only stored, never allowed to win.
 * The other conversations stay in the history list, and opening one from
 * there switches the provider back with it.
 */
export function sessionToResume<T extends { providerId?: string }>(
  stored: readonly T[],
  preferred: string,
): T | undefined {
  return stored.find((session) => (session.providerId ?? DEFAULT_PROVIDER) === preferred);
}
/** Sign-in happens in a terminal/browser, so the state is polled back in. */
const SIGN_IN_POLL_MS = 2_500;
const SIGN_IN_POLL_TIMEOUT_MS = 5 * 60_000;

/** Reads the saved level, adopting the choice made under the old boolean setting. */
function storedPermission(): Permission {
  const stored = localStorage.getItem(PERMISSION_KEY);
  if (stored && PERMISSION_ORDER.includes(stored as Permission)) return stored as Permission;
  return localStorage.getItem(LEGACY_AUTO_APPROVE_KEY) === "false" ? "edits" : "full";
}

function freshSessionIdentity() {
  return {
    localId: crypto.randomUUID(),
    sessionId: null,
    totalCostUsd: 0,
    messages: [],
    sessionUsage: EMPTY_USAGE,
  };
}

function titleOf(messages: ChatMessage[]): string {
  const firstUserText = messages.find((m) => m.role === "user")?.parts.find((p) => p.kind === "text");
  const title = firstUserText?.kind === "text" ? firstUserText.text.trim() : "";
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS)}…` : title || "—";
}

function isSessionFile(value: unknown): value is SessionFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; sessions?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.sessions);
}

interface AiState {
  providerId: string;
  messages: ChatMessage[];
  running: boolean;
  runId: string | null;
  /** Provider session id of the live session (drives `--resume`). */
  sessionId: string | null;
  localId: string;
  createdAt: number;
  totalCostUsd: number;
  lastError: string | null;
  /** Provider overrides for this session; "" = let the CLI decide. */
  model: string;
  effort: string;
  /** How much the agent may do on its own (ARCHITECTURE.md §4). */
  permission: Permission;
  /** Every provider Aime can talk to, including ones from providers.json. */
  providers: ProviderSummary[];
  /** Loads the provider list; called once when the AI panel mounts. */
  loadProviders: () => Promise<void>;
  /** Result of the startup CLI probe; "missing" shows an install banner. */
  providerHealth: "unknown" | "ok" | "missing";
  /** null = the CLI offers no sign-in probe, so nothing may be claimed. */
  signedIn: boolean | null;
  /** Command that signs the user in, run in a terminal on request. */
  loginCommand: string;
  /** Whether an API key is stored in Aime for the current provider. */
  apiKeyConfigured: boolean;
  /** Stores an API key for the current provider; "" clears it. Write-only. */
  setApiKey: (key: string) => Promise<ApiKeyOutcome>;
  checkHealth: () => Promise<void>;
  /** Re-probes until the sign-in the user just started lands (or times out). */
  watchSignIn: () => void;
  /** Token totals across the live session's turns. */
  sessionUsage: TokenUsage;
  /** Saved sessions of the current project, most recent first (includes the live one). */
  history: StoredSession[];
  /** Workspace the store is currently bound to (persistence key). */
  projectRoot: string | null;

  /** Binds the store to a workspace: flushes the previous one, restores the latest session. */
  hydrate: (rootPath: string) => Promise<void>;
  /** Unbinds from the workspace (folder closed): flushes, then resets to a clean slate. */
  closeProject: () => void;
  /**
   * Sends one turn. `context` - what the editor is showing, see `lib/viewContext` -
   * travels with the prompt but is never shown as the user's words.
   */
  sendPrompt: (prompt: string, cwd: string, context?: string | null) => Promise<void>;
  cancel: () => Promise<void>;
  /** Puts the project back to how it was before that turn. */
  undoTurn: (messageIndex: number) => Promise<void>;
  newSession: () => void;
  resumeSession: (localId: string) => void;
  /** Switching CLI starts a new session — resume ids belong to one provider. */
  setProvider: (providerId: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
  cyclePermission: () => void;
}

/** Patches the last assistant message (the one currently streaming). */
function patchLastAssistant(
  messages: ChatMessage[],
  patch: (last: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  return [...messages.slice(0, -1), patch(last)];
}

function appendText(message: ChatMessage, text: string): ChatMessage {
  const lastPart = message.parts.at(-1);
  const parts =
    lastPart?.kind === "text"
      ? [...message.parts.slice(0, -1), { kind: "text" as const, text: lastPart.text + text }]
      : [...message.parts, { kind: "text" as const, text }];
  return { ...message, parts };
}

let listenersReady = false;
/** Most recent stderr line of the running turn — appended to exit errors. */
let lastStderrLine = "";
/** Parser of the turn in flight; parsers carry per-run state, so it is rebuilt each turn. */
let activeParser: EventParser = () => [];
/** Streamed text waiting to be shown, and the frame that will show the next of it. */
const typewriter = new Typewriter();
let revealHandle: number | null = null;
/** Interval id of the sign-in watcher; at most one runs at a time. */
let signInPollId: number | null = null;
/** Whether the `providers.json` listener is up; it is registered once. */
let providersWatched = false;

function stopSignInWatch(): void {
  if (signInPollId !== null) {
    window.clearInterval(signInPollId);
    signInPollId = null;
  }
}

export const useAi = create<AiState>((set, get) => {
  /** Upserts the live session into history and writes the project's session file. */
  const persist = async () => {
    const { projectRoot, messages, localId, sessionId, createdAt, totalCostUsd, history } = get();
    const { providerId, model, effort, sessionUsage } = get();
    if (!projectRoot || messages.length === 0) return;
    const live: StoredSession = {
      localId,
      sessionId,
      title: titleOf(messages),
      createdAt,
      updatedAt: Date.now(),
      totalCostUsd,
      messages,
      providerId,
      model,
      effort,
      usage: sessionUsage,
    };
    const merged = [live, ...history.filter((s) => s.localId !== localId)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS_PER_PROJECT);
    set({ history: merged });
    const file: SessionFile = { version: 1, sessions: merged };
    try {
      await invoke("save_ai_sessions", { rootPath: projectRoot, sessions: file });
    } catch (err: unknown) {
      console.error("failed to save AI sessions:", err);
    }
  };

  /**
   * After a turn, records which files it touched. This is what turns "the AI
   * did something" into a sentence a person can act on - and it is measured
   * from the project itself, not from what the AI claims to have done.
   */
  const recordChangedFiles = async () => {
    const { projectRoot, messages } = get();
    const last = messages.at(-1);
    if (!projectRoot || last?.role !== "assistant" || !last.checkpoint) return;
    try {
      const changedFiles = await invoke<string[]>("checkpoint_diff", {
        root: projectRoot,
        checkpoint: last.checkpoint,
      });
      set((s) => ({ messages: patchLastAssistant(s.messages, (m) => ({ ...m, changedFiles })) }));
      void persist();
    } catch (err: unknown) {
      console.warn("could not tell what the turn changed:", err);
    }
  };

  const showText = (text: string) => {
    if (text === "") return;
    set((s) => ({ messages: patchLastAssistant(s.messages, (m) => appendText(m, text)) }));
  };

  /**
   * Text streams in chunks (see `lib/typewriter`); one frame at a time it is
   * moved onto the screen at the pace it arrives. Anything that is not text -
   * a tool chip, the end of the turn - first shows every character still
   * waiting, so the transcript keeps the CLI's own order.
   */
  const revealFrame = () => {
    revealHandle = null;
    showText(typewriter.take(performance.now()));
    if (typewriter.pending) scheduleReveal();
  };
  const scheduleReveal = () => {
    revealHandle ??= requestAnimationFrame(revealFrame);
  };
  const revealEverything = () => {
    if (revealHandle !== null) cancelAnimationFrame(revealHandle);
    revealHandle = null;
    showText(typewriter.flush());
  };

  const applyUiEvent = (ev: UiAiEvent) => {
    if (ev.kind !== "message-delta") revealEverything();
    switch (ev.kind) {
      case "session-info":
        set({ sessionId: ev.sessionId });
        break;
      case "message-delta":
        typewriter.push(ev.text, performance.now());
        scheduleReveal();
        break;
      case "tool-call":
        set((s) => ({
          messages: patchLastAssistant(s.messages, (m) => ({
            ...m,
            parts: [...m.parts, { kind: "tool", name: ev.name, detail: ev.detail }],
          })),
        }));
        break;
      case "done":
        set((s) => ({
          messages: patchLastAssistant(s.messages, (m) => ({
            ...m,
            costUsd: ev.costUsd,
            durationMs: ev.durationMs,
            usage: ev.usage,
          })),
          totalCostUsd: s.totalCostUsd + (ev.costUsd ?? 0),
          sessionUsage: ev.usage ? addUsage(s.sessionUsage, ev.usage) : s.sessionUsage,
          sessionId: ev.sessionId ?? s.sessionId,
        }));
        break;
      case "error":
        set({ lastError: ev.message });
        break;
    }
  };

  const ensureListeners = async () => {
    if (listenersReady) return;
    listenersReady = true;
    await listen<StreamPayload>("ai:stream", ({ payload }) => {
      if (payload.run_id !== get().runId) return;
      activeParser(payload.event).forEach(applyUiEvent);
    });
    await listen<ExitPayload>("ai:exit", ({ payload }) => {
      if (payload.run_id !== get().runId) return;
      revealEverything();
      set({ running: false, runId: null });
      void recordChangedFiles();
      if (payload.code !== null && payload.code !== 0) {
        // The CLI's own stderr (e.g. "please log in") beats a bare exit code.
        const detail = lastStderrLine ? `\n${lastStderrLine}` : "";
        set({ lastError: translate("ai.exitWithCode", { code: payload.code }) + detail });
      }
      void persist();
    });
    await listen<StreamPayload>("ai:stderr", ({ payload }) => {
      if (typeof payload.event === "string" && payload.event.trim()) {
        lastStderrLine = payload.event.trim();
      }
      console.warn("[ai stderr]", payload.event);
    });
  };

  return {
    providerId: preferredProvider(),
    messages: [],
    running: false,
    runId: null,
    sessionId: null,
    localId: crypto.randomUUID(),
    createdAt: Date.now(),
    totalCostUsd: 0,
    lastError: null,
    model: "",
    effort: "",
    permission: storedPermission(),
    providers: [],
    providerHealth: "unknown",
    signedIn: null,
    loginCommand: "",
    apiKeyConfigured: false,
    sessionUsage: EMPTY_USAGE,
    history: [],
    projectRoot: null,

    hydrate: async (rootPath) => {
      if (get().projectRoot === rootPath) return;
      await persist(); // flush the previous project's live session
      let stored: StoredSession[] = [];
      try {
        const value = await invoke<unknown>("load_ai_sessions", { rootPath });
        if (isSessionFile(value)) stored = value.sessions;
      } catch (err: unknown) {
        console.error("failed to load AI sessions:", err);
      }
      const providerId = preferredProvider();
      const latest = sessionToResume(stored, providerId);
      set({
        projectRoot: rootPath,
        history: stored,
        lastError: null,
        running: false,
        runId: null,
        // Continue where the project left off, or start clean.
        ...(latest
          ? {
              localId: latest.localId,
              sessionId: latest.sessionId,
              createdAt: latest.createdAt,
              totalCostUsd: latest.totalCostUsd,
              messages: latest.messages,
              providerId,
              model: latest.model ?? "",
              effort: latest.effort ?? "",
              sessionUsage: latest.usage ?? EMPTY_USAGE,
            }
          : { ...freshSessionIdentity(), createdAt: Date.now(), providerId, model: "", effort: "" }),
      });
    },

    loadProviders: async () => {
      try {
        set({ providers: await invoke<ProviderSummary[]>("list_providers") });
      } catch (err: unknown) {
        console.error("failed to list providers:", err);
      }
      // Rust re-reads providers.json whenever it changes and says so; picking
      // that up here is what lets a newly configured CLI appear in the picker
      // without a restart. Registered on the first load and kept for the
      // session - there is exactly one provider list to keep fresh.
      if (providersWatched) return;
      providersWatched = true;
      await listen("providers:changed", () => {
        void get().loadProviders();
      });
    },

    checkHealth: async () => {
      const probed = get().providerId;
      try {
        const health = await invoke<ProviderHealth>("provider_health", { providerId: probed });
        // The user may have switched provider while the probe was in flight.
        if (get().providerId !== probed) return;
        set({
          providerHealth: health.installed ? "ok" : "missing",
          signedIn: health.signedIn,
          loginCommand: health.loginCommand,
          apiKeyConfigured: health.apiKey,
        });
        if (health.signedIn === true) stopSignInWatch();
      } catch (err: unknown) {
        console.error("provider health check failed:", err);
      }
    },

    watchSignIn: () => {
      stopSignInWatch();
      const startedAt = Date.now();
      signInPollId = window.setInterval(() => {
        // Give up quietly if the user abandoned the sign-in — the probe is
        // cheap, but nothing should poll forever in the background.
        if (Date.now() - startedAt > SIGN_IN_POLL_TIMEOUT_MS) {
          stopSignInWatch();
          return;
        }
        void get().checkHealth();
      }, SIGN_IN_POLL_MS);
    },

    closeProject: () => {
      void persist();
      set({
        ...freshSessionIdentity(),
        createdAt: Date.now(),
        projectRoot: null,
        history: [],
        lastError: null,
        running: false,
        runId: null,
      });
    },

    sendPrompt: async (prompt, cwd, context = null) => {
      await ensureListeners();
      lastStderrLine = "";
      const provider = get().providers.find((candidate) => candidate.id === get().providerId);
      // Taken before the CLI runs, so an unwanted turn is always reversible.
      // Costs nothing when the AI changes nothing, and is skipped outside a
      // git repository, where the UI then offers no undo rather than a lie.
      let checkpoint: Checkpoint | null = null;
      try {
        checkpoint = await invoke<Checkpoint | null>("checkpoint_create", { root: cwd });
      } catch (err: unknown) {
        console.warn("no checkpoint for this turn:", err);
      }

      activeParser = createEventParser({
        id: get().providerId,
        parser: provider?.parser,
        textField: provider?.textField,
      });
      set((s) => ({
        lastError: null,
        running: true,
        messages: [
          ...s.messages,
          { role: "user", parts: [{ kind: "text", text: prompt }] },
          { role: "assistant", parts: [], checkpoint: checkpoint ?? undefined },
        ],
      }));
      try {
        const runId = await invoke<string>("ai_send_prompt", {
          providerId: get().providerId,
          prompt: context === null ? prompt : `${context}\n\n${prompt}`,
          cwd,
          sessionId: get().sessionId,
          options: {
            model: get().model || null,
            effort: get().effort || null,
            permission: get().permission,
          },
        });
        set({ runId });
      } catch (e) {
        set({ running: false, lastError: formatProviderError(e) });
        void persist();
      }
    },

    cancel: async () => {
      const { runId } = get();
      if (runId) await invoke("ai_cancel", { runId });
      revealEverything();
      set({ running: false, runId: null });
      void persist();
    },

    undoTurn: async (messageIndex) => {
      const { projectRoot, messages } = get();
      const target = messages[messageIndex];
      if (!projectRoot || !target.checkpoint) return;
      set({ lastError: null });
      try {
        await invoke<number>("checkpoint_restore", {
          root: projectRoot,
          checkpoint: target.checkpoint,
        });
        set((s) => ({
          messages: s.messages.map((message, index) =>
            index === messageIndex ? { ...message, undone: true } : message,
          ),
        }));
        // The tree, the editor and the Git panel all read from disk.
        useWorkspace.getState().refreshTree();
        void persist();
      } catch (err: unknown) {
        set({ lastError: String(err) });
      }
    },

    newSession: () => {
      void persist();
      set({ ...freshSessionIdentity(), createdAt: Date.now(), lastError: null });
    },

    resumeSession: (localId) => {
      const { running, history } = get();
      if (running) return;
      const target = history.find((s) => s.localId === localId);
      if (!target) return;
      void persist();
      set({
        localId: target.localId,
        sessionId: target.sessionId,
        createdAt: target.createdAt,
        totalCostUsd: target.totalCostUsd,
        messages: target.messages,
        providerId: target.providerId ?? DEFAULT_PROVIDER,
        model: target.model ?? "",
        effort: target.effort ?? "",
        sessionUsage: target.usage ?? EMPTY_USAGE,
        lastError: null,
      });
    },

    setProvider: (providerId) => {
      if (get().providerId === providerId || get().running) return;
      localStorage.setItem(PROVIDER_KEY, providerId);
      stopSignInWatch(); // the watcher belonged to the previous CLI
      void persist();
      // Model/effort names and the resume id belong to the previous CLI.
      set({
        ...freshSessionIdentity(),
        createdAt: Date.now(),
        providerId,
        model: "",
        effort: "",
        lastError: null,
        providerHealth: "unknown",
        signedIn: null,
        apiKeyConfigured: false,
      });
    },

    setApiKey: async (key) => {
      const providerId = get().providerId;
      // The key goes straight to Rust and never into this store: the health
      // re-probe is what tells the UI a key now exists (or no longer does).
      const outcome = await invoke<ApiKeyOutcome>("provider_set_api_key", { providerId, key });
      await get().checkHealth();
      return outcome;
    },

    setModel: (model) => {
      // Effort levels are per model — drop one the new model cannot accept.
      const supported = effortsOf(get().providerId, model);
      const effort = supported.some((o) => o.value === get().effort) ? get().effort : "";
      set({ model, effort });
    },

    setEffort: (effort) => {
      set({ effort });
    },

    cyclePermission: () => {
      const next =
        PERMISSION_ORDER[(PERMISSION_ORDER.indexOf(get().permission) + 1) % PERMISSION_ORDER.length];
      localStorage.setItem(PERMISSION_KEY, next);
      set({ permission: next });
    },
  };
});
