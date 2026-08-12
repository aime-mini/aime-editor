import { describe, expect, it } from "vitest";
import {
  modelPath,
  hoverToMarkdown,
  pathToUri,
  toLspPosition,
  toLspRange,
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

  /** Incremental didChange sends Monaco edit ranges; toLspRange is that path. */
  it("round-trips a range through toLspRange and toMonacoRange", () => {
    const monacoRange = { startLineNumber: 280, startColumn: 29, endLineNumber: 280, endColumn: 43 };
    expect(toLspRange(monacoRange)).toEqual({
      start: { line: 279, character: 28 },
      end: { line: 279, character: 42 },
    });
    expect(toMonacoRange(toLspRange(monacoRange))).toEqual(monacoRange);
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
    expect(uri).toBe("file:///C:/Projects/my%20app/src/main.rs");
    expect(uriToPath(uri)).toBe("C:/Projects/my app/src/main.rs");
  });

  /**
   * The drive colon must NOT be percent-encoded. Measured 2026-08-12 against
   * the Roslyn language server (5.0.0-1.25277): .NET turns `file:///C%3A/…`
   * into the relative-looking LocalPath `/C:/…`, its absolute-path assertion
   * fires, and `project/open` is dropped - zero completions, no error shown.
   */
  it("keeps the drive colon literal, which Roslyn's URI parsing requires", () => {
    expect(pathToUri("C:\\Projects\\IODM\\Backend\\IODM.Connect.sln")).toBe(
      "file:///C:/Projects/IODM/Backend/IODM.Connect.sln",
    );
  });

  it("round-trips a POSIX path", () => {
    expect(uriToPath(pathToUri("/home/linh/project/main.go"))).toBe("/home/linh/project/main.go");
  });

  it("encodes characters that would otherwise break the URI", () => {
    expect(pathToUri("/tmp/a b#c.ts")).toBe("file:///tmp/a%20b%23c.ts");
  });
});

describe("modelPath", () => {
  /**
   * The measured shape from the real window: `@monaco-editor/react` parses the
   * file path as a URI, so a Windows drive letter lands in `scheme` and `fsPath`
   * comes back without it. Reading `fsPath` sent every server a path that does
   * not exist - which is exactly why this has a test of its own.
   */
  it("puts the drive letter back when it became the URI scheme", () => {
    const model = {
      uri: { scheme: "C", path: "\\Projects\\app\\App.java", fsPath: "\\Projects\\app\\App.java" },
    };
    expect(modelPath(model)).toBe("C:\\Projects\\app\\App.java");
    expect(pathToUri(modelPath(model))).toBe("file:///C:/Projects/app/App.java");
  });

  it("leaves a real file URI alone", () => {
    const model = {
      uri: { scheme: "file", path: "/home/linh/app/main.py", fsPath: "/home/linh/app/main.py" },
    };
    expect(modelPath(model)).toBe("/home/linh/app/main.py");
  });

  /** An in-memory model (a diff view, a scratch buffer) has no drive to restore. */
  it("keeps a scheme that is not a drive letter out of the path", () => {
    const model = { uri: { scheme: "inmemory", path: "/model/1", fsPath: "/model/1" } };
    expect(modelPath(model)).toBe("/model/1");
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
