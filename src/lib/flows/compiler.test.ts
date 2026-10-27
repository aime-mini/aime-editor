import { describe, expect, it } from "vitest";
import { needsCompiling, normalise, stepsBefore } from "./compiler";
import { jqSafeId, withStepRenamed } from "./ids";

describe("jqSafeId", () => {
  it("makes an id jq reads as a path", () => {
    expect(jqSafeId("run-api-tests")).toBe("run_api_tests");
    expect(jqSafeId("Read Files")).toBe("read_files");
    expect(jqSafeId("1st")).toBe("step_1st");
    expect(jqSafeId("count")).toBe("count");
  });
});

describe("withStepRenamed", () => {
  it("renames the step where jq and templates name it, and nowhere else", () => {
    const from = "run-tests";
    expect(withStepRenamed(".run-tests.value.passed == true", from, "run_tests")).toBe(
      ".run_tests.value.passed == true",
    );
    expect(withStepRenamed('.["run-tests"].summary', from, "run_tests")).toBe('.["run_tests"].summary');
    expect(withStepRenamed("Fix it: {{run-tests.summary}}", from, "run_tests")).toBe(
      "Fix it: {{run_tests.summary}}",
    );
    expect(withStepRenamed(".run-tests-old.value", from, "run_tests")).toBe(".run-tests-old.value");
  });
});

describe("normalise", () => {
  it("keeps a drawn flow whole when its ids have to change", () => {
    const flow = normalise({
      name: "Tests",
      description: "",
      hints: [],
      steps: [
        { id: "input", name: "Input", does: "", ability: "input", config: {} },
        {
          id: "run-tests",
          name: "Run",
          does: "",
          ability: "command",
          config: { command: { all: [{ program: "npm", args: ["test"] }] } },
        },
        {
          id: "passed?",
          name: "Passed?",
          does: "",
          ability: "gate",
          config: { branches: [{ label: "yes", program: ".run-tests.value.code == 0" }] },
        },
        { id: "fix", name: "Fix", does: "Fix it: {{run-tests.summary}}", ability: "ai", config: {} },
      ],
      wires: [
        { from: "input", port: "out", to: "run-tests" },
        { from: "run-tests", port: "out", to: "passed?" },
        { from: "passed?", port: "yes", to: "fix" },
      ],
    });
    expect(flow.steps.map((step) => step.id)).toEqual(["input", "run_tests", "passed", "fix"]);
    expect(flow.wires.map((wire) => `${wire.from}>${wire.to}`)).toEqual([
      "input>run_tests",
      "run_tests>passed",
      "passed>fix",
    ]);
    expect(flow.steps[2].config).toEqual({
      ability: "gate",
      branches: [{ label: "yes", program: ".run_tests.value.code == 0" }],
    });
    expect(flow.steps[3].does).toBe("Fix it: {{run_tests.summary}}");
  });

  it("takes a drawn config as compiled from its text, so the first run starts at once", () => {
    const flow = normalise({
      name: "Tests",
      description: "",
      hints: [],
      steps: [
        { id: "input", name: "Input", does: "", ability: "input", config: {} },
        {
          id: "test",
          name: "Test",
          does: "Run the test suite",
          ability: "command",
          config: { command: { all: [{ program: "npm", args: ["test"] }] } },
        },
        { id: "fix", name: "Fix", does: "Fix what failed", ability: "ai", config: {} },
      ],
      wires: [
        { from: "input", port: "out", to: "test" },
        { from: "test", port: "error", to: "fix" },
      ],
    });
    expect(flow.steps.map(needsCompiling)).toEqual([false, false, false]);
    expect(flow.steps[2].compiled).toBeUndefined();

    const edited = { ...flow.steps[1], does: "Run the test suite twice" };
    expect(needsCompiling(edited)).toBe(true);
  });
});

describe("stepsBefore", () => {
  it("names every step a run passes first, wired in or further back, and not what a loop brings back", () => {
    const flow = normalise({
      name: "Shop",
      description: "",
      hints: [],
      steps: [
        { id: "input", name: "Input", does: "", ability: "input", config: {} },
        { id: "analyse", name: "Analyse", does: "Analyse", ability: "ai", config: {} },
        { id: "build", name: "Build", does: "Build", ability: "ai", config: {} },
        { id: "test", name: "Test", does: "Test", ability: "ai", config: {} },
        { id: "list", name: "List", does: "The features", ability: "transform", config: { program: "." } },
      ],
      wires: [
        { from: "input", port: "out", to: "analyse" },
        { from: "analyse", port: "out", to: "build" },
        { from: "build", port: "out", to: "test" },
        { from: "test", port: "error", to: "build", maxRounds: 3 },
        { from: "test", port: "out", to: "list" },
      ],
    });
    expect(stepsBefore(flow, "list")).toEqual(["input", "analyse", "build", "test"]);
    expect(stepsBefore(flow, "build")).toEqual(["input", "analyse"]);
  });
});
