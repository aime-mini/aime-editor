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
  it("is the six steps a developer already takes", () => {
    // Named for what a person does, in the order they do it. A run whose steps
    // a reader does not recognise is a run they cannot judge the progress of.
    expect(PHASES.map((phase) => phase.id)).toEqual([
      "understand",
      "design",
      "implement",
      "verify",
      "review",
      "report",
    ]);
  });

  it("measures straight after the phase that can break something", () => {
    // The gate that makes a run safe to walk away from comes right after the
    // phase that writes the change - and it is one phase, because measuring the
    // damage and mending it are one job.
    expect(nextPhase("implement")).toBe("verify");
    // And a review whose findings nobody acts on is a document, not a gate, so
    // the finding and the fixing are one phase too.
    expect(nextPhase("review")).toBe("report");
  });

  it("lets only three phases write, and reads before every one of them", () => {
    const writers = PHASES.filter((phase) => phase.worker === "writer").map((phase) => phase.id);
    expect(writers).toEqual(["implement", "verify", "review"]);
    // Nothing is written before the reader has agreed to the page the design
    // phase produces.
    const order = PHASES.map((phase) => phase.id);
    expect(order.indexOf("design")).toBeLessThan(order.indexOf("implement"));
    expect(phaseAt("understand").worker).toBe("reader");
    expect(phaseAt("design").worker).toBe("reader");
  });

  it("takes no model's word in the phase that hands over", () => {
    // The report is assembled from files on disk and gate verdicts, so there is
    // nothing in it a model could have imagined.
    expect(phaseAt("report").worker).toBe("tools");
  });

  it("puts the cheap mistakes first", () => {
    const order = PHASES.map((phase) => phase.id);
    expect(order.indexOf("understand")).toBeLessThan(order.indexOf("design"));
    expect(order.indexOf("design")).toBeLessThan(order.indexOf("implement"));
    expect(order[0]).toBe("understand");
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

  it("lets the review phase end a run, because some findings are not opinions", () => {
    // Code sitting in the wrong layer does not belong in the repository however
    // well it works, so an unfixed architecture or security finding is fatal.
    // Which findings those are is the phase's own judgement - it returns
    // "passed" for everything a reviewer might merely be wrong about.
    expect(phaseAt("review").blocking).toBe(true);
    expect(mayContinue("review", { state: "blocked", summary: "" })).toBe(false);
  });

  it("does not end a run over a phase whose refusal is only news", () => {
    expect(phaseAt("report").blocking).toBe(false);
    expect(mayContinue("report", { state: "blocked", summary: "" })).toBe(true);
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
    const stopped = abandonRest(runWith({ understand: "passed" }), "understand", "skipped", "");
    expect(stopped.results.design?.state).toBe("skipped");
    expect(stopped.results.report?.state).toBe("skipped");
    expect(stopped.current).toBeNull();
    // What already happened is left alone.
    expect(stopped.results.understand?.state).toBe("passed");
  });
});

describe("progressOf", () => {
  it("counts what is genuinely behind it, and nothing else", () => {
    expect(progressOf(runWith({}))).toEqual({ done: 0, total: PHASES.length });
    // A skipped phase is behind us; a blocked one is not progress.
    expect(progressOf(runWith({ understand: "passed", design: "skipped", implement: "blocked" }))).toEqual({
      done: 2,
      total: PHASES.length,
    });
  });
});
