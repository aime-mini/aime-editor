import { translate } from "../i18n";
import { truncateDetail, type BackgroundTask, type UiAiEvent } from "./types";

/**
 * Schema (the parts we consume) of the JSONL emitted by
 * `claude -p --output-format stream-json --include-partial-messages --verbose`.
 * Every field is optional — if the CLI changes across versions the parser
 * degrades gracefully instead of crashing.
 */
interface ClaudeSystemLine {
  type: "system";
  subtype?: string;
  session_id?: string;
  model?: string;
  /** `background_tasks_changed`: everything still running in the background. */
  tasks?: { task_id?: string; description?: string }[];
  /** `task_started`: the task and the tool call that started it. */
  task_id?: string;
  tool_use_id?: string;
  /** `api_retry`: the CLI could not reach the API and is trying again. */
  attempt?: number;
  max_retries?: number;
  /** `status`: what the CLI is about to do, `requesting` among others. */
  status?: string;
}

interface ClaudeStreamLine {
  type: "stream_event";
  event?: {
    type?: string;
    /** Which content block of the message this event belongs to. */
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
  };
  parent_tool_use_id?: string | null;
}

/**
 * A tool's answer, handed back to the AI as the next user message - or, with
 * `--replay-user-messages`, a message of the user's own echoed back as the
 * AI takes it up: a string then, where a tool's answer is blocks.
 */
interface ClaudeUserLine {
  type: "user";
  message?: { content?: unknown };
  parent_tool_use_id?: string | null;
}

interface ClaudeToolResult {
  type?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeAssistantLine {
  type: "assistant";
  message?: { content?: ClaudeContentBlock[] };
  /** Set on the lines of a subagent: the id of the Agent call that started it. */
  parent_tool_use_id?: string | null;
}

interface ClaudeResultLine {
  type: "result";
  subtype?: string;
  result?: unknown;
  /** True when the answer is the CLI's own report of a failed API call; `subtype` still says success. */
  is_error?: boolean;
  terminal_reason?: string;
  /** The conversation's total so far: the CLI restores it on `--resume`. */
  total_cost_usd?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** The CLI's answer to a control request written to its stdin. */
interface ClaudeControlResponseLine {
  type: "control_response";
  response?: {
    subtype?: string;
    request_id?: string;
    response?: { cancelled?: unknown };
  };
}

type ClaudeLine =
  | ClaudeSystemLine
  | ClaudeStreamLine
  | ClaudeAssistantLine
  | ClaudeUserLine
  | ClaudeResultLine
  | ClaudeControlResponseLine;

function isClaudeLine(raw: unknown): raw is ClaudeLine {
  return typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string";
}

/**
 * How many more characters of a call's input make it worth saying so. A file
 * written by the AI arrives as hundreds of tiny deltas (measured: 460 for a
 * sixty-line poem); one event per delta would redraw the panel for nothing.
 */
const INPUT_PROGRESS_STEP = 200;

/** How far into a call's input its subject is looked for; it is written first, when at all. */
const DETAIL_SCAN_CHARS = 4_096;

/** The input fields that say what a call is about, as `summarizeToolInput` reads them. */
const DETAIL_FIELD = /"(?:file_path|command|pattern|description)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** A tool call whose input is still streaming. */
interface OpenCall {
  id: string;
  chars: number;
  reported: number;
  /** The start of the input, kept only until the call's subject is found in it. */
  head: string;
  detail: string | undefined;
}

/** The subject of a call, read out of the first part of its still-incomplete JSON input. */
function detailOf(partialInput: string): string | undefined {
  const match = DETAIL_FIELD.exec(partialInput);
  if (match === null) return undefined;
  try {
    return truncateDetail(JSON.parse(`"${match[1]}"`) as string);
  } catch {
    // An escape cut in half by the stream: the next delta completes it.
    return undefined;
  }
}

/** The calls a user line hands results back for, and whether each one failed. */
function toolResults(raw: ClaudeUserLine): UiAiEvent[] {
  const content = raw.message?.content;
  if (raw.parent_tool_use_id || !Array.isArray(content)) return [];
  return (content as ClaudeToolResult[]).flatMap((block) =>
    block.type === "tool_result" && block.tool_use_id
      ? [{ kind: "tool-result" as const, id: block.tool_use_id, failed: block.is_error === true }]
      : [],
  );
}

/**
 * Builds the parser for one Claude Code run.
 *
 * De-duplication rule: text comes ONLY from `stream_event` deltas;
 * `assistant` lines are used solely to detect tool_use blocks.
 *
 * A run is more than one answer. An Agent or a shell left running in the
 * background keeps the process alive after the answer, and its work streams
 * on the same stdout - measured against 2.1.286: the subagent's tool calls
 * carry `parent_tool_use_id`, the set of running tasks arrives as
 * `background_tasks_changed`, and each answer ends in its own `result`
 * (`result_index` 0, 1, …). Which call started which task is only said by
 * `task_started`, so that is the state this parser carries.
 */
export function createClaudeParser(): (raw: unknown) => UiAiEvent[] {
  const toolUseIdByTask = new Map<string, string>();
  let running: BackgroundTask[] = [];
  /** Tool calls whose input is streaming, by content block index. */
  const openCalls = new Map<number, OpenCall>();

  /**
   * The answer as it is written: its text, and - measured on 2.1.302 - a
   * `content_block_start` for every tool call and every stretch of reasoning
   * the moment it begins, the call's input following as `input_json_delta`.
   * A subagent's own stream is left to its tool calls, which carry its steps.
   */
  const parseStream = (raw: ClaudeStreamLine): UiAiEvent[] => {
    const event = raw.event;
    if (event === undefined || raw.parent_tool_use_id) return [];
    const block = event.content_block;
    const delta = event.delta;
    switch (event.type) {
      case "content_block_start":
        if (block?.type === "thinking") return [{ kind: "phase", phase: "thinking" }];
        if (block?.type !== "tool_use" || !block.id || event.index === undefined) return [];
        openCalls.set(event.index, { id: block.id, chars: 0, reported: 0, head: "", detail: undefined });
        return [{ kind: "tool-start", id: block.id, name: block.name ?? "tool" }];
      case "content_block_delta":
        if (delta?.type === "text_delta" && delta.text) return [{ kind: "message-delta", text: delta.text }];
        if (delta?.type === "input_json_delta" && event.index !== undefined) {
          return inputProgress(event.index, delta.partial_json ?? "");
        }
        return [];
      case "content_block_stop":
        if (event.index !== undefined) openCalls.delete(event.index);
        return [];
      default:
        return [];
    }
  };

  const inputProgress = (index: number, json: string): UiAiEvent[] => {
    const call = openCalls.get(index);
    if (call === undefined || json === "") return [];
    call.chars += json.length;
    let found = false;
    if (call.detail === undefined && call.head.length < DETAIL_SCAN_CHARS) {
      call.head += json;
      call.detail = detailOf(call.head);
      found = call.detail !== undefined;
    }
    if (!found && call.chars - call.reported < INPUT_PROGRESS_STEP) return [];
    call.reported = call.chars;
    return [{ kind: "tool-input", id: call.id, chars: call.chars, detail: call.detail }];
  };

  const backgroundEvent = (): UiAiEvent => ({
    kind: "background",
    tasks: running.map((task) => ({ ...task, toolUseId: toolUseIdByTask.get(task.id) })),
  });

  const parseSystem = (raw: ClaudeSystemLine): UiAiEvent[] => {
    switch (raw.subtype) {
      case "init":
        return raw.session_id ? [{ kind: "session-info", sessionId: raw.session_id, model: raw.model }] : [];
      case "api_retry":
        return raw.attempt !== undefined && raw.max_retries !== undefined
          ? [{ kind: "retrying", attempt: raw.attempt, maxAttempts: raw.max_retries }]
          : [];
      case "background_tasks_changed":
        running = (raw.tasks ?? []).flatMap((task) =>
          task.task_id ? [{ id: task.task_id, description: task.description ?? "" }] : [],
        );
        return [backgroundEvent()];
      case "task_started":
        if (!raw.task_id || !raw.tool_use_id) return [];
        toolUseIdByTask.set(raw.task_id, raw.tool_use_id);
        // Only news when the task is one of the background ones on screen;
        // a subagent's own foreground commands start tasks too.
        return running.some((task) => task.id === raw.task_id) ? [backgroundEvent()] : [];
      // Measured on 2.1.287 with `/compact` sent to a resumed session: a
      // `status: compacting`, then this line with `compact_metadata`
      // (`trigger` manual or auto, `pre_tokens`, `post_tokens`).
      case "compact_boundary":
        return [{ kind: "compacted" }];
      // Sent before every request to the AI service: the first one of a turn,
      // and the one after each tool answer.
      case "status":
        return raw.status === "requesting" ? [{ kind: "phase", phase: "requesting" }] : [];
      default:
        return [];
    }
  };

  return (raw: unknown): UiAiEvent[] => {
    if (!isClaudeLine(raw)) return [];
    if (raw.type === "system") return parseSystem(raw);
    if (raw.type === "stream_event") return parseStream(raw);
    if (raw.type === "control_response") return parseControlResponse(raw);
    return parseLine(raw);
  };
}

/**
 * The one control request a chat turn sends is taking a message back
 * (`cancel_async_message`), named after the message - so every answer is read
 * as that. Measured on 2.1.310: `{"cancelled":true}` while the message waits,
 * `{"cancelled":false}` once the AI has read it; an error took nothing back.
 */
function parseControlResponse(raw: ClaudeControlResponseLine): UiAiEvent[] {
  const answer = raw.response;
  if (typeof answer?.request_id !== "string") return [];
  return [{ kind: "withdrawal", id: answer.request_id, withdrawn: answer.response?.cancelled === true }];
}

function parseLine(raw: ClaudeAssistantLine | ClaudeUserLine | ClaudeResultLine): UiAiEvent[] {
  switch (raw.type) {
    case "user": {
      const content = raw.message?.content;
      if (typeof content === "string") return [{ kind: "user-read", text: content }];
      return toolResults(raw);
    }

    case "assistant": {
      const parentId = raw.parent_tool_use_id ?? undefined;
      return (raw.message?.content ?? [])
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          kind: "tool-call",
          name: block.name ?? "tool",
          detail: summarizeToolInput(block.input),
          id: block.id,
          parentId,
        }));
    }

    case "result": {
      const events: UiAiEvent[] = [
        {
          kind: "done",
          sessionCostUsd: raw.total_cost_usd,
          sessionId: raw.session_id,
          resultText: typeof raw.result === "string" ? raw.result : undefined,
          usage: raw.usage && {
            inputTokens: raw.usage.input_tokens ?? 0,
            outputTokens: raw.usage.output_tokens ?? 0,
            cacheReadTokens: raw.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: raw.usage.cache_creation_input_tokens ?? 0,
          },
        },
      ];
      // Measured with the API unreachable (2.1.286): ten retries over three
      // minutes, then `is_error` with the reason in `result` - "API Error:
      // Connection refused …" - which is written nowhere else the user sees.
      if (raw.is_error === true) {
        const reason = typeof raw.result === "string" && raw.result ? raw.result : raw.terminal_reason;
        events.push({
          kind: "error",
          message: reason ?? translate("ai.finishedWithStatus", { status: "error" }),
        });
      } else if (raw.subtype && raw.subtype !== "success") {
        events.push({ kind: "error", message: translate("ai.finishedWithStatus", { status: raw.subtype }) });
      }
      return events;
    }

    // Unknown line types (rate_limit_event, future additions) are ignored by design.
    default:
      return [];
  }
}

/**
 * Condenses a tool call's input into a single line shown on the chip. An
 * Agent call says what it was sent to do in `description`; its `prompt` is
 * the whole brief, which no one-line chip can hold.
 */
function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of ["file_path", "command", "pattern", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string") return truncateDetail(value);
  }
  return truncateDetail(JSON.stringify(input));
}
