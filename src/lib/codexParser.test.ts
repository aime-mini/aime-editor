import { describe, expect, it } from "vitest";
import { createCodexParser } from "./codexParser";

/**
 * Fixtures mirror the `ThreadEvent` JSONL of `codex exec --json`
 * (codex-cli 0.146.0). One parser instance per turn, as in production.
 */
describe("createCodexParser", () => {
  it("maps thread.started to the resume id", () => {
    const parse = createCodexParser();
    expect(parse({ type: "thread.started", thread_id: "019fc113" })).toEqual([
      { kind: "session-info", sessionId: "019fc113" },
    ]);
  });

  it("emits only the unseen suffix of a growing agent message", () => {
    const parse = createCodexParser();
    const item = { id: "item_1", type: "agent_message" };

    expect(parse({ type: "item.started", item: { ...item, text: "" } })).toEqual([]);
    expect(parse({ type: "item.updated", item: { ...item, text: "Hello" } })).toEqual([
      { kind: "message-delta", text: "Hello" },
    ]);
    expect(parse({ type: "item.updated", item: { ...item, text: "Hello world" } })).toEqual([
      { kind: "message-delta", text: " world" },
    ]);
    // The completion repeats the whole message — it must not be shown twice.
    expect(parse({ type: "item.completed", item: { ...item, text: "Hello world" } })).toEqual([]);
  });

  it("emits a whole message that only arrives on completion", () => {
    const parse = createCodexParser();
    expect(
      parse({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Done." } }),
    ).toEqual([{ kind: "message-delta", text: "Done." }]);
  });

  it("tracks each message separately", () => {
    const parse = createCodexParser();
    parse({ type: "item.completed", item: { id: "a", type: "agent_message", text: "first" } });
    expect(
      parse({ type: "item.completed", item: { id: "b", type: "agent_message", text: "second" } }),
    ).toEqual([{ kind: "message-delta", text: "second" }]);
  });

  it("chips a command once, at the phase that first carries the command", () => {
    const parse = createCodexParser();
    const item = { id: "cmd_1", type: "command_execution", command: "npm test" };

    expect(parse({ type: "item.started", item })).toEqual([
      { kind: "tool-call", name: "shell", detail: "npm test" },
    ]);
    expect(parse({ type: "item.completed", item: { ...item, exit_code: 0 } })).toEqual([]);
  });

  it("chips a detail-less tool at completion rather than dropping it", () => {
    const parse = createCodexParser();
    const item = { id: "mcp_1", type: "mcp_tool_call", server: "github", tool: "list_issues" };

    expect(parse({ type: "item.started", item })).toEqual([]);
    expect(parse({ type: "item.completed", item })).toEqual([
      { kind: "tool-call", name: "github.list_issues", detail: "" },
    ]);
  });

  it("chips file changes with their paths", () => {
    const parse = createCodexParser();
    expect(
      parse({
        type: "item.completed",
        item: {
          id: "fc_1",
          type: "file_change",
          changes: [
            { path: "src/main.rs", kind: "update" },
            { path: "src/new.rs", kind: "add" },
          ],
        },
      }),
    ).toEqual([{ kind: "tool-call", name: "edit", detail: "src/main.rs, src/new.rs" }]);
  });

  it("keeps reasoning out of the transcript", () => {
    const parse = createCodexParser();
    expect(
      parse({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "let me think" } }),
    ).toEqual([]);
  });

  it("maps turn.completed to done with normalized usage and no invented cost", () => {
    const parse = createCodexParser();
    const [done] = parse({
      type: "turn.completed",
      usage: {
        input_tokens: 1200,
        cached_input_tokens: 900,
        cache_write_input_tokens: 100,
        output_tokens: 350,
      },
    });
    expect(done).toEqual({
      kind: "done",
      usage: {
        inputTokens: 1200,
        outputTokens: 350,
        cacheReadTokens: 900,
        cacheWriteTokens: 100,
      },
    });
  });

  it("surfaces failures from every error shape the CLI uses", () => {
    const parse = createCodexParser();
    expect(parse({ type: "error", message: "401 Unauthorized" })).toEqual([
      { kind: "error", message: "401 Unauthorized" },
    ]);
    expect(parse({ type: "turn.failed", error: { message: "stream disconnected" } })).toEqual([
      { kind: "error", message: "stream disconnected" },
    ]);
    expect(
      parse({ type: "item.completed", item: { id: "e1", type: "error", message: "sandbox denied" } }),
    ).toEqual([{ kind: "error", message: "sandbox denied" }]);
  });

  it("ignores unknown and malformed lines", () => {
    const parse = createCodexParser();
    expect(parse({ type: "turn.started" })).toEqual([]);
    expect(parse({ type: "item.completed", item: { id: "t1", type: "todo_list" } })).toEqual([]);
    expect(parse("not an object")).toEqual([]);
    expect(parse(null)).toEqual([]);
    expect(parse({ no_type: true })).toEqual([]);
  });
});
