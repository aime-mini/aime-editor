import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { translate } from "../i18n";
import { createEventParser, type EventParser } from "../lib/aiParsers";
import { fingerprint } from "../lib/fingerprint";
import type { Focus } from "../lib/knowledge";
import { memoryFor } from "../lib/knowledgeStore";
import {
  activityAfter,
  appendText,
  withToolCall,
  withToolResult,
  withToolStarted,
  withToolSubject,
} from "../lib/liveTurn";
import { formatProviderError } from "../lib/providerErrors";
import { expectationKey, observe, type ObservedRun, type RanOn } from "../lib/ranOn";
import { effortsOf, type DiscoveredModel } from "../lib/providers";
import { Typewriter } from "../lib/typewriter";
import { useComposer } from "./composer";
import { useWorkspace } from "./workspace";
import {
  addUsage,
  EMPTY_USAGE,
  PERMISSION_ORDER,
  type ApiRetry,
  type BackgroundTask,
  type ChatMessage,
  type Checkpoint,
  type Permission,
  type TokenUsage,
  type TurnActivity,
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
  /** Fingerprint of the project memory the CLI's session was last handed; absent when it has none. */
  memoryIndex?: string;
}

/**
 * What travels with a turn besides the prompt, none of it shown as the
 * user's words: what the editor is showing (`lib/viewContext`), and the files
 * in view, which decide what a large project memory opens on.
 */
export interface TurnContext {
  view?: string | null;
  focus?: Focus;
}

/** A message written while a turn ran, waiting for that turn to end. */
export interface QueuedPrompt {
  id: string;
  text: string;
  context: TurnContext;
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
const OBSERVED_RUNS_KEY = "aime.observedRuns";
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

/** What each provider's last turn ran on, as remembered from earlier sessions. */
function storedObservedRuns(): Record<string, ObservedRun> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OBSERVED_RUNS_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, ObservedRun>) : {};
  } catch (error: unknown) {
    console.warn("the remembered models could not be read:", error);
    return {};
  }
}

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
    interrupted: false,
    memoryIndex: null,
    // What was queued was written for the conversation being left.
    queued: [],
  };
}

/** A session saved while its last turn was still running was closed in the middle of it. */
function endedMidTurn(messages: ChatMessage[]): boolean {
  return messages.at(-1)?.unfinished === true;
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
  /**
   * Fingerprint of the project memory this session's CLI was last handed, or
   * null when it was handed none. The memory index is a few thousand tokens;
   * handed over on every turn of a resumed session it would sit in the
   * history as many times as there were turns, and that is what pushes a
   * long conversation into compaction. So it travels once, and again only
   * when a memory changed or the CLI compacted what it had.
   */
  memoryIndex: string | null;
  /**
   * What the CLI is still running in the background for the live turn. While
   * this is not empty the turn has not ended even if the AI has stopped
   * talking, and this is what the panel shows instead of looking frozen.
   */
  backgroundTasks: BackgroundTask[];
  /** The CLI cannot reach the AI service and is retrying on its own; null otherwise. */
  retrying: ApiRetry | null;
  /** What the live turn is doing right now; null when no turn runs. */
  activity: TurnActivity | null;
  /**
   * Messages written while a turn ran, in the order they were written. They
   * go out together as the next turn once this one ends well; a turn that is
   * stopped or fails hands them back to the composer instead - nothing is
   * sent into a turn the user has just taken control of.
   */
  queued: QueuedPrompt[];
  /**
   * The last turn stopped before it finished - the CLI or the AI service
   * failed, or the app was closed while it ran - so the panel offers to pick
   * it up. A turn the user stopped is not one: that was a decision.
   */
  interrupted: boolean;
  lastError: string | null;
  /** Provider overrides for this session; "" = let the CLI decide. */
  model: string;
  effort: string;
  /** How much the agent may do on its own (ARCHITECTURE.md §4). */
  permission: Permission;
  /**
   * What each provider's last turn ran on, by provider id - what "Auto" picked,
   * read from the CLI itself (`providers/ran_on.rs`). Kept across sessions:
   * Auto picks the same again until the CLI's own settings change.
   */
  observedRuns: Record<string, ObservedRun>;
  /**
   * What each CLI said it would run a choice on before any turn
   * (`providers/next_run.rs`), by `expectationKey`. Asked once per model and
   * folder in each run of Aime, since the CLI's settings may change in between.
   */
  expectedRuns: Record<string, RanOn>;
  /** Asks the current CLI what the current choice would run on, unless it already said. */
  expectNextRun: () => Promise<void>;
  /** Every provider Aime can talk to, including ones from providers.json. */
  providers: ProviderSummary[];
  /** Loads the provider list; called once when the AI panel mounts. */
  loadProviders: () => Promise<void>;
  /** Result of the startup CLI probe; "missing" shows an install banner. */
  providerHealth: "unknown" | "ok" | "missing";
  /**
   * What each installed CLI said it offers (`providers/catalog.rs`), by
   * provider id; a provider not yet asked, or one that keeps no list, is
   * absent and the picker falls back to its table (`lib/providers.ts`).
   */
  modelCatalog: Record<string, DiscoveredModel[]>;
  /** null = the CLI offers no sign-in probe, so nothing may be claimed. */
  signedIn: boolean | null;
  /** Command that signs the user in, run in a terminal on request. */
  loginCommand: string;
  /** Whether an API key is stored in Aime for the current provider. */
  apiKeyConfigured: boolean;
  /** Stores an API key for the current provider; "" clears it. Write-only. */
  setApiKey: (key: string) => Promise<ApiKeyOutcome>;
  checkHealth: () => Promise<void>;
  /** Asks the installed CLI which models it offers right now. */
  loadModels: (providerId: string) => Promise<void>;
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
   * Sends one turn. The context travels with the prompt but is never shown
   * as the user's words; so does the project's memory, which the store adds
   * itself when this session has not been handed the current one yet.
   */
  sendPrompt: (prompt: string, cwd: string, context?: TurnContext) => Promise<void>;
  /** Holds a message written while a turn runs; it is sent when that turn ends well. */
  enqueuePrompt: (text: string, context: TurnContext) => void;
  unqueuePrompt: (id: string) => void;
  cancel: () => Promise<void>;
  /**
   * Picks an interrupted turn up again: the CLI's own session carries on from
   * where it stopped, or - when it never got as far as starting one - the
   * question is simply asked again.
   */
  resumeTurn: (cwd: string) => Promise<void>;
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

/** The turn has ended, one way or another. */
function withoutUnfinished(message: ChatMessage): ChatMessage {
  const ended = { ...message };
  delete ended.unfinished;
  return ended;
}

/**
 * The project's memory index for this turn, or null when the session's CLI
 * already holds the current one - or the project remembers nothing, or the
 * memory could not be read, which costs the turn its memory, never the turn.
 */
async function memoryToHand(root: string, focus: Focus, handed: string | null): Promise<string | null> {
  try {
    const block = await memoryFor(root, focus);
    return block !== null && fingerprint(block) !== handed ? block : null;
  } catch (error: unknown) {
    console.warn("the project's memory could not be read:", error);
    return null;
  }
}

/**
 * The project as it is before a turn, so an unwanted turn is always
 * reversible. Costs nothing when the AI changes nothing, covers every
 * repository the workspace holds, and is null where it holds none - the UI
 * then offers no undo rather than a lie.
 */
async function checkpointBefore(root: string): Promise<Checkpoint | null> {
  try {
    return await invoke<Checkpoint | null>("checkpoint_create", { root });
  } catch (error: unknown) {
    console.warn("no checkpoint for this turn:", error);
    return null;
  }
}

let listenersReady = false;
/** Most recent stderr line of the running turn — appended to exit errors. */
let lastStderrLine = "";
/** Parser of the turn in flight; parsers carry per-run state, so it is rebuilt each turn. */
let activeParser: EventParser = () => [];
/** When the turn in flight was sent; its duration is the wait the user actually had. */
let turnStartedAt = 0;
/**
 * Which turn may still start a CLI. A turn is on screen the moment it is sent
 * and reaches the CLI a moment later; Stop in between bumps this, and the turn
 * that wakes up to a different number knows it was called off.
 */
let turnGeneration = 0;
/** The session's cost before the turn in flight; the CLI only ever reports the running total. */
let costBeforeTurn = 0;
/** What was picked in Aime for the turn in flight; what the CLI ran on is filed under it. */
let choiceThisTurn = { model: "", effort: "" };
/** Fingerprint of the memory index the live turn carries, until the CLI confirms it took the turn. */
let memoryHandedThisTurn: string | null = null;
/** The choices the CLI has been asked about, answered or still answering, by `expectationKey`. */
const askedExpectations = new Set<string>();

/**
 * The turn's own price, from the running total the CLI reports. A session an
 * older Aime saved added that total up turn after turn, so its stored figure
 * can be above what the CLI says; the difference is then no price at all, and
 * none is shown rather than a wrong one - the total itself is corrected.
 */
function turnCost(sessionCostUsd: number | undefined): number | undefined {
  if (sessionCostUsd === undefined) return undefined;
  const cost = sessionCostUsd - costBeforeTurn;
  return cost >= 0 ? cost : undefined;
}

/** What a background task was sent to do, for a subagent whose call this message does not hold. */
function taskLabel(tasks: BackgroundTask[], toolUseId: string): string {
  return tasks.find((task) => task.toolUseId === toolUseId)?.description ?? "";
}
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
    const { providerId, model, effort, sessionUsage, memoryIndex } = get();
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
      memoryIndex: memoryIndex ?? undefined,
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

  /**
   * Files what a turn ran on under its provider, and remembers it for the next session.
   *
   * @param chose what was picked in Aime when that turn ran.
   */
  const noteRanOn = (providerId: string, ranOn: RanOn, chose = choiceThisTurn) => {
    const previous = get().observedRuns[providerId];
    const observedRuns = { ...get().observedRuns, [providerId]: observe(previous, { ranOn, chose }) };
    set({ observedRuns });
    try {
      localStorage.setItem(OBSERVED_RUNS_KEY, JSON.stringify(observedRuns));
    } catch (error: unknown) {
      console.warn("the models a turn ran on could not be remembered:", error);
    }
  };

  /**
   * Reads what the session's last turn ran on out of the CLI's record of it -
   * after a turn, and as soon as a conversation is reopened, so the pickers
   * say what Auto picks before anything is sent (reported 2026-10-18: a fresh
   * window showed a bare "Auto" until a turn had run in it).
   */
  const readRanOn = async (chose = choiceThisTurn) => {
    const { providerId, sessionId } = get();
    if (sessionId === null) return;
    try {
      const ranOn = await invoke<RanOn | null>("provider_ran_on", { providerId, sessionId });
      if (ranOn !== null) noteRanOn(providerId, ranOn, chose);
    } catch (error: unknown) {
      console.warn("what the turn ran on could not be read:", error);
    }
  };

  /** Patches the turn being written. */
  const patchLive = (patch: (message: ChatMessage) => ChatMessage) => {
    set((s) => ({ messages: patchLastAssistant(s.messages, patch) }));
  };

  const applyUiEvent = (ev: UiAiEvent) => {
    // Progress on a call's input is not part of the transcript, so the text
    // already waiting need not be hurried out for it.
    if (ev.kind !== "message-delta" && ev.kind !== "tool-input") revealEverything();
    // Anything the AI says or does means the connection is back.
    if (ev.kind !== "retrying" && ev.kind !== "background" && get().retrying) set({ retrying: null });
    const activity = get().activity;
    if (activity !== null) {
      const next = activityAfter(activity, ev, Date.now());
      if (next !== activity) set({ activity: next });
    }
    switch (ev.kind) {
      case "session-info":
        // The CLI took the turn, memory included: from here the session holds it.
        set({ sessionId: ev.sessionId, memoryIndex: memoryHandedThisTurn ?? get().memoryIndex });
        if (ev.model !== undefined) noteRanOn(get().providerId, { model: ev.model });
        // Saved now, while the turn is still marked unfinished: if the app is
        // closed before the turn ends, this id is what lets it be continued.
        void persist();
        break;
      case "ran-on":
        noteRanOn(get().providerId, { model: ev.model });
        break;
      case "compacted":
        // What the CLI summarised may or may not still hold the index; the
        // next turn hands it over again rather than trusting the summary.
        set({ memoryIndex: null });
        break;
      case "retrying":
        set({ retrying: { attempt: ev.attempt, maxAttempts: ev.maxAttempts } });
        break;
      case "message-delta":
        typewriter.push(ev.text, performance.now());
        scheduleReveal();
        break;
      case "tool-start":
        patchLive((m) => withToolStarted(m, ev.id, ev.name));
        break;
      case "tool-input": {
        const { detail } = ev;
        if (detail !== undefined) patchLive((m) => withToolSubject(m, ev.id, detail));
        break;
      }
      case "tool-call": {
        const label = ev.parentId === undefined ? "" : taskLabel(get().backgroundTasks, ev.parentId);
        patchLive((m) => withToolCall(m, ev, label));
        break;
      }
      case "tool-result":
        patchLive((m) => withToolResult(m, ev.id, ev.failed));
        break;
      case "background":
        set({ backgroundTasks: ev.tasks });
        break;
      case "done":
        // One process can end several answers (a background task finishing
        // starts another), and every one of them reports the running total.
        set((s) => ({
          messages: patchLastAssistant(s.messages, (m) => ({
            ...m,
            costUsd: turnCost(ev.sessionCostUsd) ?? m.costUsd,
            usage: ev.usage ? addUsage(m.usage ?? EMPTY_USAGE, ev.usage) : m.usage,
          })),
          totalCostUsd: ev.sessionCostUsd ?? s.totalCostUsd,
          sessionUsage: ev.usage ? addUsage(s.sessionUsage, ev.usage) : s.sessionUsage,
          sessionId: ev.sessionId ?? s.sessionId,
        }));
        break;
      case "error":
        set({ lastError: ev.message });
        break;
    }
  };

  /** Whatever ended the turn - the CLI exiting or the user stopping it - it ends the same way. */
  const endTurn = () => {
    revealEverything();
    const durationMs = Date.now() - turnStartedAt;
    set((s) => ({
      running: false,
      runId: null,
      backgroundTasks: [],
      retrying: null,
      activity: null,
      messages: patchLastAssistant(s.messages, (m) => ({ ...withoutUnfinished(m), durationMs })),
    }));
  };

  /** Sends what was queued during the turn that just ended well, as one turn. */
  const sendQueued = () => {
    const { queued, projectRoot } = get();
    const last = queued.at(-1);
    if (last === undefined || projectRoot === null) return;
    set({ queued: [] });
    // The editor's view as it was when the last of them was written.
    void get().sendPrompt(queued.map((item) => item.text).join("\n\n"), projectRoot, last.context);
  };

  /** Puts what was queued back where it was written, for a turn that will not carry on by itself. */
  const returnQueued = () => {
    const { queued } = get();
    if (queued.length === 0) return;
    set({ queued: [] });
    useComposer.getState().prepend(queued.map((item) => item.text).join("\n\n"));
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
      endTurn();
      void recordChangedFiles();
      void readRanOn();
      // Only Stop ends a turn without an exit code, and Stop is not listened
      // for here - so anything but 0 is the CLI or the AI service giving up.
      const failed = payload.code !== 0;
      // What the CLI said about it ("API Error: Connection refused …") beats
      // its stderr, which beats a bare exit code.
      if (failed && get().lastError === null) {
        const detail = lastStderrLine ? `\n${lastStderrLine}` : "";
        set({ lastError: translate("ai.exitWithCode", { code: String(payload.code) }) + detail });
      }
      set({ interrupted: failed });
      void persist();
      if (failed) returnQueued();
      else sendQueued();
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
    memoryIndex: null,
    backgroundTasks: [],
    retrying: null,
    activity: null,
    queued: [],
    interrupted: false,
    lastError: null,
    model: "",
    effort: "",
    permission: storedPermission(),
    observedRuns: storedObservedRuns(),
    expectedRuns: {},
    providers: [],
    providerHealth: "unknown",
    modelCatalog: {},
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
        backgroundTasks: [],
        activity: null,
        queued: [],
        // Continue where the project left off, or start clean.
        ...(latest
          ? {
              localId: latest.localId,
              sessionId: latest.sessionId,
              createdAt: latest.createdAt,
              totalCostUsd: latest.totalCostUsd,
              messages: latest.messages,
              interrupted: endedMidTurn(latest.messages),
              providerId,
              model: latest.model ?? "",
              effort: latest.effort ?? "",
              sessionUsage: latest.usage ?? EMPTY_USAGE,
              memoryIndex: latest.memoryIndex ?? null,
            }
          : { ...freshSessionIdentity(), createdAt: Date.now(), providerId, model: "", effort: "" }),
      });
      void readRanOn({ model: get().model, effort: get().effort });
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
        // The CLI is there: it is the one source of what it can run today.
        if (health.installed) void get().loadModels(probed);
      } catch (err: unknown) {
        console.error("provider health check failed:", err);
      }
    },

    expectNextRun: async () => {
      const { providerId, projectRoot, model } = get();
      if (projectRoot === null) return;
      const key = expectationKey(providerId, projectRoot, model);
      if (askedExpectations.has(key)) return;
      askedExpectations.add(key);
      try {
        const ranOn = await invoke<RanOn | null>("provider_next_run", {
          providerId,
          model,
          cwd: projectRoot,
        });
        if (ranOn !== null) set((s) => ({ expectedRuns: { ...s.expectedRuns, [key]: ranOn } }));
      } catch (error: unknown) {
        // Not asked, then: the next time this choice comes round asks again.
        askedExpectations.delete(key);
        console.warn(`${providerId} could not say what it would run on:`, error);
      }
    },

    loadModels: async (providerId) => {
      try {
        const models = await invoke<DiscoveredModel[]>("provider_models", { providerId });
        set((s) => ({ modelCatalog: { ...s.modelCatalog, [providerId]: models } }));
      } catch (err: unknown) {
        // The picker keeps its fallback table; the log says why the CLI could not be read.
        console.warn(`the models of ${providerId} could not be read:`, err);
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
        backgroundTasks: [],
        activity: null,
      });
    },

    sendPrompt: async (prompt, cwd, context = {}) => {
      if (get().running) return;
      const generation = ++turnGeneration;
      lastStderrLine = "";
      turnStartedAt = Date.now();
      costBeforeTurn = get().totalCostUsd;
      choiceThisTurn = { model: get().model, effort: get().effort };
      // On screen before anything is awaited: the checkpoint and the memory
      // below take a moment on a large project, and a message that appears
      // that moment after Enter reads as a slow app (reported 2026-10-16).
      set((s) => ({
        lastError: null,
        running: true,
        backgroundTasks: [],
        interrupted: false,
        activity: { kind: "waiting", since: turnStartedAt },
        messages: [
          ...s.messages,
          { role: "user", parts: [{ kind: "text", text: prompt }] },
          { role: "assistant", parts: [], unfinished: true },
        ],
      }));
      await ensureListeners();
      const [memory, checkpoint] = await Promise.all([
        memoryToHand(cwd, context.focus ?? [], get().memoryIndex),
        checkpointBefore(cwd),
      ]);
      if (generation !== turnGeneration) return;
      memoryHandedThisTurn = memory === null ? null : fingerprint(memory);
      if (checkpoint !== null) patchLive((m) => ({ ...m, checkpoint }));

      const provider = get().providers.find((candidate) => candidate.id === get().providerId);
      activeParser = createEventParser({
        id: get().providerId,
        parser: provider?.parser,
        textField: provider?.textField,
      });
      try {
        const runId = await invoke<string>("ai_send_prompt", {
          providerId: get().providerId,
          prompt: [context.view, memory, prompt].filter(Boolean).join("\n\n"),
          cwd,
          sessionId: get().sessionId,
          options: {
            model: get().model || null,
            effort: get().effort || null,
            permission: get().permission,
          },
        });
        // Stopped while the CLI was starting: there was no run to stop yet.
        if (generation !== turnGeneration) await invoke("ai_cancel", { runId });
        else set({ runId });
      } catch (e) {
        if (generation !== turnGeneration) return;
        set((s) => ({
          running: false,
          activity: null,
          lastError: formatProviderError(e),
          messages: patchLastAssistant(s.messages, withoutUnfinished),
        }));
        returnQueued();
        void persist();
      }
    },

    enqueuePrompt: (text, context) => {
      set((s) => ({ queued: [...s.queued, { id: crypto.randomUUID(), text, context }] }));
    },

    unqueuePrompt: (id) => {
      set((s) => ({ queued: s.queued.filter((item) => item.id !== id) }));
    },

    resumeTurn: async (cwd) => {
      const { sessionId, messages, running } = get();
      if (running) return;
      if (sessionId !== null) {
        // The cut-off turn is being dealt with; it must not offer itself again.
        set({ messages: patchLastAssistant(messages, withoutUnfinished) });
        await get().sendPrompt(translate("ai.continuePrompt"), cwd);
        return;
      }
      // No session means nothing reached the CLI's memory: the failed turn is
      // replaced by the same question, asked again.
      const questionAt = messages.map((m) => m.role).lastIndexOf("user");
      const question = messages.at(questionAt)?.parts.find((part) => part.kind === "text");
      if (questionAt === -1 || question?.kind !== "text") return;
      set({ messages: messages.slice(0, questionAt) });
      await get().sendPrompt(question.text, cwd);
    },

    cancel: async () => {
      const { runId } = get();
      turnGeneration++;
      endTurn();
      returnQueued();
      void persist();
      if (runId) await invoke("ai_cancel", { runId });
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
      returnQueued();
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
        interrupted: endedMidTurn(target.messages),
        providerId: target.providerId ?? DEFAULT_PROVIDER,
        model: target.model ?? "",
        effort: target.effort ?? "",
        sessionUsage: target.usage ?? EMPTY_USAGE,
        memoryIndex: target.memoryIndex ?? null,
        lastError: null,
      });
      void readRanOn({ model: get().model, effort: get().effort });
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
