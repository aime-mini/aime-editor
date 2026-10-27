import { describe, expect, it } from "vitest";
import { fingerprintOf } from "./fingerprint";
import { emptyFlow, type Flow } from "./model";

describe("fingerprintOf", () => {
  it("is the same for a flow read back with its keys sorted", () => {
    const written = emptyFlow("Shop");
    written.steps[0].forEach = undefined;
    const readBack = JSON.parse(
      JSON.stringify(written, (_, value: unknown) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    ) as Flow;

    expect(JSON.stringify(readBack)).not.toBe(JSON.stringify(written));
    expect(fingerprintOf(readBack)).toBe(fingerprintOf(written));
  });

  it("changes with what the flow does", () => {
    const flow = emptyFlow("Shop");
    const changed: Flow = { ...flow, steps: [{ ...flow.steps[0], does: "pick the folder" }] };

    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(flow));
  });
});
