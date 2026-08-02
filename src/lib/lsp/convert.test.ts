import { describe, expect, it } from "vitest";
import { hoverToMarkdown, pathToUri, toLspPosition, toMonacoRange, uriToPath } from "./convert";

describe("position and range conversion", () => {
  it("shifts between Monaco's 1-based and LSP's 0-based counting", () => {
    expect(toLspPosition({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 });
    expect(toLspPosition({ lineNumber: 12, column: 5 })).toEqual({ line: 11, character: 4 });
  });

  it("shifts back for ranges", () => {
    expect(toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 7 } })).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 8,
    });
  });

  it("round-trips a position through both directions", () => {
    const monacoPosition = { lineNumber: 42, column: 9 };
    const asRange = toMonacoRange({
      start: toLspPosition(monacoPosition),
      end: toLspPosition(monacoPosition),
    });
    expect(asRange.startLineNumber).toBe(monacoPosition.lineNumber);
    expect(asRange.startColumn).toBe(monacoPosition.column);
  });
});

describe("hoverToMarkdown", () => {
  it("accepts every shape servers use", () => {
    expect(hoverToMarkdown("plain")).toBe("plain");
    expect(hoverToMarkdown({ kind: "markdown", value: "**bold**" })).toBe("**bold**");
    expect(hoverToMarkdown(["first", { value: "second" }])).toBe("first\n\nsecond");
  });

  it("is empty for nothing usable", () => {
    expect(hoverToMarkdown(undefined)).toBe("");
    expect(hoverToMarkdown(null)).toBe("");
    expect(hoverToMarkdown({ kind: "markdown" })).toBe("");
  });
});

describe("path and uri conversion", () => {
  it("round-trips a Windows path", () => {
    const path = "C:\\Projects\\my app\\src\\main.rs";
    const uri = pathToUri(path);
    expect(uri.startsWith("file:///C%3A/")).toBe(true);
    expect(uriToPath(uri)).toBe("C:/Projects/my app/src/main.rs");
  });

  it("round-trips a POSIX path", () => {
    expect(uriToPath(pathToUri("/home/linh/project/main.go"))).toBe("/home/linh/project/main.go");
  });

  it("encodes characters that would otherwise break the URI", () => {
    expect(pathToUri("/tmp/a b#c.ts")).toBe("file:///tmp/a%20b%23c.ts");
  });
});
