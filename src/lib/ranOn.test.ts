import { describe, expect, it } from "vitest";
import { autoHints, observe, type ObservedRun } from "./ranOn";

const models = [
  { value: "", label: "Auto" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
];
const auto = { model: "", effort: "" };

describe("what Auto stands for", () => {
  const ranOnAuto: ObservedRun = { ranOn: { model: "claude-opus-5-5[1m]", effort: "high" }, chose: auto };

  it("names the model and effort the last turn ran on, by the picker's own names", () => {
    expect(autoHints(ranOnAuto, auto, models)).toEqual({ model: "Opus 5.5", effort: "high" });
  });

  it("calls a model the picker does not list by its id", () => {
    const codex: ObservedRun = { ranOn: { model: "gpt-5.6-terra" }, chose: auto };
    expect(autoHints(codex, auto, models)).toEqual({ model: "gpt-5.6-terra", effort: null });
  });

  it("says nothing about Auto from a turn that ran on a chosen model", () => {
    const chosen: ObservedRun = {
      ranOn: { model: "claude-haiku-5-5", effort: "medium" },
      chose: { model: "haiku", effort: "" },
    };
    expect(autoHints(chosen, auto, models)).toEqual({ model: null, effort: null });
    expect(autoHints(chosen, { model: "haiku", effort: "" }, models)).toEqual({
      model: null,
      effort: "medium",
    });
  });

  it("says nothing before any turn", () => {
    expect(autoHints(undefined, auto, models)).toEqual({ model: null, effort: null });
  });
});

describe("folding observations", () => {
  it("keeps the effort of the last turn when the next one names only its model", () => {
    const before: ObservedRun = { ranOn: { model: "claude-opus-5-5", effort: "high" }, chose: auto };
    expect(observe(before, { ranOn: { model: "claude-opus-5-5" }, chose: auto })).toEqual(before);
  });

  it("starts over when the choice changed", () => {
    const before: ObservedRun = { ranOn: { model: "claude-opus-5-5", effort: "high" }, chose: auto };
    const next: ObservedRun = { ranOn: { model: "claude-haiku-5-5" }, chose: { model: "haiku", effort: "" } };
    expect(observe(before, next)).toEqual(next);
  });
});
