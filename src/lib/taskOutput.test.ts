import { describe, expect, it } from "vitest";
import { readExitCode, stripAnsi } from "./taskOutput";

/** The escape character every ANSI sequence starts with. */
const ESC = "\u001B";

describe("readExitCode", () => {
  it("reads the code the shell printed", () => {
    expect(readExitCode("", "npm test\n[aime] exit code: 1\n")).toBe(1);
    expect(readExitCode("", "[aime] exit code: 0\n")).toBe(0);
  });

  it("ignores the shell echoing the command that contains the marker", () => {
    // PowerShell echoes the typed line before running it.
    const echo = 'npm test; Write-Host "[aime] exit code: $LASTEXITCODE"\n';
    expect(readExitCode("", echo)).toBeNull();
  });

  it("finds a marker split across two chunks", () => {
    const seen = "building…\n[aime] exit c";
    expect(readExitCode(seen, "ode: 2\n")).toBe(2);
  });

  it("is not fooled by output that merely mentions an exit code", () => {
    expect(readExitCode("", "process exited with code 3\n")).toBeNull();
  });

  it("returns null while the task is still producing output", () => {
    expect(readExitCode("compiling", " module a\n")).toBeNull();
  });
});

describe("stripAnsi", () => {
  it("removes colors but keeps the text", () => {
    expect(stripAnsi(`${ESC}[31mFAIL${ESC}[0m src/app.test.ts`)).toBe("FAIL src/app.test.ts");
  });

  it("removes window-title (OSC) sequences", () => {
    expect(stripAnsi(`${ESC}]0;npm test${ESC}\\done`)).toBe("done");
  });

  it("leaves plain output untouched", () => {
    expect(stripAnsi("2 tests passed")).toBe("2 tests passed");
  });
});
