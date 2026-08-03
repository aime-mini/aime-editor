import { describe, expect, it } from "vitest";
import { appendOutput, type OutputSegment } from "./output";

/** The console renders segments as text; this is what the user would read. */
function rendered(segments: OutputSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

describe("appendOutput", () => {
  it("joins the pieces one print statement arrives in", () => {
    // Measured against debugpy: `print("total", n)` came back as two events,
    // `"total"` and `" 6\n"`. One line, cut wherever the pipe happened to flush.
    let segments: OutputSegment[] = [];
    segments = appendOutput(segments, { category: "stdout", output: "total" });
    segments = appendOutput(segments, { category: "stdout", output: " 6\n" });
    expect(segments).toHaveLength(1);
    expect(rendered(segments)).toBe("total 6\n");
  });

  it("keeps stderr apart from stdout", () => {
    let segments: OutputSegment[] = [];
    segments = appendOutput(segments, { category: "stdout", output: "working" });
    segments = appendOutput(segments, { category: "stderr", output: "boom" });
    segments = appendOutput(segments, { category: "stdout", output: "done" });
    expect(segments.map((segment) => segment.category)).toEqual(["stdout", "stderr", "stdout"]);
  });

  it("drops the adapter's telemetry, which is not the program talking", () => {
    // js-debug mixes `category: "telemetry"` into the same event stream.
    const before: OutputSegment[] = [{ category: "stdout", text: "hi" }];
    const after = appendOutput(before, { category: "telemetry", output: "{...}" });
    expect(after).toBe(before);
  });

  it("ignores an empty event rather than starting a segment for it", () => {
    const before: OutputSegment[] = [];
    expect(appendOutput(before, { category: "stdout" })).toBe(before);
    expect(appendOutput(before, { category: "stdout", output: "" })).toBe(before);
  });

  it("treats an unknown category as console text instead of hiding it", () => {
    const segments = appendOutput([], { category: "important", output: "listen" });
    expect(segments).toEqual([{ category: "console", text: "listen" }]);
  });

  it("caps a runaway program instead of growing without limit", () => {
    let segments: OutputSegment[] = [];
    for (let i = 0; i < 40; i++) {
      segments = appendOutput(segments, {
        category: i % 2 === 0 ? "stdout" : "stderr",
        output: "x".repeat(10_000),
      });
    }
    expect(rendered(segments).length).toBeLessThanOrEqual(200_000);
    // The newest output is what matters when a program floods the console.
    expect(segments[segments.length - 1]?.category).toBe("stderr");
  });

  it("keeps the tail when one single segment is over the cap", () => {
    const segments = appendOutput([], { category: "stdout", output: "abc".repeat(100_000) });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text.length).toBe(200_000);
    expect(segments[0]?.text.endsWith("abc")).toBe(true);
  });
});
