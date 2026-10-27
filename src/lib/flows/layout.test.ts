import { describe, expect, it } from "vitest";
import { arrange, NODE_WIDTH, placeBeside } from "./layout";
import { emptyFlow, type Flow, type Step } from "./model";

/** A flow of `count` steps after the input, wired one after the other. */
function line(count: number): Flow {
  const flow = emptyFlow("Line");
  const input = flow.steps[0];
  const steps: Step[] = Array.from({ length: count }, (_, index) => ({
    ...input,
    id: `s${String(index + 1)}`,
    name: `Step ${String(index + 1)}`,
    config: { ability: "wait", seconds: 1 },
  }));
  const ids = [input.id, ...steps.map((step) => step.id)];
  return {
    ...flow,
    steps: [input, ...steps],
    wires: ids.slice(1).map((id, index) => ({ from: ids[index], port: "out", to: id })),
  };
}

describe("arrange", () => {
  it("lays a short flow out in one row, left to right", () => {
    const positions = arrange(line(2));
    const ys = new Set(Object.values(positions).map((p) => p.y));
    expect(ys.size).toBe(1);
    const xs = Object.values(positions).map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("wraps a long flow onto the next row after three columns, starting again at the left", () => {
    const flow = line(6);
    const positions = arrange(flow);
    const first = positions[flow.steps[0].id];
    // The input, s1 and s2 fill the first row; s3 opens the second under the input.
    expect(positions.s3.x).toBe(first.x);
    expect(positions.s3.y).toBeGreaterThan(first.y);
    expect(positions.s4.x).toBe(positions.s1.x);
    expect(Math.max(...Object.values(positions).map((p) => p.x))).toBeLessThan(3 * (NODE_WIDTH + 56) + 20);
  });

  it("keeps the branches of a step side by side in its column", () => {
    const flow = line(1);
    const input = flow.steps[0];
    const branch = (id: string): Step => ({ ...flow.steps[1], id, name: id });
    const withBranches: Flow = {
      ...flow,
      steps: [...flow.steps, branch("a"), branch("b")],
      wires: [...flow.wires, { from: "s1", port: "out", to: "a" }, { from: "s1", port: "out", to: "b" }],
    };
    const positions = arrange(withBranches);
    expect(positions.a.x).toBe(positions.b.x);
    expect(positions.a.y).not.toBe(positions.b.y);
    expect(positions[input.id].x).toBeLessThan(positions.s1.x);
  });
});

describe("placeBeside", () => {
  it("puts a new step in the next column, wraps after the third, and never on another card", () => {
    const flow = line(2);
    const positions = arrange(flow);
    const placed = { ...flow, layout: positions };
    const afterFirst = placeBeside(placed, flow.steps[0]);
    // The next column after the input is taken by s1, so it goes under it.
    expect(afterFirst.x).toBe(positions.s1.x);
    expect(afterFirst.y).toBeGreaterThan(positions.s1.y);
    const afterLast = placeBeside(placed, flow.steps[2]);
    expect(afterLast.x).toBe(positions[flow.steps[0].id].x);
    expect(afterLast.y).toBeGreaterThan(positions.s2.y);
  });
});
