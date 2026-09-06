import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAi } from "../stores/ai";
import { createEventParser } from "./aiParsers";

/**
 * One turn of the AI CLI run as an agent - with tools, in a folder - outside
 * the user's conversation, awaited to its exit.
 *
 * Shared by the task run and the cloud deploy, which both start the CLI on the
 * user's behalf and must never join the chat session (ARCHITECTURE.md §4). The
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
 * cloud however it is prompted. Measured 2026-09-06: plan mode alone still runs
 * commands, so `readOnly` does not give this.
 */
export type TurnTools = "everything" | "filesOnly";

export interface AgentTurnOptions {
  prompt: string;
  cwd: string;
  permission: TurnPermission;
  tools?: TurnTools;
  /** A tool the CLI called, as one line for a log. */
  onToolCall?: (line: string) => void;
  /** A line the CLI wrote to stderr. */
  onStderr?: (line: string) => void;
  /** The run id, the moment the CLI is spawned - what a cancel needs. */
  onStarted?: (runId: string) => void;
}

export interface AgentTurnOutcome {
  /** The CLI's exit code, or null when it was cancelled. */
  code: number | null;
  /** What the agent said: the final result when the CLI reports one, else the streamed text. */
  text: string;
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
  });

  let runId: string | null = null;
  let said = "";
  const held: StreamPayload[] = [];
  const heldErr: StderrPayload[] = [];
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
      else if (payload.run_id === runId) options.onStderr?.(payload.event);
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
      // No session id: this must never join or resume the user's chat.
      sessionId: null,
      options: {
        model: ai.model || null,
        effort: ai.effort || null,
        permission: options.permission,
        tools: options.tools ?? "everything",
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
    if (payload.run_id === runId) options.onStderr?.(payload.event);
  }
  const already = early.find((exit) => exit.run_id === runId);
  if (already !== undefined) report(already.code);

  const code = await finished;
  stopListening();
  return { code, text: said };
}

/** Ends a turn; the CLI's exit then arrives through the turn's own listener. */
export function cancelAgentTurn(runId: string): Promise<void> {
  return invoke("ai_cancel", { runId });
}
