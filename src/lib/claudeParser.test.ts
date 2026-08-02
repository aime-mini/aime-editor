import { describe, expect, it } from "vitest";
import { parseClaudeEvent } from "./claudeParser";

/**
 * Fixtures mirror real JSONL lines emitted by
 * `claude -p --output-format stream-json --include-partial-messages --verbose`
 * (verified against Claude Code CLI 2.1.220).
 */
describe("parseClaudeEvent", () => {
  it("maps system/init to session-info", () => {
    const events = parseClaudeEvent({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-opus-5",
    });
    expect(events).toEqual([{ kind: "session-info", sessionId: "abc-123", model: "claude-opus-5" }]);
  });

  it("maps text deltas to message-delta and ignores other stream events", () => {
    const delta = parseClaudeEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
    });
    expect(delta).toEqual([{ kind: "message-delta", text: "Hello" }]);

    const other = parseClaudeEvent({
      type: "stream_event",
      event: { type: "content_block_start" },
    });
    expect(other).toEqual([]);
  });

  it("maps assistant tool_use blocks to tool-call chips with a summarized input", () => {
    const events = parseClaudeEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "ignored - text comes from deltas only" },
          { type: "tool_use", name: "Edit", input: { file_path: "C:\\p\\a.ts", old_string: "x" } },
        ],
      },
    });
    expect(events).toEqual([{ kind: "tool-call", name: "Edit", detail: "C:\\p\\a.ts" }]);
  });

  it("maps a successful result to done with cost, duration, and normalized usage", () => {
    const events = parseClaudeEvent({
      type: "result",
      subtype: "success",
      result: "Done.",
      total_cost_usd: 0.0214,
      duration_ms: 5329,
      session_id: "abc-123",
      usage: {
        input_tokens: 18,
        output_tokens: 164,
        cache_read_input_tokens: 51007,
        cache_creation_input_tokens: 7471,
      },
    });
    expect(events).toEqual([
      {
        kind: "done",
        costUsd: 0.0214,
        durationMs: 5329,
        sessionId: "abc-123",
        resultText: "Done.",
        usage: { inputTokens: 18, outputTokens: 164, cacheReadTokens: 51007, cacheWriteTokens: 7471 },
      },
    ]);
  });

  it("adds an error event when the result subtype is not success", () => {
    const events = parseClaudeEvent({ type: "result", subtype: "error_max_turns" });
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("done");
    expect(events[1].kind).toBe("error");
  });

  it("returns an empty list for unknown line types and malformed input", () => {
    expect(parseClaudeEvent({ type: "rate_limit_event", info: {} })).toEqual([]);
    expect(parseClaudeEvent("not an object")).toEqual([]);
    expect(parseClaudeEvent(null)).toEqual([]);
    expect(parseClaudeEvent({ no_type: true })).toEqual([]);
  });
});
