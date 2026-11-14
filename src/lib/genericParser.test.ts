import { describe, expect, it } from "vitest";
import { createGenericParser } from "./genericParser";

describe("createGenericParser", () => {
  it("takes a plain CLI's every line as text", () => {
    expect(createGenericParser("plain", "text", "")({ type: "raw", text: "hello" })).toEqual([
      { kind: "message-delta", text: "hello\n" },
    ]);
  });

  it("reads the text out of the field a JSON-lines CLI names", () => {
    const parse = createGenericParser("jsonl", "content", "");
    expect(parse({ type: "message", role: "assistant", content: "Hi", delta: true })).toEqual([
      { kind: "message-delta", text: "Hi" },
    ]);
    expect(parse({ type: "result" })).toEqual([]);
  });

  // The first two lines gemini-cli 0.68.0 printed for `--output-format stream-json`
  // with the prompt on stdin.
  const INIT = {
    type: "init",
    timestamp: "2026-11-14T04:37:40.278Z",
    session_id: "4afee380-66d9-4db6-8309-93b6e90284ee",
    model: "auto",
  };
  const ECHO = {
    type: "message",
    timestamp: "2026-11-14T04:37:40.280Z",
    role: "user",
    content: "Reply with OK\n",
  };

  it("does not take the user's own message, echoed back, for the answer", () => {
    expect(createGenericParser("jsonl", "content", "session_id")(ECHO)).toEqual([]);
  });

  it("says which model the turn runs on, and its session when the config names the field", () => {
    expect(createGenericParser("jsonl", "content", "session_id")(INIT)).toEqual([
      { kind: "session-info", sessionId: "4afee380-66d9-4db6-8309-93b6e90284ee" },
      { kind: "ran-on", model: "auto" },
    ]);
  });

  it("reports no session for a CLI configured without the field", () => {
    expect(createGenericParser("jsonl", "content", "")(INIT)).toEqual([{ kind: "ran-on", model: "auto" }]);
  });
});
