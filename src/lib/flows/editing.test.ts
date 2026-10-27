import { describe, expect, it } from "vitest";
import {
  addStep,
  disconnect,
  duplicateSteps,
  fragmentOf,
  insertOnWire,
  pasteFragment,
  removeSteps,
} from "./editing";
import { freshStepName } from "./ids";
import { COLUMN_STEP } from "./layout";
import { emptyFlow, type Flow, type Step } from "./model";

const step = (id: string, overrides: Partial<Step> = {}): Step => ({
  id,
  name: id,
  does: "",
  config: { ability: "wait", seconds: 1 },
  onError: "stop",
  retries: 0,
  ...overrides,
});

/** input → a → b, each placed. */
function line(): Flow {
  const flow = emptyFlow("Line");
  return {
    ...flow,
    steps: [...flow.steps, step("a"), step("b", { config: { ability: "transform", program: ".a.value" } })],
    wires: [
      { from: "input", port: "out", to: "a" },
      { from: "a", port: "out", to: "b" },
    ],
    layout: { input: { x: 0, y: 0 }, a: { x: 250, y: 0 }, b: { x: 500, y: 0 } },
  };
}

describe("addStep", () => {
  it("places a dropped step where it fell, wired from the port it was dragged out of", () => {
    const next = addStep(line(), step("c"), { x: 700, y: 90 }, { step: "b", port: "out" });
    expect(next.layout?.c).toEqual({ x: 700, y: 90 });
    expect(next.wires.at(-1)).toEqual({ from: "b", port: "out", to: "c" });
  });
});

describe("removeSteps", () => {
  it("takes steps out with their wires and never the input", () => {
    const next = removeSteps(line(), ["input", "a"]);
    expect(next.steps.map((s) => s.id)).toEqual(["input", "b"]);
    expect(next.wires).toEqual([]);
    expect(Object.keys(next.layout ?? {})).toEqual(["input", "b"]);
  });
});

describe("copy, paste and duplicate", () => {
  it("pastes under fresh ids, with the steps that name each other naming the copies", () => {
    const flow = line();
    const fragment = fragmentOf(flow, ["a", "b"]);
    expect(fragment?.wires).toEqual([{ from: "a", port: "out", to: "b" }]);
    if (fragment === null) throw new Error("nothing copied");
    const { flow: next, ids } = pasteFragment(flow, fragment, { x: 100, y: 300 });
    expect(ids).toEqual(["a_1", "b_1"]);
    expect(next.wires.at(-1)).toEqual({ from: "a_1", port: "out", to: "b_1" });
    expect(next.steps.at(-1)?.config).toEqual({ ability: "transform", program: ".a_1.value" });
    expect(next.layout?.a_1).toEqual({ x: 100, y: 300 });
    expect(next.layout?.b_1).toEqual({ x: 350, y: 300 });
  });

  it("never copies the input step, and duplicates beside the original", () => {
    expect(fragmentOf(line(), ["input"])).toBeNull();
    const { flow: next, ids } = duplicateSteps(line(), ["input", "b"]);
    expect(ids).toEqual(["b_1"]);
    expect(next.layout?.b_1).toEqual({ x: 540, y: 40 });
    // b read a, which was not copied: the copy still reads the original.
    expect(next.steps.at(-1)?.config).toEqual({ ability: "transform", program: ".a.value" });
  });
});

describe("step names", () => {
  it("numbers a name another step already shows, on paste and duplicate alike", () => {
    const flow = line();
    const twice = duplicateSteps(duplicateSteps(flow, ["a"]).flow, ["a"]).flow;
    expect(twice.steps.map((one) => one.name)).toEqual(["Input", "a", "b", "a 2", "a 3"]);
    expect(freshStepName("Command", ["Command", "Command 2"])).toBe("Command 3");
    expect(freshStepName("Wait", ["Command"])).toBe("Wait");
  });
});

describe("insertOnWire", () => {
  it("puts the step between the two ends, keeping the port and the loop limit where they belong", () => {
    const flow = line();
    const looping: Flow = {
      ...flow,
      wires: [...flow.wires, { from: "b", port: "no", to: "a", maxRounds: 3 }],
    };
    const next = insertOnWire(looping, looping.wires[2], step("fix"), { x: 300, y: 150 });
    expect(next.wires.slice(-2)).toEqual([
      { from: "b", port: "no", to: "fix" },
      { from: "fix", port: "out", to: "a", maxRounds: 3 },
    ]);
    expect(next.wires).toHaveLength(4);
  });

  it("makes room on a forward wire: the step takes the next column and what follows moves right", () => {
    const flow = line();
    const next = insertOnWire(flow, flow.wires[1], step("fix"), { x: 260, y: 40 });
    const { a, b, fix } = next.layout ?? {};
    expect(fix).toEqual({ x: a.x + COLUMN_STEP, y: a.y });
    expect(b).toEqual({ x: fix.x + COLUMN_STEP, y: flow.layout?.b.y });
    expect(next.layout?.input).toEqual(flow.layout?.input);
  });

  it("leaves a step dropped on a wire that goes back where it was let go", () => {
    const flow = line();
    const looping: Flow = { ...flow, wires: [...flow.wires, { from: "b", port: "no", to: "a" }] };
    const next = insertOnWire(looping, looping.wires[2], step("fix"), { x: 300, y: 150 });
    expect(next.layout?.fix).toEqual({ x: 300, y: 150 });
    expect(next.layout?.b).toEqual(flow.layout?.b);
  });
});

describe("disconnect", () => {
  it("cuts a step's wires and leaves it in place", () => {
    const next = disconnect(line(), "a");
    expect(next.wires).toEqual([]);
    expect(next.steps).toHaveLength(3);
  });
});
