import { describe, expect, it } from "vitest";
import { effortsOf, modelsOf, type DiscoveredModel } from "./providers";

/** What `codex debug models` listed on 2026-10-02, as Rust hands it over. */
const codexCatalog: DiscoveredModel[] = [
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  { value: "gpt-5.5", label: "GPT-5.5", efforts: [] },
];

describe("the models a picker offers", () => {
  it("are Auto, the aliases and what the installed CLI reported", () => {
    const claude = modelsOf("claude", [
      { value: "claude-fable-5-1[1m]", label: "Fable 5.1 · 1M context" },
      { value: "claude-opus-5-5", label: "Opus 5.5" },
    ]);
    expect(claude.map((option) => option.value)).toEqual([
      "",
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "claude-fable-5-1[1m]",
      "claude-opus-5-5",
    ]);
    expect(claude.at(-1)?.label).toBe("Opus 5.5");
  });

  it("fall back to the table while the CLI has not been read", () => {
    expect(modelsOf("claude", undefined).some((option) => option.value === "claude-opus-5-5")).toBe(true);
    expect(modelsOf("codex", []).some((option) => option.value === "gpt-5.6-terra")).toBe(true);
  });

  it("offer a configured CLI only its default until it lists something", () => {
    expect(modelsOf("gemini", undefined).map((option) => option.value)).toEqual([""]);
    expect(
      modelsOf("gemini", [{ value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]).map((o) => o.value),
    ).toEqual(["", "gemini-2.5-pro"]);
  });
});

describe("the efforts a model accepts", () => {
  it("come from the catalog when it names them, with Auto first", () => {
    expect(effortsOf("codex", "gpt-5.6-terra", codexCatalog).map((option) => option.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("are the provider's safe set when the catalog is silent about a model", () => {
    const common = effortsOf("codex", "", codexCatalog).map((option) => option.value);
    expect(effortsOf("codex", "gpt-5.5", codexCatalog).map((option) => option.value)).toEqual(common);
    expect(common).toEqual(["", "low", "medium", "high", "xhigh"]);
  });
});
