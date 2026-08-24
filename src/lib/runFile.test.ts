import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The journal, which is what resume and the history are made of.
 *
 * Worth its own tests for one reason: everything else in a run is visible on
 * screen the moment it goes wrong, and this is not. A journal that quietly
 * fails to write looks exactly like a journal that wrote - until a week later,
 * when the run somebody wanted to read is not there.
 */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { interruptedRun, listRuns, loadRun, saveRun } = await import("./runFile");
const { newRun } = await import("./runPlan");

/** Everything a run can hold, so `clip` is exercised on every shape it has. */
function fullRun(id: string, ended: boolean) {
  const run = newRun(id, "12", "Round the total", Number(id.replace("run-", "")));
  const outcome = {
    code: 1,
    stdout: "x".repeat(20_000),
    stderr: "y".repeat(20_000),
    durationMs: 5,
    timedOut: false,
    cancelled: false,
    clipped: false,
  };
  const suiteRun = {
    command: "npm test",
    report: { passed: false, failed: ["a::two"], total: 2, reader: "cargo" },
    outcome,
  };
  return {
    run: {
      ...run,
      current: ended ? null : ("implement" as const),
      ended: ended ? ({ kind: "done" } as const) : null,
    },
    brief: { goal: "g", criteria: [{ id: "AC1", text: "t" }], questions: [], raw: "{}" },
    survey: {
      files: ["src/cart.js"],
      patterns: ["p - src/x.js"],
      testsLiveIn: "test.cjs",
      suites: [],
      raw: "{}",
    },
    radius: { changing: ["src/cart.js"], dependents: ["src/checkout.js"], unknown: [] },
    solution: { how: "h", why: "w", decisions: ["d"], raw: "{}" },
    cases: {
      cases: [{ id: "TC1", criterion: "AC1", prove: "a unit test", given: "g", when: "w", then: "t" }],
      raw: "{}",
    },
    plan: { steps: [], tests: [{ name: "n", file: "test.cjs", case: "TC1" }], raw: "{}" },
    review: { risks: ["r"], findings: [], raw: "{}" },
    baseline: { suites: [{ id: "node.test", label: "npm test", run: suiteRun, silence: null }] },
    checks: {
      checks: [{ id: "node.check", label: "npm run check", command: "npm run check", outcome, error: null }],
    },
    verdict: {
      suites: [
        {
          id: "node.test",
          label: "npm test",
          before: suiteRun,
          after: suiteRun,
          comparison: { broken: [], alreadyBroken: [], repaired: [], brokeWithoutDetail: false },
        },
      ],
      silent: [],
      blocks: false,
    },
    evidence: ["C:/work/test-results/one.png"],
    discovered: [{ id: "ai-suite-1", label: "make test", kind: "test" as const, command: "make test" }],
    redCases: ["TC1"],
    untrackedBefore: ["notes.txt"],
  };
}

/** What the last `write_file` put on disk. */
function written(): { path: string; parsed: Record<string, unknown> } {
  const writes = (invoke.mock.calls as unknown[][]).filter((one) => one[0] === "write_file");
  if (writes.length === 0) throw new Error("nothing was written");
  const payload = writes[writes.length - 1][1] as { path: string; content: string };
  return { path: payload.path, parsed: JSON.parse(payload.content) as Record<string, unknown> };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("saveRun", () => {
  it("writes every artifact a phase produced, under the run's own id", async () => {
    const saved = fullRun("run-1000", true);
    await saveRun("C:/work", saved);

    const { path, parsed } = written();
    expect(path).toBe("C:/work/.aime/runs/run-1000.json");
    // The whole point of the file: a run reopened months later has to show what
    // it decided and what it proved, not just how far it got.
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "baseline",
        "brief",
        "cases",
        "checks",
        "discovered",
        "evidence",
        "plan",
        "radius",
        "redCases",
        "review",
        "run",
        "solution",
        "survey",
        "untrackedBefore",
        "verdict",
        "version",
      ].sort(),
    );
    expect(parsed.version).toBe(4);
  });

  it("cuts the command output down instead of writing megabytes of build chatter", async () => {
    await saveRun("C:/work", fullRun("run-1000", true));
    const { parsed } = written();

    const baseline = parsed.baseline as { suites: { run: { outcome: { stdout: string } } }[] };
    // The tail is what a resumed run needs - failures print last - and 20k of
    // progress lines re-read on every open is what this avoids.
    expect(baseline.suites[0].run.outcome.stdout.length).toBe(8_000);
    const checks = parsed.checks as { checks: { outcome: { stderr: string } }[] };
    expect(checks.checks[0].outcome.stderr.length).toBe(8_000);
  });

  it("is quiet when the disk will not take it, because a run is still a run", async () => {
    invoke.mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(saveRun("C:/work", fullRun("run-1000", true))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("listRuns", () => {
  /** A folder listing and the file contents behind it, as the backend answers. */
  function projectWith(runs: { name: string; content: string }[]): void {
    invoke.mockImplementation((command: string, args: Record<string, string>) => {
      if (command === "list_dir") {
        return Promise.resolve(
          runs.map((one) => ({ name: one.name, path: `C:/work/.aime/runs/${one.name}`, is_dir: false })),
        );
      }
      if (command === "read_file") {
        const found = runs.find((one) => args.path.endsWith(one.name));
        return found === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(found.content);
      }
      return Promise.resolve(undefined);
    });
  }

  it("lists what the project kept, newest first", async () => {
    projectWith([
      { name: "run-1000.json", content: JSON.stringify({ version: 4, ...fullRun("run-1000", true) }) },
      { name: "run-3000.json", content: JSON.stringify({ version: 4, ...fullRun("run-3000", true) }) },
    ]);

    const runs = await listRuns("C:/work");
    expect(runs.map((saved) => saved.run.id)).toEqual(["run-3000", "run-1000"]);
  });

  it("skips a file from an older shape rather than half-reading it", async () => {
    projectWith([
      { name: "run-1000.json", content: JSON.stringify({ version: 3, run: { id: "run-1000" } }) },
      { name: "run-2000.json", content: "{ not json" },
      { name: "run-3000.json", content: JSON.stringify({ version: 4, ...fullRun("run-3000", true) }) },
    ]);

    const runs = await listRuns("C:/work");
    expect(runs.map((saved) => saved.run.id)).toEqual(["run-3000"]);
  });

  it("answers nothing at all for a project that has never had a run", async () => {
    invoke.mockRejectedValue(new Error("no such directory"));
    await expect(listRuns("C:/work")).resolves.toEqual([]);
  });

  it("finds the run that was cut off mid-phase, which is the one worth offering", async () => {
    projectWith([
      { name: "run-1000.json", content: JSON.stringify({ version: 4, ...fullRun("run-1000", false) }) },
      { name: "run-3000.json", content: JSON.stringify({ version: 4, ...fullRun("run-3000", true) }) },
    ]);

    const live = await interruptedRun("C:/work");
    // A phase was in flight and nothing ended it: exactly what a closed lid
    // looks like on disk.
    expect(live?.run.id).toBe("run-1000");
  });
});

describe("loadRun", () => {
  it("reads one run by the name it was written under", async () => {
    invoke.mockResolvedValue(JSON.stringify({ version: 4, ...fullRun("run-1000", true) }));

    const saved = await loadRun("C:/work", "run-1000");
    expect(saved?.cases?.cases[0].id).toBe("TC1");
    expect(saved?.evidence).toEqual(["C:/work/test-results/one.png"]);
  });
});
