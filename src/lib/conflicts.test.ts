import { describe, expect, it } from "vitest";
import { hasConflictMarkers, parseConflicts, rebuildContent, resolvedText } from "./conflicts";

const SIMPLE = [
  "before",
  "<<<<<<< HEAD",
  "our line",
  "=======",
  "their line",
  ">>>>>>> feature/x",
  "after",
].join("\n");

const DIFF3 = [
  "<<<<<<< HEAD",
  "ours",
  "||||||| merged common ancestors",
  "base",
  "=======",
  "theirs",
  ">>>>>>> other",
].join("\n");

describe("parseConflicts", () => {
  it("splits text and conflict sections with labels", () => {
    const sections = parseConflicts(SIMPLE);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({ kind: "text", text: "before" });
    expect(sections[1]).toMatchObject({
      kind: "conflict",
      ours: "our line",
      theirs: "their line",
      base: null,
      oursLabel: "HEAD",
      theirsLabel: "feature/x",
    });
    expect(sections[2]).toEqual({ kind: "text", text: "after" });
  });

  it("captures the base block in diff3 style", () => {
    const sections = parseConflicts(DIFF3);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ kind: "conflict", ours: "ours", theirs: "theirs", base: "base" });
  });

  it("handles multiple conflicts and multi-line sides", () => {
    const content = `${SIMPLE}\nmiddle\n${SIMPLE}`;
    const sections = parseConflicts(content);
    expect(sections.filter((s) => s.kind === "conflict")).toHaveLength(2);
  });

  it("treats an unterminated block as plain text (never loses content)", () => {
    const broken = "start\n<<<<<<< HEAD\nlost?\nno end markers";
    const sections = parseConflicts(broken);
    expect(sections).toEqual([{ kind: "text", text: broken }]);
  });

  it("detects markers only when a full trio is present", () => {
    expect(hasConflictMarkers(SIMPLE)).toBe(true);
    expect(hasConflictMarkers("just <<<<<<< noise")).toBe(false);
  });
});

describe("resolution & rebuild", () => {
  const conflict = parseConflicts(SIMPLE)[1];
  it("resolves ours / theirs / both / custom", () => {
    if (conflict.kind !== "conflict") throw new Error("expected conflict");
    expect(resolvedText(conflict, { kind: "ours" })).toBe("our line");
    expect(resolvedText(conflict, { kind: "theirs" })).toBe("their line");
    expect(resolvedText(conflict, { kind: "both" })).toBe("our line\ntheir line");
    expect(resolvedText(conflict, { kind: "custom", text: "merged" })).toBe("merged");
  });

  it("rebuilds the exact file around resolutions", () => {
    const sections = parseConflicts(SIMPLE);
    expect(rebuildContent(sections, [{ kind: "theirs" }])).toBe("before\ntheir line\nafter");
  });

  it("round-trips untouched text byte-for-byte when conflicts resolve to ours", () => {
    const sections = parseConflicts(SIMPLE);
    expect(rebuildContent(sections, [{ kind: "ours" }])).toBe("before\nour line\nafter");
  });

  it("throws if a conflict is left unresolved", () => {
    const sections = parseConflicts(SIMPLE);
    expect(() => rebuildContent(sections, [null])).toThrow();
  });
});
