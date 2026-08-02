import { truncateDetail, type UiAiEvent } from "./types";

/**
 * Schema (the parts we consume) of the JSONL emitted by `codex exec --json`,
 * verified against codex-cli 0.146.0 — the `ThreadEvent` envelope wraps a
 * `ThreadItem` that goes through started → updated → completed.
 * Every field is optional: a CLI upgrade must degrade the UI, never break it.
 */
interface CodexFileChange {
  path?: string;
  kind?: string;
}

interface CodexItem {
  id?: string;
  type?: string;
  /** agent_message, reasoning */
  text?: string;
  /** error */
  message?: string;
  /** command_execution */
  command?: string;
  /** file_change */
  changes?: CodexFileChange[];
  /** mcp_tool_call */
  server?: string;
  tool?: string;
  /** web_search */
  query?: string;
}

interface CodexEvent {
  type: string;
  /** thread.started */
  thread_id?: string;
  /** item.* */
  item?: CodexItem;
  /** turn.completed */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
  };
  /** turn.failed */
  error?: { message?: string };
  /** error */
  message?: string;
}

function isCodexEvent(raw: unknown): raw is CodexEvent {
  return typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string";
}

type ToolChip = Extract<UiAiEvent, { kind: "tool-call" }>;

function chip(name: string, detail: string): ToolChip {
  return { kind: "tool-call", name, detail: truncateDetail(detail) };
}

function describeChanges(changes: CodexFileChange[] | undefined): string {
  return (changes ?? [])
    .map((change) => change.path ?? "")
    .filter(Boolean)
    .join(", ");
}

/** Maps a tool-ish item to the chip the timeline shows; null = not a tool. */
function toolChipOf(item: CodexItem): ToolChip | null {
  switch (item.type) {
    case "command_execution":
      return chip("shell", item.command ?? "");
    case "file_change":
      return chip("edit", describeChanges(item.changes));
    case "mcp_tool_call":
      return chip(`${item.server ?? "mcp"}.${item.tool ?? "tool"}`, "");
    case "web_search":
      return chip("web_search", item.query ?? "");
    default:
      return null;
  }
}

/**
 * Maps the Codex CLI's JSONL to normalized UI events (ARCHITECTURE.md §4).
 *
 * Stateful by necessity: items arrive in phases, so the parser remembers how
 * much of each message it has already emitted and which items are chipped.
 * One parser instance per run — never share it across turns.
 */
export function createCodexParser(): (raw: unknown) => UiAiEvent[] {
  /** agent_message id → characters already emitted as deltas. */
  const streamedChars = new Map<string, number>();
  /** Item ids that already produced a tool chip. */
  const chippedItems = new Set<string>();

  /**
   * Codex may deliver a message whole (on completion) or grow it across
   * updates — emitting only the unseen suffix covers both without duplicates.
   */
  const textDelta = (itemId: string, text: string): UiAiEvent[] => {
    const alreadySeen = streamedChars.get(itemId) ?? 0;
    if (text.length <= alreadySeen) return [];
    streamedChars.set(itemId, text.length);
    return [{ kind: "message-delta", text: text.slice(alreadySeen) }];
  };

  const parseItem = (item: CodexItem, isFinalPhase: boolean): UiAiEvent[] => {
    const itemId = item.id ?? "";
    if (item.type === "agent_message") return textDelta(itemId, item.text ?? "");
    if (item.type === "error") {
      return item.message ? [{ kind: "error", message: item.message }] : [];
    }
    // Reasoning and plan items are the agent's scratch pad — deliberately not
    // shown, so the transcript stays the conversation the user had.
    if (chippedItems.has(itemId)) return [];

    const tool = toolChipOf(item);
    if (!tool) return [];
    // Chip once per item, at the first phase carrying a usable detail —
    // or at completion, so a detail-less tool still leaves a trace.
    if (!tool.detail && !isFinalPhase) return [];
    chippedItems.add(itemId);
    return [tool];
  };

  return (raw: unknown): UiAiEvent[] => {
    if (!isCodexEvent(raw)) return [];

    switch (raw.type) {
      case "thread.started":
        return raw.thread_id ? [{ kind: "session-info", sessionId: raw.thread_id }] : [];

      case "item.started":
      case "item.updated":
      case "item.completed":
        return raw.item ? parseItem(raw.item, raw.type === "item.completed") : [];

      case "turn.completed":
        return [
          {
            kind: "done",
            // Codex reports no per-turn price (subscription billing) — the UI
            // shows tokens only, never a fabricated cost.
            usage: {
              inputTokens: raw.usage?.input_tokens ?? 0,
              outputTokens: raw.usage?.output_tokens ?? 0,
              cacheReadTokens: raw.usage?.cached_input_tokens ?? 0,
              cacheWriteTokens: raw.usage?.cache_write_input_tokens ?? 0,
            },
          },
        ];

      case "turn.failed":
        return raw.error?.message ? [{ kind: "error", message: raw.error.message }] : [];

      case "error":
        return raw.message ? [{ kind: "error", message: raw.message }] : [];

      // Unknown event types (turn.started, future additions) are ignored by design.
      default:
        return [];
    }
  };
}
