import { describe, expect, it } from "vitest";
import {
  activityAfter,
  nextToHandOver,
  withQueuedRead,
  withToolCall,
  withToolResult,
  withToolStarted,
  withToolSubject,
} from "./liveTurn";
import type { ChatMessage, TurnActivity } from "./types";

const empty: ChatMessage = { role: "assistant", parts: [] };

describe("the parts of the turn being written", () => {
  it("gives a call its chip when it starts, and fills it in when it is whole", () => {
    const started = withToolStarted(empty, "t1", "Write");
    expect(started.parts).toEqual([
      { kind: "tool", name: "Write", detail: "", id: "t1", status: "preparing" },
    ]);

    const whole = withToolCall(
      started,
      { kind: "tool-call", name: "Write", detail: "notes.txt", id: "t1" },
      "",
    );
    expect(whole.parts).toEqual([
      { kind: "tool", name: "Write", detail: "notes.txt", id: "t1", status: "running" },
    ]);
  });

  it("names what a call is about while its input is still being written, once", () => {
    const started = withToolStarted(empty, "t1", "Write");
    const named = withToolSubject(started, "t1", "rivers.md");
    expect(named.parts[0]).toMatchObject({ detail: "rivers.md", status: "preparing" });
    expect(withToolSubject(named, "t1", "rivers.md")).toBe(named);
  });

  it("adds the chip of a call that was never announced as started", () => {
    const whole = withToolCall(empty, { kind: "tool-call", name: "shell", detail: "npm test", id: "c1" }, "");
    expect(whole.parts).toEqual([
      { kind: "tool", name: "shell", detail: "npm test", id: "c1", status: "running" },
    ]);
  });

  it("marks a call done or failed when it comes back, and leaves calls it does not hold alone", () => {
    const running = withToolCall(empty, { kind: "tool-call", name: "Bash", detail: "exit 3", id: "b1" }, "");
    expect(withToolResult(running, "b1", true).parts[0]).toMatchObject({ status: "failed" });
    expect(withToolResult(running, "b1", false).parts[0]).toMatchObject({ status: "done" });
    expect(withToolResult(running, "elsewhere", false)).toBe(running);
  });

  it("files a subagent's call under the Agent call that started it", () => {
    const agent = withToolCall(empty, { kind: "tool-call", name: "Agent", detail: "audit", id: "a1" }, "");
    const step = withToolCall(agent, { kind: "tool-call", name: "Read", detail: "x.ts", parentId: "a1" }, "");
    expect(step.parts).toHaveLength(1);
    expect(step.parts[0]).toMatchObject({ steps: [{ name: "Read", detail: "x.ts" }] });
  });
});

describe("what the turn is doing", () => {
  const waiting: TurnActivity = { kind: "waiting", since: 0 };

  it("keeps the clock of a state that merely continues", () => {
    const writing = activityAfter(waiting, { kind: "message-delta", text: "Hel" }, 10);
    expect(writing).toEqual({ kind: "writing", since: 10 });
    expect(activityAfter(writing, { kind: "message-delta", text: "lo" }, 20)).toBe(writing);
  });

  it("follows a call from its first character to its answer", () => {
    const preparing = activityAfter(waiting, { kind: "tool-start", id: "w", name: "Write" }, 5);
    expect(preparing).toMatchObject({ kind: "tool", preparing: true, inputChars: 0, since: 5 });

    const typed = activityAfter(preparing, { kind: "tool-input", id: "w", chars: 2_400, detail: "a.md" }, 9);
    expect(typed).toMatchObject({ preparing: true, inputChars: 2_400, detail: "a.md", since: 5 });

    const running = activityAfter(typed, { kind: "tool-call", name: "Write", detail: "a.md", id: "w" }, 12);
    expect(running).toMatchObject({ kind: "tool", preparing: false, since: 12 });

    expect(activityAfter(running, { kind: "tool-result", id: "w", failed: false }, 14)).toEqual({
      kind: "waiting",
      since: 14,
    });
  });

  it("ignores progress and answers that belong to another call", () => {
    const running = activityAfter(waiting, { kind: "tool-call", name: "Bash", detail: "ls", id: "b" }, 1);
    expect(activityAfter(running, { kind: "tool-input", id: "other", chars: 900 }, 2)).toBe(running);
    expect(activityAfter(running, { kind: "tool-result", id: "other", failed: false }, 2)).toBe(running);
  });

  it("keeps saying the Agent runs while its subagent works", () => {
    const agent = activityAfter(waiting, { kind: "tool-call", name: "Agent", detail: "audit", id: "a" }, 1);
    expect(activityAfter(agent, { kind: "tool-call", name: "Read", detail: "x", parentId: "a" }, 2)).toBe(
      agent,
    );
  });

  it("says when the AI reasons and when it waits on the service", () => {
    expect(activityAfter(waiting, { kind: "phase", phase: "thinking" }, 3)).toEqual({
      kind: "thinking",
      since: 3,
    });
    expect(activityAfter(waiting, { kind: "phase", phase: "requesting" }, 3)).toBe(waiting);
  });
});

describe("a message handed to the turn in flight", () => {
  const conversation: ChatMessage[] = [
    { role: "user", parts: [{ kind: "text", text: "fix the build" }] },
    { role: "assistant", parts: [{ kind: "text", text: "Looking." }], unfinished: true },
  ];
  const handed = { id: "q1", text: "and the tests", sent: "The editor shows x.ts\n\nand the tests" };
  const waiting = { id: "q2", text: "then push", sent: null };

  const readAsHanded = [
    conversation[0],
    { role: "assistant", parts: [{ kind: "text", text: "Looking." }] },
    { role: "user", parts: [{ kind: "text", text: "and the tests" }] },
    { role: "assistant", parts: [], unfinished: true },
  ];

  it("joins the conversation when the CLI echoes it, and the answer carries on under it", () => {
    const read = withQueuedRead(conversation, [handed, waiting], { text: handed.sent });
    expect(read?.queued).toEqual([waiting]);
    expect(read?.messages).toEqual(readAsHanded);
  });

  it("is found by the id the CLI names, though the text came back joined to another", () => {
    const joined = { id: "q1", text: `earlier message\n${handed.sent}` };
    const read = withQueuedRead(conversation, [handed, waiting], joined);
    expect(read?.queued).toEqual([waiting]);
    expect(read?.messages).toEqual(readAsHanded);
  });

  it("is only the message handed in - the turn's own prompt is echoed too, and is already there", () => {
    expect(
      withQueuedRead(conversation, [handed, waiting], { text: "fix the build", id: "cli-own" }),
    ).toBeNull();
    expect(withQueuedRead(conversation, [waiting], { text: "then push" })).toBeNull();
    expect(withQueuedRead(conversation, [waiting], { id: "q2" })).toBeNull();
  });
});

describe("handing queued messages to the turn", () => {
  type Queued = { id: string; text: string; sent: string | null };
  const waiting = (id: string): Queued => ({ id, text: id, sent: null });
  const handed = (id: string): Queued => ({ id, text: id, sent: id });
  const nothingQueued: Queued[] = [];

  it("hands the oldest waiting message over first", () => {
    expect(nextToHandOver([waiting("a"), waiting("b")])?.id).toBe("a");
  });

  it("holds the rest until the AI has read the one handed over", () => {
    expect(nextToHandOver([handed("a"), waiting("b")])).toBeUndefined();
  });

  it("has nothing to hand over when nothing waits", () => {
    expect(nextToHandOver(nothingQueued)).toBeUndefined();
  });
});
