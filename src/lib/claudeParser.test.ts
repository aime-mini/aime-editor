import { describe, expect, it } from "vitest";
import { createClaudeParser } from "./claudeParser";

/**
 * Fixtures mirror real JSONL lines emitted by
 * `claude -p --output-format stream-json --include-partial-messages --verbose`
 * (verified against Claude Code CLI 2.1.220).
 */
describe("createClaudeParser", () => {
  const parseClaudeEvent = createClaudeParser();

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
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: { file_path: "C:\\p\\a.ts", old_string: "x" },
          },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "tool-call", name: "Edit", detail: "C:\\p\\a.ts", id: "toolu_1", parentId: undefined },
    ]);
  });

  // Lines captured from a real run (2.1.286): an Agent sent to the background,
  // whose own commands then stream on the same stdout as the main answer.
  describe("a subagent left running in the background", () => {
    const agentCall = "toolu_01Am8fTUUHoX52EVgSDQankC";
    const brief = "Run sequential bash commands and report completion";

    it("names the Agent call by what it was sent to do", () => {
      const events = createClaudeParser()({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: agentCall,
              name: "Agent",
              input: {
                description: brief,
                subagent_type: "general-purpose",
                prompt:
                  "Run the Bash command `sleep 20; echo SUB-A` then run the Bash command `echo SUB-B`, then reply DONE.",
                run_in_background: true,
              },
            },
          ],
        },
        parent_tool_use_id: null,
      });
      expect(events).toEqual([
        { kind: "tool-call", name: "Agent", detail: brief, id: agentCall, parentId: undefined },
      ]);
    });

    it("marks the subagent's own tool calls with the call that started it", () => {
      const events = createClaudeParser()({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_01A9DMZyGH414wddirigb4qk",
              name: "Bash",
              input: { command: "sleep 20; echo SUB-A", description: "Sleep for 20 seconds then echo SUB-A" },
            },
          ],
        },
        parent_tool_use_id: agentCall,
      });
      expect(events).toEqual([
        {
          kind: "tool-call",
          name: "Bash",
          detail: "sleep 20; echo SUB-A",
          id: "toolu_01A9DMZyGH414wddirigb4qk",
          parentId: agentCall,
        },
      ]);
    });

    it("reports what is still running, joined to the call that started it", () => {
      const parse = createClaudeParser();
      const listed = parse({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "ae11657905e99a9f1", task_type: "local_agent", description: brief }],
      });
      // The CLI lists the task before it says which call started it.
      expect(listed).toEqual([
        {
          kind: "background",
          tasks: [{ id: "ae11657905e99a9f1", description: brief, toolUseId: undefined }],
        },
      ]);

      const started = parse({
        type: "system",
        subtype: "task_started",
        task_id: "ae11657905e99a9f1",
        tool_use_id: agentCall,
        description: brief,
        is_backgrounded: true,
        task_type: "local_agent",
      });
      expect(started).toEqual([
        {
          kind: "background",
          tasks: [{ id: "ae11657905e99a9f1", description: brief, toolUseId: agentCall }],
        },
      ]);

      const finished = parse({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      expect(finished).toEqual([{ kind: "background", tasks: [] }]);
    });

    it("stays quiet about the tasks a subagent's foreground commands start", () => {
      const parse = createClaudeParser();
      expect(
        parse({
          type: "system",
          subtype: "task_started",
          task_id: "bauvitlbm",
          owned_by_subagent: true,
          tool_use_id: "toolu_01A9DMZyGH414wddirigb4qk",
          is_backgrounded: false,
          task_type: "local_bash",
        }),
      ).toEqual([]);
    });
  });

  it("maps a successful result to done with the session cost and normalized usage", () => {
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
        sessionCostUsd: 0.0214,
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

  // Captured on 2.1.287 by sending `/compact` to a resumed session.
  it("says when the CLI compacted the conversation, and nothing about the status lines around it", () => {
    expect(parseClaudeEvent({ type: "system", subtype: "status", status: "compacting" })).toEqual([]);
    expect(
      parseClaudeEvent({
        type: "system",
        subtype: "compact_boundary",
        session_id: "308c8c13-cbfe-4fc3-a119-f6f95b29c19b",
        compact_metadata: { trigger: "manual", pre_tokens: 5137, post_tokens: 982 },
      }),
    ).toEqual([{ kind: "compacted" }]);
  });

  // Captured with ANTHROPIC_BASE_URL pointed at a closed port (2.1.286).
  describe("the AI service cannot be reached", () => {
    it("says the CLI is retrying, and how far along it is", () => {
      const events = parseClaudeEvent({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 2243,
        error_status: null,
        error: "unknown",
      });
      expect(events).toEqual([{ kind: "retrying", attempt: 3, maxAttempts: 10 }]);
    });

    it("reports the CLI's own reason once it gives up, though the subtype says success", () => {
      const reason = "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)";
      const events = parseClaudeEvent({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: null,
        result: reason,
        total_cost_usd: 0,
        duration_ms: 170746,
        result_index: 0,
      });
      expect(events.map((event) => event.kind)).toEqual(["done", "error"]);
      expect(events[1]).toEqual({ kind: "error", message: reason });
    });
  });

  // Lines captured from 2.1.302 running `sleep 6 && echo hi`, then `exit 3`;
  // ids, uuids and the session id trimmed.
  describe("the answer as it is written", () => {
    const bash = "toolu_01ULS2qkigUAG7aGwK4TpeAV";
    const inputDelta = (partial_json: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } },
      parent_tool_use_id: null,
    });

    it("names a tool call the moment it starts, and what it is about once its input says", () => {
      const parse = createClaudeParser();
      expect(
        parse({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: bash,
              name: "Bash",
              input: {},
              caller: { type: "direct" },
            },
          },
          parent_tool_use_id: null,
        }),
      ).toEqual([{ kind: "tool-start", id: bash, name: "Bash" }]);
      expect(parse(inputDelta(""))).toEqual([]);
      expect(parse(inputDelta('{"command": "sleep 6'))).toEqual([]);
      expect(parse(inputDelta(" && echo hi"))).toEqual([]);
      expect(parse(inputDelta('", "description": "S'))).toEqual([
        { kind: "tool-input", id: bash, chars: 51, detail: "sleep 6 && echo hi" },
      ]);
      expect(parse(inputDelta("leep 6 seconds"))).toEqual([]);
    });

    it("says how much of a long input has been written, a step at a time", () => {
      const parse = createClaudeParser();
      parse({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "w", name: "Write" },
        },
      });
      const line = "x".repeat(90);
      const reports = Array.from({ length: 10 }, () => parse(inputDelta(line))).flat();
      expect(reports.map((event) => (event.kind === "tool-input" ? event.chars : -1))).toEqual([
        270, 540, 810,
      ]);
    });

    it("forgets a call once its block ends", () => {
      const parse = createClaudeParser();
      parse({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: bash, name: "Bash" },
        },
      });
      parse({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        parent_tool_use_id: null,
      });
      expect(parse(inputDelta("x".repeat(500)))).toEqual([]);
    });

    it("says when the AI took up a message written during the turn - the CLI echoes it", () => {
      // Line shape captured from 2.1.307 with --replay-user-messages.
      const parse = createClaudeParser();
      expect(
        parse({
          type: "user",
          message: { role: "user", content: "Second instruction: reply with the single word DONE2." },
          parent_tool_use_id: null,
          session_id: "558ae744-7432-48a2-9772-5cba59c3b088",
          uuid: "6d0c6e9c-1f1c-4a35-9a1e-9d3b7a1b2c3d",
        }),
      ).toEqual([
        {
          kind: "user-read",
          text: "Second instruction: reply with the single word DONE2.",
          id: "6d0c6e9c-1f1c-4a35-9a1e-9d3b7a1b2c3d",
        },
      ]);
    });

    it("names a message read together with the one before it by its own id, though its text is joined", () => {
      // Captured from 2.1.316: two messages that waited for the same turn end.
      const parse = createClaudeParser();
      expect(
        parse({
          type: "user",
          message: { role: "user", content: "Reply with exactly: ONE\nReply with exactly: TWO" },
          parent_tool_use_id: null,
          uuid: "a497f7e9-924a-4d6d-b816-fbdb5805c935",
        }),
      ).toEqual([
        {
          kind: "user-read",
          text: "Reply with exactly: ONE\nReply with exactly: TWO",
          id: "a497f7e9-924a-4d6d-b816-fbdb5805c935",
        },
      ]);
    });

    it("reads the CLI's answer to taking a message back, by the message it names", () => {
      const parse = createClaudeParser();
      // Captured from 2.1.310: before the AI read the message, and after.
      const answer = (cancelled: boolean) => ({
        type: "control_response",
        response: { subtype: "success", request_id: "e6576fcc", response: { cancelled } },
      });
      expect(parse(answer(true))).toEqual([{ kind: "withdrawal", id: "e6576fcc", withdrawn: true }]);
      expect(parse(answer(false))).toEqual([{ kind: "withdrawal", id: "e6576fcc", withdrawn: false }]);
      expect(
        parse({
          type: "control_response",
          response: { subtype: "error", request_id: "e6576fcc", error: "not supported" },
        }),
      ).toEqual([{ kind: "withdrawal", id: "e6576fcc", withdrawn: false }]);
    });

    it("says when a call is back, and whether it failed", () => {
      const parse = createClaudeParser();
      expect(
        parse({
          type: "user",
          message: {
            role: "user",
            content: [{ tool_use_id: bash, type: "tool_result", content: "hi", is_error: false }],
          },
          parent_tool_use_id: null,
        }),
      ).toEqual([{ kind: "tool-result", id: bash, failed: false }]);
      expect(
        parse({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                content: "Exit code 3",
                is_error: true,
                tool_use_id: "toolu_01NoBSTzZ5epnj9C2kqhg26Y",
              },
            ],
          },
          parent_tool_use_id: null,
          tool_use_result: "Error: Exit code 3",
        }),
      ).toEqual([{ kind: "tool-result", id: "toolu_01NoBSTzZ5epnj9C2kqhg26Y", failed: true }]);
    });

    it("says when the AI is waiting on the service, and when it reasons", () => {
      const parse = createClaudeParser();
      expect(parse({ type: "system", subtype: "status", status: "requesting" })).toEqual([
        { kind: "phase", phase: "requesting" },
      ]);
      expect(
        parse({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          parent_tool_use_id: null,
          thinking_display: "updates",
        }),
      ).toEqual([{ kind: "phase", phase: "thinking" }]);
    });
  });

  it("returns an empty list for unknown line types and malformed input", () => {
    expect(parseClaudeEvent({ type: "rate_limit_event", info: {} })).toEqual([]);
    expect(parseClaudeEvent("not an object")).toEqual([]);
    expect(parseClaudeEvent(null)).toEqual([]);
    expect(parseClaudeEvent({ no_type: true })).toEqual([]);
  });
});
