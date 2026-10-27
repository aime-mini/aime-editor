import { describe, expect, it } from "vitest";
import { buildSetupPrompt, type SetupRequest } from "./aiSetup";

/**
 * Python with neither of its tools here: the language server Aime probes for on
 * PATH, and the debug adapter it launches out of the user's own interpreter.
 */
const base: SetupRequest = {
  languageId: "python",
  relativePath: "src/main.py",
  serverCommand: "pyright-langserver",
  serverInstallHint: "npm i -g pyright",
  failedServer: null,
  missingDebugger: { adapterId: "debugpy", installHint: "pip install debugpy" },
  teachDebugger: false,
};

describe("buildSetupPrompt", () => {
  it("names the file, so the agent reads real code instead of guessing the toolchain", () => {
    expect(buildSetupPrompt(base)).toContain("src/main.py");
  });

  it("states the checks Aime performs, which is the part an agent cannot guess", () => {
    const prompt = buildSetupPrompt(base);
    // Aime probes a command on PATH; an agent that installs a server elsewhere
    // would "succeed" and leave the language reported as unsupported.
    expect(prompt).toContain("`pyright-langserver`");
    expect(prompt).toContain("PATH");
    expect(prompt).toContain("Debug Adapter Protocol");
  });

  it("names the adapter Aime launches, because installing another one changes nothing", () => {
    const prompt = buildSetupPrompt(base);
    expect(prompt).toContain("`debugpy`");
    expect(prompt).toContain("pip install debugpy");
    // The trap this sentence exists for: a machine with Python is not a machine
    // with debugpy, and Aime probes the adapter rather than the runtime.
    expect(prompt).toContain("toolchain this project actually uses");
  });

  it("mentions only the gap that exists", () => {
    const serverOnly = buildSetupPrompt({ ...base, missingDebugger: null });
    expect(serverOnly).toContain("pyright-langserver");
    expect(serverOnly).not.toContain("Debug Adapter Protocol");

    const debuggerOnly = buildSetupPrompt({
      ...base,
      serverCommand: null,
      serverInstallHint: null,
    });
    expect(debuggerOnly).toContain("Debug Adapter Protocol");
    expect(debuggerOnly).not.toContain("pyright-langserver");
    expect(debuggerOnly).not.toContain("PATH");
  });

  it("carries Aime's own hint when it has one, and omits the sentence when it does not", () => {
    expect(buildSetupPrompt(base)).toContain("npm i -g pyright");
    expect(buildSetupPrompt({ ...base, serverInstallHint: null, missingDebugger: null })).not.toContain(
      "My own hint",
    );
  });

  it("hands over the contract for teaching Aime an adapter it does not ship", () => {
    const taught = buildSetupPrompt({ ...base, missingDebugger: null, teachDebugger: true });
    // The shape `dap/learned.rs` parses, the rules Aime enforces, and the one
    // field the agent must not write - without these the entry fails the check.
    expect(taught).toContain(".aime/debug-adapters.json");
    expect(taught).toContain('"transport": "stdio" | "tcpServer"');
    expect(taught).toContain("verifyWith");
    expect(taught).toContain("Never write the `verified` field");
    // And it is only offered when an install could not have helped.
    expect(buildSetupPrompt(base)).not.toContain("debug-adapters.json");
  });

  it("still names a gap when teaching is the only thing missing", () => {
    // The php case: completions work (the server installed itself), so there
    // is no server gap and no installable adapter - the debugging line is all
    // the agent gets, and without it the prompt would open with a "what is
    // missing" heading over an empty list.
    const teachOnly = buildSetupPrompt({
      ...base,
      languageId: "php",
      relativePath: "index.php",
      serverCommand: null,
      serverInstallHint: null,
      missingDebugger: null,
      teachDebugger: true,
    });
    expect(teachOnly).toContain("I drive no Debug Adapter Protocol adapter for this language");
    expect(teachOnly).toContain(".aime/debug-adapters.json");
    expect(teachOnly).not.toContain("Code intelligence");
  });

  it("hands over a failed server's own error, and does not claim it is missing", () => {
    const failed = buildSetupPrompt({
      ...base,
      serverCommand: null,
      serverInstallHint: null,
      missingDebugger: null,
      failedServer: {
        command: "pyright-langserver",
        reason: "Error: Cannot find module 'node:fs'",
      },
    });
    // The agent gets the failure verbatim - that error is the whole brief.
    expect(failed).toContain("Cannot find module 'node:fs'");
    expect(failed).toContain("`pyright-langserver`");
    expect(failed).toContain("installed here");
    // A failed server is the opposite gap from a missing one: no PATH probe
    // talk, and no invitation to reinstall what is already there.
    expect(failed).not.toContain("PATH");
    expect(failed).toContain("Diagnose the failure above before reinstalling");
    // Aime retries by itself, and the agent should know that.
    expect(failed).toContain("the next time a file of its language is opened");
  });

  it("tells the agent to stop rather than decide for the user", () => {
    // A multi-gigabyte download or an admin prompt is the user's call, and an
    // agent that pushes through one of those is worse than one that asks.
    expect(buildSetupPrompt(base)).toContain("stop and tell me");
  });

  it("never leaves a blank line where an omitted section was", () => {
    for (const request of [
      base,
      { ...base, missingDebugger: null },
      { ...base, serverCommand: null, serverInstallHint: null },
    ]) {
      expect(buildSetupPrompt(request)).not.toMatch(/\n\n\n/);
    }
  });
});
