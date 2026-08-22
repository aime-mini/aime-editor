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
  it("checks straight after every phase that can break something", () => {
    const writers = PHASES.filter((phase) => phase.worker === "writer").map((phase) => phase.id);
    expect(writers).toEqual(["implement", "repair"]);
    // The gate that makes a run safe to walk away from comes right after the
    // phase that writes the change, and the phase that fixes what it broke
    // comes right after the gate.
    expect(nextPhase("implement")).toBe("regression");
    expect(nextPhase("regression")).toBe("repair");
  });

  it("puts the cheap mistakes first", () => {
    const order = PHASES.map((phase) => phase.id);
    expect(order.indexOf("understand")).toBeLessThan(order.indexOf("plan"));
    expect(order.indexOf("plan")).toBeLessThan(order.indexOf("implement"));
    expect(order[0]).toBe("baseline");
  });

  it("ends", () => {
    expect(nextPhase("report")).toBeNull();
  });
});

describe("mayContinue", () => {
  it("stops the run only where stopping is the last resort", () => {
    // `repair` is the one that can refuse, and only after it has tried: this
    // is where a run admits it could not finish the task.
    expect(mayContinue("repair", { state: "blocked", summary: "" })).toBe(false);
    expect(mayContinue("plan", { state: "blocked", summary: "" })).toBe(false);
  });

  it("does not end a run over a phase whose refusal is only news", () => {
    // Finding a regression is not the same as giving up on it - `repair` gets
    // that news and does something about it - and a reviewer that found
    // something has found something, not grounds to throw away a change whose
    // tests all pass.
    expect(phaseAt("regression").blocking).toBe(false);
    expect(phaseAt("review").blocking).toBe(false);
    expect(mayContinue("regression", { state: "blocked", summary: "" })).toBe(true);
    expect(mayContinue("review", { state: "blocked", summary: "" })).toBe(true);
    expect(mayContinue("locate", { state: "blocked", summary: "" })).toBe(true);
  });

  it("never carries on past a cancel, whatever the phase", () => {
    expect(mayContinue("review", { state: "cancelled", summary: "" })).toBe(false);
  });

  it("carries on after a phase that had nothing to do", () => {
    // Nothing broke, so there was nothing for `repair` to fix.
    expect(mayContinue("repair", { state: "skipped", summary: "" })).toBe(true);
  });
});

describe("abandonRest", () => {
  it("marks the phases that never got their turn rather than leaving them blank", () => {
    const stopped = abandonRest(runWith({ baseline: "passed" }), "understand", "skipped", "");
    expect(stopped.results.plan?.state).toBe("skipped");
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
    expect(progressOf(runWith({ baseline: "passed", understand: "skipped", locate: "blocked" }))).toEqual({
      done: 2,
      total: PHASES.length,
    });
  });
});
