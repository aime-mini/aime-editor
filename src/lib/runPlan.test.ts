import { describe, expect, it } from "vitest";
import {
  abandonRest,
  mayContinue,
  newRun,
  nextPhase,
  phaseAt,
  progressOf,
  PHASES,
  type PhaseId,
  type Run,
} from "./runPlan";

function runWith(results: Partial<Record<PhaseId, "passed" | "blocked" | "skipped">>): Run {
  const run = newRun("run-1", "42", "Login forgets the language", 0);
  return {
    ...run,
    results: Object.fromEntries(Object.entries(results).map(([id, state]) => [id, { state, summary: "" }])),
  };
}

describe("the phase list", () => {
  it("measures straight after the phase that can break something", () => {
    const writers = PHASES.filter((phase) => phase.worker === "writer").map((phase) => phase.id);
    expect(writers).toEqual(["tests", "implement", "verify", "polish", "deliver"]);
    // The gate that makes a run safe to walk away from comes right after the
    // phase that writes the change - and it is one phase, because measuring the
    // damage and mending it are one job.
    expect(nextPhase("implement")).toBe("verify");
    // And a review whose findings nobody acts on is a document, not a gate.
    expect(nextPhase("review")).toBe("polish");
  });

  it("deploys the polished code, and only then hands over", () => {
    // "Done" means deployed and seen working. Deliver comes after polish so
    // what gets deployed is the final code, and before report so the case
    // table can count the evidence deliver produced.
    expect(nextPhase("polish")).toBe("deliver");
    expect(nextPhase("deliver")).toBe("report");
  });

  it("agrees what proof looks like before it writes any of it", () => {
    const order = PHASES.map((phase) => phase.id);
    // The cases and the plan are settled on the page the reader approves...
    expect(order.indexOf("design")).toBeLessThan(order.indexOf("tests"));
    // ...and the tests go in before the code, which is what makes red-then-green
    // something that can be measured rather than promised.
    expect(order.indexOf("tests")).toBeLessThan(order.indexOf("implement"));
  });

  it("puts the cheap mistakes first", () => {
    const order = PHASES.map((phase) => phase.id);
    expect(order.indexOf("understand")).toBeLessThan(order.indexOf("design"));
    expect(order.indexOf("design")).toBeLessThan(order.indexOf("implement"));
    expect(order[0]).toBe("baseline");
  });

  it("ends", () => {
    expect(nextPhase("report")).toBeNull();
  });
});

describe("mayContinue", () => {
  it("stops the run only where stopping is the last resort", () => {
    // `verify` is the one that can refuse, and only after it has tried to mend
    // what it found: this is where a run admits it could not finish the task.
    expect(mayContinue("verify", { state: "blocked", summary: "" })).toBe(false);
    expect(mayContinue("design", { state: "blocked", summary: "" })).toBe(false);
  });

  it("does not end a run over a phase whose refusal is only news", () => {
    // A reviewer that found something has found something, not grounds to throw
    // away a change whose tests all pass.
    expect(phaseAt("review").blocking).toBe(false);
    expect(mayContinue("review", { state: "blocked", summary: "" })).toBe(true);
    expect(mayContinue("polish", { state: "blocked", summary: "" })).toBe(true);
  });

  it("never carries on past a cancel, whatever the phase", () => {
    expect(mayContinue("review", { state: "cancelled", summary: "" })).toBe(false);
  });

  it("carries on after a phase that had nothing to do", () => {
    // A project that declares no test and no check command has nothing for
    // `verify` to measure, which is not the same as `verify` refusing.
    expect(mayContinue("verify", { state: "skipped", summary: "" })).toBe(true);
  });
});

describe("abandonRest", () => {
  it("marks the phases that never got their turn rather than leaving them blank", () => {
    const stopped = abandonRest(runWith({ baseline: "passed" }), "understand", "skipped", "");
    expect(stopped.results.design?.state).toBe("skipped");
    expect(stopped.results.report?.state).toBe("skipped");
    expect(stopped.current).toBeNull();
    // What already happened is left alone.
    expect(stopped.results.baseline?.state).toBe("passed");
  });
});

describe("progressOf", () => {
  it("counts what is genuinely behind it, and nothing else", () => {
    expect(progressOf(runWith({}))).toEqual({ done: 0, total: PHASES.length });
    // A skipped phase is behind us; a blocked one is not progress.
    expect(progressOf(runWith({ baseline: "passed", understand: "skipped", design: "blocked" }))).toEqual({
      done: 2,
      total: PHASES.length,
    });
  });
});
