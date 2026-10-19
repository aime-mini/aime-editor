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
    expect(autoHints(ranOnAuto, undefined, auto, models)).toEqual({ model: "Opus 5.5", effort: "high" });
  });

  it("calls a model the picker does not list by its id", () => {
    const codex: ObservedRun = { ranOn: { model: "gpt-5.6-terra" }, chose: auto };
    expect(autoHints(codex, undefined, auto, models)).toEqual({ model: "gpt-5.6-terra", effort: null });
  });

  it("says nothing about Auto from a turn that ran on a chosen model", () => {
    const chosen: ObservedRun = {
      ranOn: { model: "claude-haiku-5-5", effort: "medium" },
      chose: { model: "haiku", effort: "" },
    };
    expect(autoHints(chosen, undefined, auto, models)).toEqual({ model: null, effort: null });
    expect(autoHints(chosen, undefined, { model: "haiku", effort: "" }, models)).toEqual({
      model: null,
      effort: "medium",
    });
  });

  it("says nothing before any turn when the CLI could not be asked", () => {
    expect(autoHints(undefined, undefined, auto, models)).toEqual({ model: null, effort: null });
  });

  it("names the effort the CLI said a model just chosen runs at, before any turn", () => {
    const opus = { model: "claude-opus-5-5", effort: "" };
    expect(autoHints(undefined, { model: "claude-opus-5-5", effort: "high" }, opus, models)).toEqual({
      model: null,
      effort: "high",
    });
  });

  it("names both in a new conversation from the CLI's answer", () => {
    expect(autoHints(undefined, { model: "claude-opus-5-5", effort: "high" }, auto, models)).toEqual({
      model: "Opus 5.5",
      effort: "high",
    });
  });

  it("lets a turn under the same choice speak over what the CLI said before it", () => {
    const expected = { model: "claude-opus-5-5", effort: "medium" };
    expect(autoHints(ranOnAuto, expected, auto, models)).toEqual({ model: "Opus 5.5", effort: "high" });
  });

  it("says nothing beside a level that was picked", () => {
    const picked = { model: "claude-opus-5-5", effort: "low" };
    expect(autoHints(undefined, { model: "claude-opus-5-5", effort: "high" }, picked, models)).toEqual({
      model: null,
      effort: null,
    });
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
