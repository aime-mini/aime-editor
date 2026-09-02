import { describe, expect, it, vi } from "vitest";
import type { CommandOutcome } from "./exec";
import {
  gateResolution,
  judge,
  runSuites,
  skipList,
  tally,
  testTasksOf,
  unusable,
  wentRed,
  type Baseline,
} from "./regressionGate";
import { readTestOutput } from "./testReport";
import type { TaskDef } from "../stores/tasks";

const UNIT: TaskDef = { id: "node.test", label: "npm test", kind: "test", command: "npm test" };
const E2E: TaskDef = {
  id: "node.test:e2e",
  label: "npm test:e2e",
  kind: "test",
  command: "npm run test:e2e",
};
const BUILD: TaskDef = { id: "node.build", label: "npm build", kind: "build", command: "npm run build" };

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

/** The command each call was given, which is the thing these tests are about. */
function commandsOf(run: { mock: { calls: unknown[][] } }): string[] {
  return run.mock.calls.map((call) => String(call[1]));
}

let ids = 0;
const nextId = () => `run-cmd-${String((ids += 1))}`;

/** One pass whose suites answered with the given outputs, in order. */
async function pass(tasks: TaskDef[], outputs: (readonly [string, number | null])[]): Promise<Baseline> {
  const run = vi.fn();
  for (const [stdout, code] of outputs) run.mockResolvedValueOnce(outcome({ stdout, code }));
  return runSuites(tasks, "C:/work", nextId, run);
}

describe("runSuites", () => {
  it("runs EVERY test command the project declares, not the first one", async () => {
    const run = vi.fn().mockResolvedValue(outcome({ stdout: PASSING }));
    const baseline = await runSuites([BUILD, UNIT, E2E], "C:/work", nextId, run);

    // The hole this closes: a repository that separates unit tests from
    // end-to-end tests was being reported on after half of it was measured.
    expect(commandsOf(run)).toEqual(["npm test", "npm run test:e2e"]);
    expect(baseline.suites).toHaveLength(2);
    expect(tally(baseline).passed).toBe(true);
  });

  it("runs a member's suite in the member's own folder", async () => {
    const run = vi.fn().mockResolvedValue(outcome({ stdout: PASSING }));
    await runSuites([{ ...UNIT, id: "api/node.test", cwd: "api" }], "C:/work", nextId, run);

    expect(run.mock.calls[0][2]).toBe("C:/work/api");
  });

  it("says a project has no test command instead of passing it silently", async () => {
    const run = vi.fn();
    const baseline = await runSuites([BUILD], "C:/work", nextId, run);

    expect(run).not.toHaveBeenCalled();
    expect(baseline.suites).toEqual([]);
    // The distinction the whole gate rests on: nothing to check is not a pass.
    expect(gateResolution(baseline)).toBe("none");
  });

  it("tells a suite that failed from one that could not be run", async () => {
    const refused = vi.fn().mockRejectedValue(new Error("could not run `npm test` in C:/gone"));
    const baseline = await runSuites([UNIT], "C:/gone", nextId, refused);

    expect(baseline.suites[0].run).toBeNull();
    expect(baseline.suites[0].silence?.reason).toBe("couldNotRun");
    expect(baseline.suites[0].silence?.detail).toContain("npm test");
  });

  it("treats a suite killed at the time limit as unmeasured, never as failing", async () => {
    // A watcher, or a browser suite waiting on a server that never came up.
    // Counting it red would blame the change for something it did not do; and
    // the skip list is what stops the repair loop paying that timeout again.
    const hung = vi.fn().mockResolvedValue(outcome({ code: null, timedOut: true }));
    const baseline = await runSuites([UNIT], "C:/work", nextId, hung);

    expect(baseline.suites[0].silence?.reason).toBe("didNotFinish");
    expect(unusable(baseline)).toHaveLength(1);
    expect(skipList(baseline).has("node.test")).toBe(true);

    const again = vi.fn();
    await runSuites([UNIT], "C:/work", nextId, again, skipList(baseline));
    expect(again).not.toHaveBeenCalled();
  });

  it("blocks a test that was passing and is not any more, naming its suite", async () => {
    const before = await pass([UNIT, E2E], [[PASSING, 0] as const, [PASSING, 0] as const]);
    const after = await pass([UNIT, E2E], [[PASSING, 0] as const, [FAILING, 101] as const]);
    const verdict = judge(before, after);

    expect(verdict.blocks).toBe(true);
    expect(verdict.suites.map((suite) => suite.comparison.broken)).toEqual([[], ["a::two"]]);
    expect(verdict.suites[1].label).toBe("npm test:e2e");
  });

  it("lets through a suite that was already failing in the same place", async () => {
    const before = await pass([UNIT], [[FAILING, 101] as const]);
    const after = await pass([UNIT], [[FAILING, 101] as const]);
    const verdict = judge(before, after);

    expect(verdict.blocks).toBe(false);
    expect(verdict.suites[0].comparison.alreadyBroken).toEqual(["a::two"]);
    expect(verdict.suites[0].comparison.broken).toEqual([]);
  });

  it("blocks a verdict that got worse even when no test can be named", async () => {
    const before = await pass([UNIT], [["all good", 0] as const]);
    const after = await pass([UNIT], [["something exploded", 1] as const]);

    expect(judge(before, after).blocks).toBe(true);
    expect(judge(before, after).suites[0].comparison.brokeWithoutDetail).toBe(true);
  });

  it("compares suites by id, so a skipped one is reported and not mismatched", async () => {
    const before = await pass([UNIT, E2E], [[PASSING, 0] as const, [PASSING, 0] as const]);
    // The second pass ran only the first suite; the second went quiet.
    const after = await pass([UNIT], [[PASSING, 0] as const]);
    const verdict = judge(before, after);

    expect(verdict.suites.map((suite) => suite.id)).toEqual(["node.test"]);
    expect(verdict.silent).toEqual([]);

    const timedOut = await runSuites(
      [UNIT, E2E],
      "C:/work",
      nextId,
      vi
        .fn()
        .mockResolvedValueOnce(outcome({ stdout: PASSING }))
        .mockResolvedValueOnce(outcome({ code: null, timedOut: true })),
    );
    const second = judge(before, timedOut);
    // A suite that answered before and answers nothing now is something the
    // change did, so it blocks rather than quietly leaving the verdict.
    expect(second.silent.map((suite) => suite.id)).toEqual(["node.test:e2e"]);
    expect(second.blocks).toBe(true);
  });

  it("recognises going red, which is what makes a test worth having", async () => {
    const before = await pass([UNIT], [[PASSING, 0] as const]);
    const green = judge(before, await pass([UNIT], [[PASSING, 0] as const]));
    const red = judge(before, await pass([UNIT], [[FAILING, 101] as const]));

    expect(wentRed(green)).toBe(false);
    expect(wentRed(red)).toBe(true);
  });

  it("adds up what every suite measured rather than quoting one of them", async () => {
    const both = await pass([UNIT, E2E], [[PASSING, 0] as const, [FAILING, 101] as const]);

    expect(tally(both)).toEqual({ passed: false, failed: 1, total: 4 });
  });

  it("keeps both runs of each suite, so a report can show what was measured", async () => {
    const before = await pass([UNIT], [[PASSING, 0] as const]);
    const verdict = judge(before, await pass([UNIT], [[FAILING, 101] as const]));

    expect(verdict.suites[0].before.command).toBe("npm test");
    expect(verdict.suites[0].after.report.total).toBe(2);
  });
});

describe("testTasksOf", () => {
  it("takes every suite and nothing else", () => {
    expect(testTasksOf([BUILD, UNIT, E2E]).map((task) => task.id)).toEqual(["node.test", "node.test:e2e"]);
    expect(testTasksOf([BUILD])).toEqual([]);
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
    const baseline = await runSuites([UNIT], "C:/work", nextId, vi.fn().mockResolvedValue(split));
    const report = baseline.suites[0].run?.report;

    // The count lives on stdout and the name on stderr; both have to survive.
    expect(report?.total).toBe(4);
    expect(report?.failed).toEqual(["src/cart.test.js > withTax > this one is meant to fail"]);
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

describe("gateResolution", () => {
  it("says up front how much this project's suites can be read", async () => {
    const named = await pass([UNIT], [[PASSING, 0] as const]);
    expect(gateResolution(named)).toBe("named");

    const unreadable = await pass([UNIT], [["3 examples, 0 failures", 0] as const]);
    // Verdict only: the suite passed, but nothing here can name its tests.
    expect(gateResolution(unreadable)).toBe("verdictOnly");
  });
});
