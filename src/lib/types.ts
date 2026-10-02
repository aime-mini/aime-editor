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

/** Work the CLI keeps going after its own answer: a shell or a subagent left running in the background. */
export interface BackgroundTask {
  id: string;
  description: string;
  /** The tool call that started it, when the CLI has said which one. */
  toolUseId?: string;
}

/** How far the CLI has got retrying an AI service it cannot reach. */
export interface ApiRetry {
  attempt: number;
  maxAttempts: number;
}

/** Normalized events the UI understands — every provider adapter maps to these (ARCHITECTURE.md §4) */
export type UiAiEvent =
  | { kind: "session-info"; sessionId: string; model?: string }
  | { kind: "message-delta"; text: string }
  | {
      kind: "tool-call";
      name: string;
      detail: string;
      /** The CLI's id for this call, so the steps of a subagent can find the call that started it. */
      id?: string;
      /** Set when a subagent made this call: the id of the call that started that subagent. */
      parentId?: string;
    }
  /** The CLI could not reach the AI service and is trying again on its own. */
  | ({ kind: "retrying" } & ApiRetry)
  /** Everything the CLI is still running in the background - the whole list, every time it changes. */
  | { kind: "background"; tasks: BackgroundTask[] }
  /**
   * The CLI compacted the conversation: what the earlier turns were handed may
   * now be a summary or gone, and has to be handed over again.
   */
  | { kind: "compacted" }
  | {
      kind: "done";
      /**
       * What the whole conversation has cost so far, as the CLI counts it. Not
       * this turn's price: Claude Code carries the total across `--resume`, so
       * a turn's own cost is the difference from where it started.
       */
      sessionCostUsd?: number;
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

/** One tool call a subagent made, shown under the call that started that subagent. */
export interface ToolStep {
  name: string;
  detail: string;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      name: string;
      detail: string;
      id?: string;
      /** What the subagent this call started has done, in order. */
      steps?: ToolStep[];
    };

/**
 * Mirror of the Rust `Checkpoint` (checkpoint.rs): one snapshot per repository
 * of the workspace. Opaque here - it is only ever handed back to the backend,
 * which also still reads the single-snapshot shape older sessions stored.
 */
export interface Checkpoint {
  repositories: { root: string; sha: string; untracked: string[] }[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  parts: MessagePart[];
  costUsd?: number;
  /** Wall-clock time from send to the CLI exiting, background work included. */
  durationMs?: number;
  usage?: TokenUsage;
  /** State of the project before this turn, when it could be captured. */
  checkpoint?: Checkpoint;
  /** Files this turn changed; empty or absent means it changed nothing. */
  changedFiles?: string[];
  /** Set once the user has taken this turn back. */
  undone?: boolean;
  /**
   * Set while the turn runs and cleared when it ends, so a turn still marked
   * after a restart is one the app was closed in the middle of.
   */
  unfinished?: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
