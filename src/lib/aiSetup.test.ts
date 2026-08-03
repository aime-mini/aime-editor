import { describe, expect, it } from "vitest";
import { buildSetupPrompt } from "./aiSetup";

const base = {
  languageId: "cpp",
  relativePath: "src/main.cpp",
  serverCommand: "clangd",
  serverInstallHint: "winget install LLVM.LLVM",
  debuggerMissing: true,
};

describe("buildSetupPrompt", () => {
  it("names the file, so the agent reads real code instead of guessing the toolchain", () => {
    expect(buildSetupPrompt(base)).toContain("src/main.cpp");
  });

  it("states the checks Aime performs, which is the part an agent cannot guess", () => {
    const prompt = buildSetupPrompt(base);
    // Aime probes a command on PATH; an agent that installs a server elsewhere
    // would "succeed" and leave the language reported as unsupported.
    expect(prompt).toContain("`clangd`");
    expect(prompt).toContain("PATH");
    expect(prompt).toContain("Debug Adapter Protocol");
  });

  it("mentions only the gap that exists", () => {
    const serverOnly = buildSetupPrompt({ ...base, debuggerMissing: false });
    expect(serverOnly).toContain("clangd");
    expect(serverOnly).not.toContain("Debug Adapter Protocol");

    const debuggerOnly = buildSetupPrompt({
      ...base,
      serverCommand: null,
      serverInstallHint: null,
    });
    expect(debuggerOnly).toContain("Debug Adapter Protocol");
    expect(debuggerOnly).not.toContain("clangd");
    expect(debuggerOnly).not.toContain("PATH");
  });

  it("carries Aime's own hint when it has one, and omits the sentence when it does not", () => {
    expect(buildSetupPrompt(base)).toContain("winget install LLVM.LLVM");
    expect(buildSetupPrompt({ ...base, serverInstallHint: null })).not.toContain("My own hint");
  });

  it("tells the agent to stop rather than decide for the user", () => {
    // A multi-gigabyte download or an admin prompt is the user's call, and an
    // agent that pushes through one of those is worse than one that asks.
    expect(buildSetupPrompt(base)).toContain("stop and tell me");
  });

  it("never leaves a blank line where an omitted section was", () => {
    for (const request of [
      base,
      { ...base, debuggerMissing: false },
      { ...base, serverCommand: null, serverInstallHint: null },
    ]) {
      expect(buildSetupPrompt(request)).not.toMatch(/\n\n\n/);
    }
  });
});
