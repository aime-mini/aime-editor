import { describe, expect, it } from "vitest";
import {
  hoverToMarkdown,
  pathToUri,
  toLspPosition,
  toMonacoRange,
  toOutline,
  uriToPath,
  answerToServerRequest,
} from "./convert";

/** LSP counts from 0, so line 4 below is line 5 in the editor. */
const lspRange = (fromLine: number, toLine: number) => ({
  start: { line: fromLine, character: 0 },
  end: { line: toLine, character: 1 },
});

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

describe("toOutline", () => {
  it("keeps the tree a server already nested", () => {
    const outline = toOutline([
      {
        name: "Program",
        kind: 5,
        range: lspRange(0, 9),
        selectionRange: lspRange(0, 0),
        children: [{ name: "Main", kind: 6, range: lspRange(2, 4), selectionRange: lspRange(2, 2) }],
      },
    ]);
    expect(outline).toHaveLength(1);
    expect(outline[0].name).toBe("Program");
    expect(outline[0].children.map((child) => child.name)).toEqual(["Main"]);
    // Monaco's counting, so the class starts on line 1 and the method on line 3.
    expect(outline[0].range.startLineNumber).toBe(1);
    expect(outline[0].children[0].range.startLineNumber).toBe(3);
  });

  it("nests a flat SymbolInformation answer by containment", () => {
    // The shape older servers answer with: no children, and the range inside a
    // location. Without nesting, the enclosing class would never be the sticky
    // line above a method.
    const outline = toOutline([
      { name: "Main", kind: 6, location: { range: lspRange(2, 4) } },
      { name: "Program", kind: 5, location: { range: lspRange(0, 9) } },
      { name: "Helper", kind: 12, location: { range: lspRange(11, 13) } },
    ]);
    expect(outline.map((symbol) => symbol.name)).toEqual(["Program", "Helper"]);
    expect(outline[0].children.map((child) => child.name)).toEqual(["Main"]);
    expect(outline[1].children).toEqual([]);
  });

  it("drops a symbol with nowhere to point, and answers nothing for nothing", () => {
    expect(toOutline([{ name: "ghost", kind: 12 }])).toEqual([]);
    expect(toOutline([{ kind: 12, range: lspRange(0, 1) }])).toEqual([]);
    expect(toOutline(null)).toEqual([]);
    expect(toOutline({ symbols: [] })).toEqual([]);
  });

  it("falls back to the whole range when a server sends no selection", () => {
    const [symbol] = toOutline([{ name: "Main", kind: 6, range: lspRange(4, 6) }]);
    expect(symbol.selectionRange).toEqual(symbol.range);
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

describe("answerToServerRequest", () => {
  it("answers one configuration value per section the server asked about", () => {
    // Measured: the Roslyn language server asks for several at once and shuts
    // itself down when the array is shorter than its list.
    const params = { items: [{ section: "csharp" }, { section: "razor" }, { section: "mystery" }] };
    expect(answerToServerRequest("workspace/configuration", params)).toEqual([null, null, null]);
  });

  it("answers an empty list when a server asks for nothing in particular", () => {
    expect(answerToServerRequest("workspace/configuration", {})).toEqual([]);
    expect(answerToServerRequest("workspace/configuration", null)).toEqual([]);
  });

  it("answers nothing to everything else, which is what Aime has to offer", () => {
    expect(answerToServerRequest("client/registerCapability", { registrations: [] })).toBeNull();
  });
});
