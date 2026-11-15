import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAi } from "../stores/ai";
import { createEventParser } from "./aiParsers";
import { troubleIn, type TurnTrouble } from "./turnTrouble";

/**
 * One turn of the AI CLI run as an agent - with tools, in a folder - outside
 * the user's conversation, awaited to its exit.
 *
 * Shared by the task run and the cloud deploy, which both start the CLI on the
 * user's behalf and must never join the chat session. The
 * three things that make such a turn correct live here once: listening before
 * spawning, attributing events only after the run id is known, and reporting
 * the exit code the backend actually sent.
 */

/** How freely the CLI's tools act; mirrors the Rust `Permission`. */
export type TurnPermission = "readOnly" | "edits" | "full";

/**
 * Which tools the CLI has at all; mirrors the Rust `ToolSet`.
 *
 * `filesOnly` is a real constraint at the CLI - Claude Code's `--tools`, Codex's
 * sandbox with the network closed - for a turn that must not reach a shell or a
 * cloud however it is prompted. Measured: plan mode alone still runs
 * commands, so `readOnly` does not give this.
 */
export type TurnTools = "everything" | "filesOnly";

export interface AgentTurnOptions {
  prompt: string;
  cwd: string;
  permission: TurnPermission;
  tools?: TurnTools;
  /**
   * A model other than the user's choice, such as the provider's light model
   * for reading Aime does on its own. The user's effort level belongs to the
   * user's model, so a turn on another one runs at that model's default.
   */
  model?: string;
  /** A tool the CLI called, as one line for a log. */
  onToolCall?: (line: string) => void;
  /** A line the CLI wrote to stderr. */
  onStderr?: (line: string) => void;
  /** The run id, the moment the CLI is spawned - what a cancel needs. */
  onStarted?: (runId: string) => void;
  /**
   * A JSON Schema the answer must match. The CLI enforces it where it can
   * (Claude Code, Codex); the text that comes back is the JSON.
   */
  schema?: unknown;
  /**
   * A session this caller's own earlier turn opened, to carry on in it - never
   * the user's chat. The CLI then still holds what it read and wrote; absent,
   * the turn starts with nothing.
   */
  sessionId?: string | null;
}

export interface AgentTurnOutcome {
  /** The CLI's exit code, or null when it was cancelled. */
  code: number | null;
  /** What the agent said: the final result when the CLI reports one, else the streamed text. */
  text: string;
  /** What the turn cost, as the CLI reported it; null when it did not say. */
  costUsd: number | null;
  /** The last lines the CLI wrote to stderr: where it says why it gave up. */
  stderr: string;
  /** The errors the CLI reported in its own stream - Codex says why it gave up there, not on stderr. */
  errors: string;
  /**
   * The session the turn ran in, for a later turn to carry on; null for a CLI
   * that reports none, whose every turn then starts fresh.
   */
  sessionId: string | null;
}

/** How many stderr lines a turn keeps for explaining a failure. */
const STDERR_LINES_KEPT = 20;
/** How much of a CLI's own words a failure carries. */
const REASON_CHARS = 300;

/**
 * Why a turn that exited non-zero gave up, in the CLI's own words: its last
 * error line, else the last thing it said - "Please run /login", a usage
 * limit - so a failed step says what to do instead of only an exit code.
 */
export function failureOf(outcome: AgentTurnOutcome): string {
  const lastLine = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? "";
  const reason = lastLine(outcome.errors) || lastLine(outcome.stderr) || lastLine(outcome.text);
  const code = `the AI CLI exited with ${String(outcome.code)}`;
  return reason === "" ? code : `${code}: ${reason.slice(0, REASON_CHARS)}`;
}

/**
 * How long to wait before each new try at an AI service that could not be
 * reached: about seventeen minutes in all - long enough for a dropped
 * connection or a busy service to come back, short enough that nobody's work
 * sits on a dead network all night.
 */
export const UNREACHABLE_WAITS_MS = [30_000, 120_000, 300_000, 600_000];

/** How one AI turn ended, as far as what its caller does next. */
export type TurnResult =
  /** The CLI answered - or failed for a reason of the work's own, which its caller reads. */
  | { kind: "answered"; outcome: AgentTurnOutcome }
  /** Stopped by the person, or while waiting to try again. */
  | { kind: "stopped"; outcome: AgentTurnOutcome }
  /** No answer to be had now: a sign-in that ran out, or a service still away after the last wait. */
  | { kind: "unavailable"; trouble: TurnTrouble; reason: string };

/**
 * Has one AI turn the way every job Aime runs on the user's behalf needs it:
 * a failed turn is never read as an answer (`lib/turnTrouble.ts`). A service
 * that cannot be reached is tried again after each of `UNREACHABLE_WAITS_MS`;
 * a sign-in that ran out, or a service still away after the last wait, is
 * handed back for the caller to pause or stop on.
 */
export async function haveTurn(
  take: () => Promise<AgentTurnOutcome>,
  hooks: {
    /** Waits, unless the job is stopped first; true when the whole wait was had. */
    waitOrStop: (ms: number) => Promise<boolean>;
    /** Says that the service could not be reached and when the next try is. */
    retrying: (reason: string, seconds: number) => void;
  },
): Promise<TurnResult> {
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await take();
    if (outcome.code === null) return { kind: "stopped", outcome };
    if (outcome.code === 0) return { kind: "answered", outcome };
    const trouble = troubleIn([outcome.errors, outcome.stderr, outcome.text].join("\n"));
    if (trouble === null) return { kind: "answered", outcome };
    const reason = failureOf(outcome);
    const wait = trouble === "unreachable" ? UNREACHABLE_WAITS_MS.at(attempt) : undefined;
    if (wait === undefined) return { kind: "unavailable", trouble, reason };
    hooks.retrying(reason, wait / 1000);
    if (!(await hooks.waitOrStop(wait))) return { kind: "stopped", outcome: { ...outcome, code: null } };
  }
}

/** How often a wait looks again at whether its job was stopped. */
const STOP_POLL_MS = 1_000;

/**
 * Waits `ms`, unless `going` turns false first; true when the whole wait was
 * had. The `waitOrStop` a job hands `haveTurn`, so Stop ends a retry wait
 * within a second instead of after it.
 */
export async function waitWhile(going: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!going()) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(STOP_POLL_MS, until - Date.now())));
  }
  return going();
}

interface StreamPayload {
  run_id: string;
  event: unknown;
}

interface ExitPayload {
  run_id: string;
  code: number | null;
}

interface StderrPayload {
  run_id: string;
  event: string;
}

/**
 * Runs the turn and waits for it.
 *
 * Listening happens *before* the CLI is started, and what arrives before its id
 * is known is kept: `ai_send_prompt` hands the id back only once the process
 * has been spawned, and a short-lived CLI can be over before that promise
 * settles - measured with a stand-in CLI that exits in milliseconds, which left
 * a run hanging at its phase forever. Until the id is known nothing can be
 * attributed either, since another turn may be streaming at the same moment,
 * so events are held and replayed for the id that turned out to be this one.
 */
export async function agentTurn(options: AgentTurnOptions): Promise<AgentTurnOutcome> {
  const ai = useAi.getState();
  const provider = ai.providers.find((candidate) => candidate.id === ai.providerId);
  const parse = createEventParser({
    id: ai.providerId,
    parser: provider?.parser,
    textField: provider?.textField,
    sessionField: provider?.sessionField,
  });

  let runId: string | null = null;
  let said = "";
  let cost: number | null = null;
  let session: string | null = null;
  const errors: string[] = [];
  const held: StreamPayload[] = [];
  const heldErr: StderrPayload[] = [];
  const stderr: string[] = [];
  const keepErr = (line: string) => {
    stderr.push(line);
    if (stderr.length > STDERR_LINES_KEPT) stderr.shift();
    options.onStderr?.(line);
  };
  const early: ExitPayload[] = [];
  // Wired before the listeners, so reporting is never a maybe.
  let report: (code: number | null) => void = () => undefined;
  const finished = new Promise<number | null>((resolve) => {
    report = resolve;
  });

  const take = (payload: StreamPayload) => {
    for (const one of parse(payload.event)) {
      if (one.kind === "message-delta") said += one.text;
      if (one.kind === "done" && one.resultText !== undefined) said = one.resultText;
      // The CLI reports the session's running total; a caller that carries a
      // session on knows where its last turn's total stood.
      if (one.kind === "done" && one.sessionCostUsd !== undefined) cost = one.sessionCostUsd;
      if (one.kind === "session-info") session = one.sessionId;
      if (one.kind === "error") errors.push(one.message);
      if (one.kind === "tool-call") options.onToolCall?.(`${one.name} ${one.detail}`.trim());
    }
  };

  const listeners: UnlistenFn[] = [
    await listen<StreamPayload>("ai:stream", ({ payload }) => {
      if (runId === null) held.push(payload);
      else if (payload.run_id === runId) take(payload);
    }),
    await listen<ExitPayload>("ai:exit", ({ payload }) => {
      if (runId === null) early.push(payload);
      else if (payload.run_id === runId) report(payload.code);
    }),
    await listen<StderrPayload>("ai:stderr", ({ payload }) => {
      if (runId === null) heldErr.push(payload);
      else if (payload.run_id === runId) keepErr(payload.event);
    }),
  ];
  const stopListening = () => {
    for (const off of listeners) off();
  };

  try {
    runId = await invoke<string>("ai_send_prompt", {
      providerId: ai.providerId,
      prompt: options.prompt,
      cwd: options.cwd,
      // Only a session this caller opened: a turn on the user's behalf must never
      // join or resume the user's chat.
      sessionId: options.sessionId ?? null,
      options: {
        model: options.model ?? (ai.model || null),
        effort: options.model === undefined ? ai.effort || null : null,
        permission: options.permission,
        tools: options.tools ?? "everything",
        schema: options.schema ?? null,
      },
    });
  } catch (error: unknown) {
    stopListening();
    throw error;
  }
  options.onStarted?.(runId);

  // Whatever streamed or ended while nobody knew which run to listen for.
  for (const payload of held) {
    if (payload.run_id === runId) take(payload);
  }
  for (const payload of heldErr) {
    if (payload.run_id === runId) keepErr(payload.event);
  }
  const already = early.find((exit) => exit.run_id === runId);
  if (already !== undefined) report(already.code);

  const code = await finished;
  stopListening();
  return {
    code,
    text: said,
    costUsd: cost,
    stderr: stderr.join("\n"),
    errors: errors.join("\n"),
    sessionId: session,
  };
}

/** Ends a turn; the CLI's exit then arrives through the turn's own listener. */
export function cancelAgentTurn(runId: string): Promise<void> {
  return invoke("ai_cancel", { runId });
}
