import { describe, expect, it } from "vitest";
import { sessionToResume } from "./ai";

/** Newest first, the way the store keeps them. */
const history = [
  { localId: "3", providerId: "codex" },
  { localId: "2", providerId: "claude" },
  { localId: "1" },
];

describe("sessionToResume", () => {
  it("continues the newest conversation of the chosen CLI", () => {
    expect(sessionToResume(history, "claude")?.localId).toBe("2");
    expect(sessionToResume(history, "codex")?.localId).toBe("3");
  });

  it("starts fresh when the chosen CLI has no conversation here", () => {
    expect(sessionToResume(history, "gemini")).toBeUndefined();
  });

  it("treats a conversation saved before providers existed as Claude's", () => {
    const legacy = [{ localId: "1", providerId: undefined }];
    expect(sessionToResume(legacy, "claude")?.localId).toBe("1");
  });

  it("has nothing to resume in a project with no history", () => {
    const empty: { providerId?: string }[] = [];
    expect(sessionToResume(empty, "claude")).toBeUndefined();
  });
});
