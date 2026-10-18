import { describe, expect, it } from "vitest";
import { createGenericParser } from "./genericParser";

describe("createGenericParser", () => {
  it("takes a plain CLI's every line as text", () => {
    expect(createGenericParser("plain", "text")({ type: "raw", text: "hello" })).toEqual([
      { kind: "message-delta", text: "hello\n" },
    ]);
  });

  it("reads the text out of the field a JSON-lines CLI names", () => {
    const parse = createGenericParser("jsonl", "content");
    expect(parse({ type: "message", role: "assistant", content: "Hi", delta: true })).toEqual([
      { kind: "message-delta", text: "Hi" },
    ]);
    expect(parse({ type: "result" })).toEqual([]);
  });

  // The shape gemini-cli-core 0.64.0's own formatter test gives its `init` event.
  it("says which model the turn runs on when a line names it", () => {
    const parse = createGenericParser("jsonl", "content");
    expect(
      parse({
        type: "init",
        timestamp: "2025-10-10T12:00:00.000Z",
        session_id: "test-session-123",
        model: "gemini-2.0-flash-exp",
      }),
    ).toEqual([{ kind: "ran-on", model: "gemini-2.0-flash-exp" }]);
  });
});
