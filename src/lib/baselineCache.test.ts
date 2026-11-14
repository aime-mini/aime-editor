import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { BASELINE_MAX_AGE_MS, baselineKey, keepBaseline, keptBaseline } = await import("./baselineCache");

const TEST = { id: "test", label: "test", kind: "test" as const, command: "npm test" };
const LINT = { id: "lint", label: "lint", kind: "check" as const, command: "npm run lint" };
const KEPT = {
  key: baselineKey(["abc123"], [TEST, LINT]),
  takenAt: 1_000,
  baseline: { suites: [] },
  checks: { checks: [] },
  environment: null,
};

describe("baselineKey", () => {
  it("is the same for the same commits and commands, in whatever order the tasks come", () => {
    expect(baselineKey(["abc123"], [TEST, LINT])).toBe(baselineKey(["abc123"], [LINT, TEST]));
  });

  it("changes with the commit and with any command", () => {
    const key = baselineKey(["abc123"], [TEST, LINT]);
    expect(baselineKey(["def456"], [TEST, LINT])).not.toBe(key);
    expect(baselineKey(["abc123"], [{ ...TEST, command: "npm test -- --coverage" }, LINT])).not.toBe(key);
  });
});

describe("keptBaseline", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("reads back a pass kept for exactly this key while it is young", async () => {
    invoke.mockResolvedValue(JSON.stringify(KEPT));
    expect(await keptBaseline("/p", KEPT.key, KEPT.takenAt + 60_000)).toEqual(KEPT);
    expect(invoke).toHaveBeenCalledWith("read_file", { path: "/p/.aime/cache/baseline.json" });
  });

  it("does not believe a pass taken on another commit or with other commands", async () => {
    invoke.mockResolvedValue(JSON.stringify(KEPT));
    expect(await keptBaseline("/p", baselineKey(["def456"], [TEST, LINT]), KEPT.takenAt)).toBeNull();
  });

  it("does not believe a pass older than a day: what the suites need from outside the tree can change", async () => {
    invoke.mockResolvedValue(JSON.stringify(KEPT));
    expect(await keptBaseline("/p", KEPT.key, KEPT.takenAt + BASELINE_MAX_AGE_MS)).toBeNull();
  });

  it("measures afresh when nothing is kept, or what is kept cannot be read", async () => {
    invoke.mockRejectedValue(new Error("not found"));
    expect(await keptBaseline("/p", KEPT.key, KEPT.takenAt)).toBeNull();
    invoke.mockResolvedValue("not json");
    expect(await keptBaseline("/p", KEPT.key, KEPT.takenAt)).toBeNull();
  });

  it("keeps a pass where the next run looks for it", async () => {
    invoke.mockResolvedValue(undefined);
    await keepBaseline("/p/", KEPT);
    expect(invoke).toHaveBeenCalledWith("write_file", {
      path: "/p/.aime/cache/baseline.json",
      content: JSON.stringify(KEPT),
    });
  });
});
