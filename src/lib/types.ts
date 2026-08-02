/** Token usage of one AI turn (or a session total), normalized across providers. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Normalized events the UI understands — every provider adapter maps to these (ARCHITECTURE.md §4) */
export type UiAiEvent =
  | { kind: "session-info"; sessionId: string; model?: string }
  | { kind: "message-delta"; text: string }
  | { kind: "tool-call"; name: string; detail: string }
  | {
      kind: "done";
      costUsd?: number;
      durationMs?: number;
      sessionId?: string;
      resultText?: string;
      usage?: TokenUsage;
    }
  | { kind: "error"; message: string };

/**
 * How much the agent may do on its own. A setting rather than a per-call
 * dialog by decision (ARCHITECTURE.md §4): each adapter maps these onto its
 * CLI's own flags. The order is the order the shield chip cycles through.
 */
export const PERMISSION_ORDER = ["full", "edits", "readOnly"] as const;
export type Permission = (typeof PERMISSION_ORDER)[number];

/** Tool chips show one line — longer details live in the chip's tooltip. */
export function truncateDetail(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type MessagePart = { kind: "text"; text: string } | { kind: "tool"; name: string; detail: string };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: MessagePart[];
  costUsd?: number;
  durationMs?: number;
  usage?: TokenUsage;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
