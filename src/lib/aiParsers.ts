import { parseClaudeEvent } from "./claudeParser";
import { createCodexParser } from "./codexParser";
import { createGenericParser } from "./genericParser";
import type { UiAiEvent } from "./types";

/** Turns one raw CLI output line into normalized UI events (ARCHITECTURE.md §4). */
export type EventParser = (raw: unknown) => UiAiEvent[];

/**
 * Builds the parser for one run. Some CLIs stream items in phases, so parsers
 * may carry per-run state — every turn therefore gets its own instance.
 * The backend rejects unknown providers before a run starts, so the fallback
 * only guards against a UI/backend version mismatch.
 */
export function createEventParser(provider: {
  id: string;
  parser?: string;
  textField?: string;
}): EventParser {
  switch (provider.parser ?? provider.id) {
    case "claude":
      return parseClaudeEvent;
    case "codex":
      return createCodexParser();
    case "jsonl":
      return createGenericParser("jsonl", provider.textField ?? "text");
    default:
      // Anything else is a configured CLI whose output is simply its answer.
      return createGenericParser("plain", "text");
  }
}
