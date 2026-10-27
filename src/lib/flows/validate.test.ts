import { describe, expect, it } from "vitest";
import { emptyFlow, type Flow, type Step, type StepConfig } from "./model";
import { isRelative, loopWires, validate } from "./validate";

function withSteps(steps: Step[], wires: Flow["wires"]): Flow {
  const flow = emptyFlow("t");
  return { ...flow, steps: [...flow.steps, ...steps], wires };
}

const step = (id: string, config: StepConfig, extra: Partial<Step> = {}): Step => ({
  id,
  name: id,
  does: "something",
  config,
  onError: "stop",
  retries: 0,
  ...extra,
});

const errors = (flow: Flow) =>
  validate(flow)
    .filter((problem) => problem.kind === "error")
    .map((problem) => problem.message);

describe("validate", () => {
  it("accepts a plain line and warns about a step nothing reaches", () => {
    const flow = withSteps(
      [
        step("a", { ability: "ai", permission: "readOnly" }),
        step("lost", { ability: "ai", permission: "readOnly" }),
      ],
      [{ from: "input", port: "out", to: "a" }],
    );
    const problems = validate(flow);
    expect(problems.filter((p) => p.kind === "error")).toEqual([]);
    expect(problems.map((p) => p.at)).toEqual(["lost"]);
  });

  it("names a loop without a round limit, a bad port, an unknown step and an ability not yet runnable", () => {
    const flow = withSteps(
      [
        step("a", { ability: "ai", permission: "readOnly" }),
        step("g", { ability: "gate", branches: [{ label: "yes", program: "true" }] }),
        step("h", { ability: "free" }),
      ],
      [
        { from: "input", port: "out", to: "a" },
        { from: "a", port: "out", to: "g" },
        { from: "g", port: "yes", to: "a" },
        { from: "g", port: "maybe", to: "h" },
        { from: "ghost", port: "out", to: "h" },
      ],
    );
    const found = errors(flow);
    expect(found).toContainEqual(expect.stringContaining("loop"));
    expect(found).toContainEqual(expect.stringContaining('no port "maybe"'));
    expect(found).toContainEqual(expect.stringContaining('"ghost", which is no step'));
    expect(found).toContainEqual(expect.stringContaining("cannot run yet"));
    expect(loopWires(flow).map((wire) => `${wire.from}->${wire.to}`)).toEqual(["g->a"]);
  });

  it("refuses shell syntax in a shared command and a path that leaves the workspace", () => {
    const flow = withSteps(
      [
        step("c", {
          ability: "command",
          command: { all: [{ program: "npm", args: ["test", "&&", "echo", "ok"] }] },
          cwd: "../elsewhere",
        }),
      ],
      [{ from: "input", port: "out", to: "c" }],
    );
    const found = errors(flow);
    expect(found).toContainEqual(expect.stringContaining("shell syntax"));
    expect(found).toContainEqual(expect.stringContaining("not relative"));
    expect(isRelative("src/app")).toBe(true);
    expect(isRelative("C:\\x")).toBe(false);
    expect(isRelative("/etc")).toBe(false);
    expect(isRelative("a/../../b")).toBe(false);
  });

  it("lets a shared command's arguments carry what a shell would read, since none reads them", () => {
    const flow = withSteps(
      [
        step("c", {
          ability: "command",
          command: {
            all: [
              { program: "node", args: ["-e", "process.stdout.write([1].map((n) => n * 2).join('|'))"] },
              { program: "grep", args: ["-E", "a|b", "notes.txt"] },
              { program: "ls", args: ["*.ts"] },
            ],
          },
        }),
      ],
      [{ from: "input", port: "out", to: "c" }],
    );
    expect(errors(flow)).toEqual([]);
    const warnings = validate(flow)
      .filter((problem) => problem.kind === "warning")
      .map((problem) => problem.message);
    expect(warnings).toContainEqual(expect.stringContaining('"*.ts" reaches the program as written'));
  });

  it("checks a wait's bounds and a choice's options", () => {
    const flow = withSteps(
      [
        step("w", { ability: "wait", seconds: 0 }),
        step("h", { ability: "human", mode: "choose", options: ["only"] }),
      ],
      [
        { from: "input", port: "out", to: "w" },
        { from: "w", port: "out", to: "h" },
      ],
    );
    const found = errors(flow);
    expect(found).toContainEqual(expect.stringContaining("between 1 and 3600"));
    expect(found).toContainEqual(expect.stringContaining("fewer than two options"));
  });
});
