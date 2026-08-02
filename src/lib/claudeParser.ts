import { translate } from "../i18n";
import { truncateDetail, type UiAiEvent } from "./types";

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
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeAssistantLine {
  type: "assistant";
  message?: { content?: ClaudeContentBlock[] };
}

interface ClaudeResultLine {
  type: "result";
  subtype?: string;
  result?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
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
 * Maps one Claude Code JSONL line to normalized UI events (ARCHITECTURE.md §4).
 *
 * De-duplication rule: text comes ONLY from `stream_event` deltas;
 * `assistant` lines are used solely to detect tool_use blocks.
 */
export function parseClaudeEvent(raw: unknown): UiAiEvent[] {
  if (!isClaudeLine(raw)) return [];

  switch (raw.type) {
    case "system":
      return raw.subtype === "init" && raw.session_id
        ? [{ kind: "session-info", sessionId: raw.session_id, model: raw.model }]
        : [];

    case "stream_event": {
      const delta = raw.event?.delta;
      return raw.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text
        ? [{ kind: "message-delta", text: delta.text }]
        : [];
    }

    case "assistant":
      return (raw.message?.content ?? [])
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          kind: "tool-call",
          name: block.name ?? "tool",
          detail: summarizeToolInput(block.input),
        }));

    case "result": {
      const events: UiAiEvent[] = [
        {
          kind: "done",
          costUsd: raw.total_cost_usd,
          durationMs: raw.duration_ms,
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
      if (raw.subtype && raw.subtype !== "success") {
        events.push({ kind: "error", message: translate("ai.finishedWithStatus", { status: raw.subtype }) });
      }
      return events;
    }

    // Unknown line types (rate_limit_event, future additions) are ignored by design.
    default:
      return [];
  }
}

/** Condenses a tool call's input into a single line shown on the chip. */
function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of ["file_path", "command", "pattern", "prompt"]) {
    const value = input[key];
    if (typeof value === "string") return truncateDetail(value);
  }
  return truncateDetail(JSON.stringify(input));
}
