import { describe, expect, it, vi } from "vitest";
import type { CommandOutcome } from "./exec";
import { gateResolution, judge, runSuite, testTaskOf, type SuiteRun } from "./regressionGate";
import { readTestOutput } from "./testReport";
import type { TaskDef } from "../stores/tasks";

const TASKS: TaskDef[] = [
  { id: "build", label: "Build", kind: "build", command: "npm run build" },
  { id: "test", label: "Test", kind: "test", command: "npm test" },
];

function outcome(over: Partial<CommandOutcome>): CommandOutcome {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    durationMs: 10,
    timedOut: false,
    cancelled: false,
    clipped: false,
    ...over,
  };
}

const PASSING = "test a::one ... ok\ntest a::two ... ok\ntest result: ok. 2 passed; 0 failed;";
const FAILING = "test a::one ... ok\ntest a::two ... FAILED\ntest result: FAILED. 1 passed; 1 failed;";

function suite(output: string, code: number | null): SuiteRun {
  return {
    command: "npm test",
    report: readTestOutput(output, code),
    outcome: outcome({ stdout: output, code }),
  };
}

describe("runSuite", () => {
  it("runs the project's own test command, and only that one", async () => {
    const run = vi.fn().mockResolvedValue(outcome({ stdout: PASSING }));
    const baseline = await runSuite(TASKS, "C:/work", "run-1", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe("npm test");
    expect(run.mock.calls[0][2]).toBe("C:/work");
    expect(baseline.taken).toBe(true);
    if (baseline.taken) expect(baseline.run.report.passed).toBe(true);
  });

  it("runs a member's suite in the member's own folder", async () => {
    const run = vi.fn().mockResolvedValue(outcome({ stdout: PASSING }));
    const member: TaskDef = { ...TASKS[1], id: "api/test", command: "npm test", cwd: "api" };
    await runSuite([member], "C:/work", "run-1", run);

    expect(run.mock.calls[0][2]).toBe("C:/work/api");
  });

  it("measures the whole repository rather than whichever member came first", () => {
    const members: TaskDef[] = [
      { id: "api/test", label: "api · npm test", kind: "test", command: "npm test", cwd: "api" },
      { id: "web/test", label: "web · npm test", kind: "test", command: "npm test", cwd: "web" },
    ];
    // A root suite covers them all, so it wins wherever it sits in the list.
    expect(testTaskOf([...members, TASKS[1]])?.id).toBe("test");
    // With only members to choose from, the first is better than refusing -
    // but it is a member, and the run reports it as the one that was measured.
    expect(testTaskOf(members)?.cwd).toBe("api");
  });

  it("says a project has no test command instead of passing it silently", async () => {
    const run = vi.fn();
    const baseline = await runSuite([TASKS[0]], "C:/work", "run-1", run);

    expect(run).not.toHaveBeenCalled();
    expect(baseline).toEqual({ taken: false, reason: "noTestCommand" });
    // The distinction the whole gate rests on: nothing to check is not a pass.
    expect(gateResolution(baseline)).toBe("none");
  });

  it("tells a suite that failed from a suite that could not be run", async () => {
    const refused = vi.fn().mockRejectedValue(new Error("could not run `npm test` in C:/gone"));
    const baseline = await runSuite(TASKS, "C:/gone", "run-1", refused);

    expect(baseline.taken).toBe(false);
    if (!baseline.taken) {
      expect(baseline.reason).toBe("couldNotRun");
      if (baseline.reason === "couldNotRun") expect(baseline.detail).toContain("npm test");
    }
  });

  it("reports what it can read about this project before anything is changed", async () => {
    const known = await runSuite(
      TASKS,
      "C:/work",
      "run-1",
      vi.fn().mockResolvedValue(outcome({ stdout: PASSING })),
    );
    expect(gateResolution(known)).toBe("named");

    const unknown = await runSuite(
      TASKS,
      "C:/work",
      "run-1",
      vi.fn().mockResolvedValue(outcome({ stdout: "3 examples, 0 failures" })),
    );
    // Verdict only: the suite passed, but nothing here can name its tests.
    expect(gateResolution(unknown)).toBe("verdictOnly");
  });
});

describe("judge", () => {
  it("blocks a test that was passing and is not any more", () => {
    const verdict = judge(suite(PASSING, 0), suite(FAILING, 101));
    expect(verdict.blocks).toBe(true);
    expect(verdict.comparison.broken).toEqual(["a::two"]);
  });

  it("lets through a suite that was already failing in the same place", () => {
    const verdict = judge(suite(FAILING, 101), suite(FAILING, 101));
    expect(verdict.blocks).toBe(false);
    expect(verdict.comparison.alreadyBroken).toEqual(["a::two"]);
    expect(verdict.comparison.broken).toEqual([]);
  });

  it("blocks a verdict that got worse even when no test can be named", () => {
    const verdict = judge(suite("all good", 0), suite("something exploded", 1));
    expect(verdict.blocks).toBe(true);
    expect(verdict.comparison.brokeWithoutDetail).toBe(true);
  });

  it("keeps both runs, so a report can show what was measured", () => {
    const verdict = judge(suite(PASSING, 0), suite(FAILING, 101));
    expect(verdict.before.command).toBe("npm test");
    expect(verdict.after.report.total).toBe(2);
  });
});

/**
 * Verbatim from a real `npm test` run of a sample project, captured with the
 * two streams kept apart the way `exec_run` keeps them. Vitest puts the count
 * on one and the names on the other, which is exactly the trap a reader given
 * a single stream falls into.
 */
const REAL_STDOUT = `
> test
> vitest run

 RUN  v4.1.11 C:/…/sample-app

 ❯ src/cart.test.js (4 tests | 1 failed) 8ms
     × this one is meant to fail 5ms

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
   Start at  17:46:46
   Duration  219ms
`;

const REAL_STDERR = `
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/cart.test.js > withTax > this one is meant to fail
AssertionError: expected 27.5 to be 999 // Object.is equality
`;

describe("a run whose report arrives split across both streams", () => {
  it("is read whole, because the suite is handed both", async () => {
    const split = outcome({ code: 1, stdout: REAL_STDOUT, stderr: REAL_STDERR });
    const baseline = await runSuite(TASKS, "C:/work", "run-1", vi.fn().mockResolvedValue(split));

    expect(baseline.taken).toBe(true);
    if (!baseline.taken) return;
    // The count lives on stdout and the name on stderr; both have to survive.
    expect(baseline.run.report.total).toBe(4);
    expect(baseline.run.report.failed).toEqual(["src/cart.test.js > withTax > this one is meant to fail"]);
    expect(gateResolution(baseline)).toBe("named");
  });

  it("loses the names if it is ever handed one stream alone", () => {
    // Not a wish, a guard: this is what regressing `allOutput` would cost, and
    // the failure would otherwise be silent - a gate reporting no regressions
    // because it could not see them.
    expect(readTestOutput(REAL_STDERR, 1).reader).toBeNull();
    expect(readTestOutput(REAL_STDOUT, 1).failed).toEqual([]);
  });
});

describe("testTaskOf", () => {
  it("picks the test task out of whatever the project declares", () => {
    expect(testTaskOf(TASKS)?.command).toBe("npm test");
    expect(testTaskOf([TASKS[0]])).toBeNull();
  });
});
