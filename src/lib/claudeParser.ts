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
}

interface ClaudeStreamLine {
  type: "stream_event";
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
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

type ClaudeLine = ClaudeSystemLine | ClaudeStreamLine | ClaudeAssistantLine | ClaudeResultLine;

function isClaudeLine(raw: unknown): raw is ClaudeLine {
  return typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string";
}

/**
 * Builds the parser for one Claude Code run (ARCHITECTURE.md §4).
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
      default:
        return [];
    }
  };

  return (raw: unknown): UiAiEvent[] => (isClaudeLine(raw) ? parseLine(raw, parseSystem) : []);
}

function parseLine(raw: ClaudeLine, parseSystem: (raw: ClaudeSystemLine) => UiAiEvent[]): UiAiEvent[] {
  switch (raw.type) {
    case "system":
      return parseSystem(raw);

    case "stream_event": {
      const delta = raw.event?.delta;
      return raw.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text
        ? [{ kind: "message-delta", text: delta.text }]
        : [];
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
