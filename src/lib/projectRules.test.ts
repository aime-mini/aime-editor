import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These rules are the strongest evidence a run has about how a project wants to
 * be written, and every failure mode here is silent: a file skipped, a budget
 * spent on paragraph 400 of a design document, or a heading printed over an
 * empty list, which reads as "this project has no rules".
 */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { readProjectRules, rulesBlock, RULE_FILES } = await import("./projectRules");

/** Answers `read_file` from a map of path suffix to content; the rest are missing. */
function onDisk(files: Record<string, string>): void {
  invoke.mockImplementation((command: string, args: { path: string }) => {
    if (command !== "read_file") throw new Error(`unexpected command ${command}`);
    const found = Object.entries(files).find(([name]) => args.path.endsWith(name));
    if (found === undefined) return Promise.reject(new Error("no such file"));
    return Promise.resolve(found[1]);
  });
}

beforeEach(() => {
  invoke.mockReset();
});

describe("readProjectRules", () => {
  it("reads the files a project has and says nothing about the ones it does not", async () => {
    onDisk({ "AGENTS.md": "state lives in a zustand store", "CONTRIBUTING.md": "one commit per change" });

    const found = await readProjectRules("C:/work");

    expect(found.map((one) => one.path)).toEqual(["AGENTS.md", "CONTRIBUTING.md"]);
    expect(found[0].text).toBe("state lives in a zustand store");
  });

  it("keeps the declared order, so the memory files are read before the notes", async () => {
    onDisk(Object.fromEntries(RULE_FILES.map((path) => [path, `rules of ${path}`])));

    const found = await readProjectRules("C:/work");

    expect(found.map((one) => one.path)).toEqual([...RULE_FILES]);
  });

  it("cuts a long file down and says that it did", async () => {
    // The head of a rule document is where it states its rules; the tail of
    // this project's own architecture notes is 30,000 words of history.
    onDisk({ "AGENTS.md": "x".repeat(10_000) });

    const [found] = await readProjectRules("C:/work");

    expect(found.text.length).toBe(6_000);
    expect(found.truncated).toBe(true);
  });

  it("spends a fixed budget across all of them", async () => {
    onDisk(Object.fromEntries(RULE_FILES.map((path) => [path, "y".repeat(10_000)])));

    const found = await readProjectRules("C:/work");

    const carried = found.reduce((sum, one) => sum + one.text.length, 0);
    expect(carried).toBe(12_000);
    // A prompt that spends everything on rules has nothing left for the code.
    expect(found.length).toBeLessThan(RULE_FILES.length);
  });

  it("skips a file that exists but says nothing", async () => {
    onDisk({ "AGENTS.md": "   \n\n" });

    expect(await readProjectRules("C:/work")).toEqual([]);
  });

  it("carries on when a file cannot be read at all", async () => {
    // A permission on a document is not worth ending a run over.
    invoke.mockRejectedValue(new Error("access denied"));

    expect(await readProjectRules("C:/work")).toEqual([]);
  });
});

describe("rulesBlock", () => {
  it("says nothing at all when the project wrote no rules", () => {
    // A heading with an empty list under it reads as a claim, and the wrong one.
    expect(rulesBlock([])).toEqual([]);
  });

  it("names each file and marks the ones it could not carry whole", () => {
    const block = rulesBlock([
      { path: "AGENTS.md", text: "no invoke in components", truncated: false },
      { path: "ARCHITECTURE.md", text: "adapters normalise events", truncated: true },
    ]).join("\n");

    expect(block).toContain("--- AGENTS.md ---");
    expect(block).toContain("no invoke in components");
    expect(block).toContain("--- ARCHITECTURE.md (first part) ---");
    // The model has to know these outrank what it would infer from the code.
    expect(block).toContain("They outrank your defaults");
  });
});
