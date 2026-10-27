import { describe, expect, it } from "vitest";
import {
  withoutReplays,
  runFlow,
  type Ask,
  type RunEvent,
  type RunOptions,
  type StepContext,
  type StepResult,
} from "./engine";
import { DEFAULT_SETTINGS, FLOW_VERSION, type Flow, type Step, type StepConfig, type Wire } from "./model";

/** A step with sensible defaults; the test says only what matters. */
function step(id: string, config: StepConfig, extra: Partial<Step> = {}): Step {
  return { id, name: id, does: `do ${id}`, config, onError: "stop", retries: 0, ...extra };
}

function flowOf(steps: Step[], wires: Wire[], settings: Partial<Flow["settings"]> = {}): Flow {
  return {
    version: FLOW_VERSION,
    name: "test",
    description: "",
    input: { hints: [] },
    steps: [step("input", { ability: "input" }), ...steps],
    wires,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

const wire = (from: string, to: string, port = "out", maxRounds?: number): Wire => ({
  from,
  to,
  port,
  maxRounds,
});

const bundle = { text: "hello", items: [], params: {} };

/**
 * An executor that answers from a script: `behaviour[stepId]` is called with
 * the context and returns a result, or throws. Every call is remembered.
 */
function harness(
  flow: Flow,
  behaviour: Partial<Record<string, (context: StepContext) => StepResult | Promise<StepResult>>>,
  extra: Partial<RunOptions> = {},
) {
  const calls: { step: string; round: number; attempt: number; input: string[] }[] = [];
  const events: RunEvent[] = [];
  let tick = 0;
  const options: RunOptions = {
    flow,
    bundle,
    root: "/w",
    workRoot: "/w",
    platform: "linux",
    executors: {
      run: async (context) => {
        calls.push({
          step: context.step.id,
          round: context.round,
          attempt: context.attempt,
          input: Object.keys(context.input).sort(),
        });
        if (context.step.config.ability === "input") {
          return { output: { value: context.bundle, files: [], summary: "input" } };
        }
        const act = behaviour[context.step.id];
        if (act === undefined)
          return { output: { value: context.step.id, files: [], summary: context.step.id } };
        return act(context);
      },
    },
    ask: () => Promise.reject(new Error("nobody to ask")),
    confirmCost: () => Promise.resolve(false),
    journal: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    signal: new AbortController().signal,
    now: () => {
      tick += 1;
      return tick;
    },
    ...extra,
  };
  return { options, calls, events };
}

const text = (value: string): StepResult => ({ output: { value, files: [], summary: value } });

describe("runFlow", () => {
  it("runs a line of steps in order, each with the one before it as input", async () => {
    const flow = flowOf(
      [
        step("a", { ability: "ai", permission: "readOnly" }),
        step("b", { ability: "ai", permission: "readOnly" }),
      ],
      [wire("input", "a"), wire("a", "b")],
    );
    const { options, calls, events } = harness(flow, {
      a: () => text("A"),
      b: (c) => text(`B after ${(c.input.a as { value: string }).value}`),
    });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(calls.map((call) => call.step)).toEqual(["input", "a", "b"]);
    expect(calls[2].input).toEqual(["a"]);
    expect(outcome.outputs.get("b")?.value).toBe("B after A");
    expect(events.map((event) => event.kind)).toEqual([
      "run-started",
      "step-started",
      "step-done",
      "step-started",
      "step-done",
      "step-started",
      "step-done",
      "run-done",
    ]);
  });

  it("gives a step every earlier output to resolve, not only the ones wired into it", async () => {
    const flow = flowOf(
      [
        step("analyse", { ability: "ai", permission: "readOnly" }),
        step("design", { ability: "ai", permission: "edits" }),
        step("list", { ability: "transform", program: ".analyse.value" }),
      ],
      [wire("input", "analyse"), wire("analyse", "design"), wire("design", "list")],
    );
    let settled: string[] = [];
    const { options } = harness(flow, {
      list: (c) => {
        settled = Object.keys(c.settled).sort();
        return text("listed");
      },
    });
    await runFlow(options);
    expect(settled).toEqual(["analyse", "design", "input"]);
  });

  it("runs branches in parallel and joins them once both are in", async () => {
    const flow = flowOf(
      [
        step("left", { ability: "ai", permission: "readOnly" }),
        step("right", { ability: "ai", permission: "readOnly" }),
        step("join", { ability: "ai", permission: "readOnly" }),
      ],
      [wire("input", "left"), wire("input", "right"), wire("left", "join"), wire("right", "join")],
    );
    let leftDone = false;
    const { options, calls } = harness(flow, {
      left: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        leftDone = true;
        return text("L");
      },
      right: () => text("R"),
      join: (c) => {
        expect(leftDone).toBe(true);
        return text(Object.keys(c.input).sort().join("+"));
      },
    });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(outcome.outputs.get("join")?.value).toBe("left+right");
    expect(calls.filter((call) => call.step === "join")).toHaveLength(1);
  });

  it("takes one branch of a gate and skips what only the other would have reached", async () => {
    const flow = flowOf(
      [
        step("gate", {
          ability: "gate",
          branches: [
            { label: "yes", program: "true" },
            { label: "no", program: "false" },
          ],
        }),
        step("onYes", { ability: "ai", permission: "readOnly" }),
        step("onNo", { ability: "ai", permission: "readOnly" }),
        step("after", { ability: "ai", permission: "readOnly" }),
      ],
      [
        wire("input", "gate"),
        wire("gate", "onYes", "yes"),
        wire("gate", "onNo", "no"),
        wire("onYes", "after"),
        wire("onNo", "after"),
      ],
    );
    const { options, calls, events } = harness(flow, { gate: () => ({ ...text("gate"), branch: "no" }) });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(calls.map((call) => call.step)).toEqual(["input", "gate", "onNo", "after"]);
    expect(
      events.filter((event) => event.kind === "skipped").map((event) => (event as { step: string }).step),
    ).toEqual(["onYes"]);
    // The join ran on the one live branch.
    expect(calls.at(-1)?.input).toEqual(["onNo"]);
  });

  it("loops back as many rounds as the wire allows, then fails the step that kept asking", async () => {
    const flow = flowOf(
      [
        step("fix", { ability: "ai", permission: "edits" }),
        step("test", { ability: "command", command: { all: [{ program: "x", args: [] }] } }),
        step("gate", {
          ability: "gate",
          branches: [
            { label: "green", program: "." },
            { label: "red", program: "." },
          ],
        }),
        step("pr", { ability: "ai", permission: "readOnly" }),
      ],
      [
        wire("input", "fix"),
        wire("fix", "test"),
        wire("test", "gate"),
        wire("gate", "fix", "red", 2),
        wire("gate", "pr", "green"),
      ],
    );
    let runs = 0;
    const { options, calls } = harness(flow, {
      test: () => {
        runs += 1;
        return text(`run ${String(runs)}`);
      },
      gate: () => ({ ...text("gate"), branch: runs >= 3 ? "green" : "red" }),
    });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(calls.filter((call) => call.step === "fix").map((call) => call.round)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.step).at(-1)).toBe("pr");

    // Never green: the third red exceeds the two rounds allowed.
    runs = 0;
    const forever = harness(flow, { gate: () => ({ ...text("gate"), branch: "red" }) });
    const stuck = await runFlow(forever.options);
    expect(stuck.status).toBe("failed");
    expect(stuck.error).toContain("loop limit reached");
    expect(forever.calls.filter((call) => call.step === "fix")).toHaveLength(3);
  });

  it("retries a failing step, then follows its error wire when it has one", async () => {
    const flow = flowOf(
      [
        step("flaky", { ability: "ai", permission: "readOnly" }, { retries: 2, onError: "errorWire" }),
        step("report", { ability: "ai", permission: "readOnly" }),
        step("next", { ability: "ai", permission: "readOnly" }),
      ],
      [wire("input", "flaky"), wire("flaky", "report", "error"), wire("flaky", "next")],
    );
    const { options, calls, events } = harness(flow, {
      flaky: () => {
        throw new Error("service down");
      },
      report: (c) => text((c.input.flaky as { value: { error: string } }).value.error),
    });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(calls.filter((call) => call.step === "flaky").map((call) => call.attempt)).toEqual([1, 2, 3]);
    expect(outcome.outputs.get("report")?.value).toBe("service down");
    expect(calls.some((call) => call.step === "next")).toBe(false);
    const finals = events.filter((event) => event.kind === "step-failed" && event.final);
    expect(finals).toHaveLength(1);

    // The same failure with no error wire stops the run.
    const stop = flowOf([step("flaky", { ability: "ai", permission: "readOnly" })], [wire("input", "flaky")]);
    const stopped = await runFlow(
      harness(stop, {
        flaky: () => {
          throw new Error("service down");
        },
      }).options,
    );
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toBe("flaky: service down");
  });

  it("runs a for-each a few items at a time, skips the failed ones when told, and joins the rest in order", async () => {
    const flow = flowOf(
      [
        step("list", { ability: "transform", program: "." }),
        step("each", { ability: "ai", permission: "readOnly" }, { forEach: true, onError: "skipItems" }),
      ],
      [wire("input", "list"), wire("list", "each")],
      { parallel: 2 },
    );
    let running = 0;
    let mostAtOnce = 0;
    const { options, events } = harness(flow, {
      list: () => ({ output: { value: [1, 2, 3, 4, 5], files: [], summary: "5" } }),
      each: async (c) => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        const item = (c.input.item as { value: number }).value;
        if (item === 3) throw new Error("odd one out");
        return {
          output: { value: item * 10, files: [`f${String(item)}`], summary: String(item) },
          costUsd: 0.1,
        };
      },
    });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(mostAtOnce).toBe(2);
    expect(outcome.outputs.get("each")?.value).toEqual([10, 20, null, 40, 50]);
    expect(outcome.outputs.get("each")?.files).toEqual(["f1", "f2", "f4", "f5"]);
    expect(outcome.outputs.get("each")?.summary).toBe("4 of 5 items, 1 failed");
    expect(outcome.costUsd).toBeCloseTo(0.4);
    expect(events.filter((event) => event.kind === "item-failed")).toHaveLength(1);
  });

  it("runs the items of a step that changes files one at a time, whatever the flow allows", async () => {
    const flow = flowOf(
      [
        step("list", { ability: "transform", program: "." }),
        step("build", { ability: "ai", permission: "full" }, { forEach: true }),
      ],
      [wire("input", "list"), wire("list", "build")],
      { parallel: 3 },
    );
    let running = 0;
    let mostAtOnce = 0;
    const { options } = harness(flow, {
      list: () => ({ output: { value: ["catalogue", "cart", "checkout"], files: [], summary: "3" } }),
      build: async (c) => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return text((c.input.item as { value: string }).value);
      },
    });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(mostAtOnce).toBe(1);
    expect(outcome.outputs.get("build")?.value).toEqual(["catalogue", "cart", "checkout"]);
  });

  it("asks a person, records the answer, and declines end the run quietly", async () => {
    const flow = flowOf(
      [
        step("ok", { ability: "human", mode: "approve" }),
        step("after", { ability: "ai", permission: "readOnly" }),
      ],
      [wire("input", "ok"), wire("ok", "after")],
    );
    const asked: Ask[] = [];
    const approving = harness(
      flow,
      {},
      {
        ask: (_step, ask) => {
          asked.push(ask);
          return Promise.resolve({ approved: true, note: "go" });
        },
      },
    );
    const outcome = await runFlow(approving.options);
    expect(outcome.status).toBe("done");
    expect(asked[0].mode).toBe("approve");
    expect(approving.events.map((event) => event.kind)).toContain("waiting");
    expect(approving.events.map((event) => event.kind)).toContain("answered");
    expect(approving.calls.some((call) => call.step === "after")).toBe(true);

    const declining = harness(
      flow,
      {},
      { ask: () => Promise.resolve({ approved: false, note: "not like this" }) },
    );
    const declined = await runFlow(declining.options);
    expect(declined.status).toBe("failed");
    expect(declined.error).toBe("ok: not like this");
    expect(declining.calls.some((call) => call.step === "after")).toBe(false);
  });

  it("asks the person about what earlier steps produced, however far back, not about placeholders", async () => {
    const flow = flowOf(
      [
        step("analyse", { ability: "ai", permission: "readOnly", json: true }),
        step("design", { ability: "ai", permission: "edits" }),
        step(
          "ok",
          { ability: "human", mode: "approve" },
          { does: "Stack: {{analyse.value.stack}}. {{design.summary}}. Go?" },
        ),
      ],
      // Nothing wires the analysis into the question: it is two steps back.
      [wire("input", "analyse"), wire("analyse", "design"), wire("design", "ok")],
    );
    const asked: Ask[] = [];
    const { options } = harness(
      flow,
      { analyse: () => ({ output: { value: { stack: "Express + SQLite" }, files: [], summary: "" } }) },
      {
        ask: (_step, ask) => {
          asked.push(ask);
          return Promise.resolve({ approved: true, note: "" });
        },
      },
    );
    await runFlow(options);
    expect(asked[0].prompt).toBe("Stack: Express + SQLite. design. Go?");
  });

  it("carries on from its journal: what was settled is replayed, not redone, and an answer is not asked twice", async () => {
    const flow = flowOf(
      [
        step("a", { ability: "ai", permission: "readOnly" }),
        step("ok", { ability: "human", mode: "approve" }),
        step("b", { ability: "ai", permission: "readOnly" }),
      ],
      [wire("input", "a"), wire("a", "ok"), wire("ok", "b")],
    );
    // The first attempt: a ran, the person approved, then the app closed during b.
    const first = harness(
      flow,
      {
        a: () => ({ ...text("A"), costUsd: 0.5 }),
        b: () => {
          throw new Error("the app closed");
        },
      },
      { ask: () => Promise.resolve(true) },
    );
    await runFlow(first.options);
    const journal = first.events.filter((event) => event.kind !== "run-done");

    const second = harness(
      flow,
      { a: () => text("A again, which must not happen"), b: () => text("B") },
      {
        ask: () => Promise.reject(new Error("asked again")),
        resumeFrom: journal,
      },
    );
    const outcome = await runFlow(second.options);
    expect(outcome.status).toBe("done");
    expect(second.calls.map((call) => call.step)).toEqual(["b"]);
    expect(outcome.outputs.get("a")?.value).toBe("A");
    expect(outcome.outputs.get("b")?.value).toBe("B");
    expect(second.events.some((event) => event.kind === "run-started")).toBe(false);
    // What is replayed is already in the journal: only b is written, and a's cost counts once.
    expect(
      second.events
        .filter((event) => event.kind === "step-done")
        .map((event) => (event as { step: string }).step),
    ).toEqual(["b"]);
    expect(outcome.costUsd).toBeCloseTo(0.5);
  });

  it("pauses at the cost limit and goes on only when told to", async () => {
    const flow = flowOf(
      [
        step("a", { ability: "ai", permission: "readOnly" }),
        step("b", { ability: "ai", permission: "readOnly" }),
      ],
      [wire("input", "a"), wire("a", "b")],
      { costLimitUsd: 1 },
    );
    const priced = (costUsd: number) => (): StepResult => ({ ...text("x"), costUsd });
    const asked: number[] = [];
    const goOn = harness(
      flow,
      { a: priced(1.2), b: priced(0.8) },
      {
        confirmCost: (spent) => {
          asked.push(spent);
          return Promise.resolve(true);
        },
      },
    );
    const outcome = await runFlow(goOn.options);
    expect(outcome.status).toBe("done");
    // Asked once, after a; going on allows as much again, which b stays within.
    expect(asked).toEqual([1.2]);
    expect(goOn.events.filter((event) => event.kind === "run-paused")).toHaveLength(1);
    expect(outcome.costUsd).toBeCloseTo(2);

    const stop = harness(
      flow,
      { a: priced(1.2), b: priced(0.8) },
      { confirmCost: () => Promise.resolve(false) },
    );
    const stopped = await runFlow(stop.options);
    expect(stopped.status).toBe("cancelled");
    expect(stop.calls.some((call) => call.step === "b")).toBe(false);
  });

  it("retries only the items that failed, keeping the ones a for-each already finished", async () => {
    const flow = flowOf(
      [
        step("list", { ability: "transform", program: "." }),
        step("build", { ability: "ai", permission: "full" }, { forEach: true, retries: 1 }),
      ],
      [wire("input", "list"), wire("list", "build")],
    );
    const built: string[] = [];
    let cartFailed = false;
    const { options } = harness(flow, {
      list: () => ({ output: { value: ["catalogue", "cart", "checkout"], files: [], summary: "3" } }),
      build: (c) => {
        const feature = (c.input.item as { value: string }).value;
        built.push(feature);
        if (feature === "cart" && !cartFailed) {
          cartFailed = true;
          throw new Error("the AI CLI exited with 1");
        }
        return text(feature);
      },
    });
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("done");
    expect(built).toEqual(["catalogue", "cart", "cart", "checkout"]);
    expect(outcome.outputs.get("build")?.value).toEqual(["catalogue", "cart", "checkout"]);
  });

  it("stops a long for-each at the cost limit between items, not after the last one", async () => {
    const flow = flowOf(
      [
        step("list", { ability: "transform", program: "." }),
        step("build", { ability: "ai", permission: "full" }, { forEach: true }),
      ],
      [wire("input", "list"), wire("list", "build")],
      { costLimitUsd: 2.5 },
    );
    const asked: number[] = [];
    const { options, calls } = harness(
      flow,
      {
        list: () => ({ output: { value: [1, 2, 3, 4, 5, 6], files: [], summary: "6" } }),
        build: () => ({ ...text("built"), costUsd: 1 }),
      },
      {
        confirmCost: (spent) => {
          asked.push(spent);
          return Promise.resolve(false);
        },
      },
    );
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("cancelled");
    expect(asked).toEqual([3]);
    expect(calls.filter((call) => call.step === "build")).toHaveLength(3);
  });

  it("stops everything when cancelled, and a step's timeout reaches its executor", async () => {
    const controller = new AbortController();
    const flow = flowOf(
      [step("slow", { ability: "ai", permission: "readOnly" }, { timeoutMs: 30 })],
      [wire("input", "slow")],
    );
    const { options, events } = harness(
      flow,
      {
        slow: (c) =>
          new Promise((_resolve, reject) => {
            c.signal.addEventListener("abort", () => {
              reject(c.signal.reason instanceof Error ? c.signal.reason : new Error("aborted"));
            });
          }),
      },
      { signal: controller.signal },
    );
    const outcome = await runFlow(options);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("timed out after 30 ms");
    expect(events.at(-1)?.kind).toBe("run-done");

    const forever = harness(
      flow,
      { slow: () => new Promise(() => undefined) },
      { signal: controller.signal },
    );
    const running = runFlow(forever.options);
    setTimeout(() => {
      controller.abort();
    }, 10);
    const cancelled = await running;
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("withoutReplays", () => {
  it("drops what an older build wrote again for a replayed step, so it neither runs again nor costs twice", () => {
    const started = (step: string, round: number): RunEvent => ({
      kind: "step-started",
      step,
      round,
      attempt: 1,
      at: 0,
    });
    const done = (step: string, round: number, costUsd: number): RunEvent => ({
      kind: "step-done",
      step,
      round,
      output: { value: null, files: [], summary: "" },
      costUsd,
      at: 0,
    });
    const journal = [
      started("analyse", 1),
      done("analyse", 1, 0.5),
      started("fix", 1),
      done("fix", 1, 1),
      // the resume: both replayed, then the loop's next round for real
      started("analyse", 1),
      done("analyse", 1, 0.5),
      started("fix", 2),
      done("fix", 2, 1),
    ];

    expect(withoutReplays(journal)).toEqual([
      started("analyse", 1),
      done("analyse", 1, 0.5),
      started("fix", 1),
      done("fix", 1, 1),
      started("fix", 2),
      done("fix", 2, 1),
    ]);
  });
});
