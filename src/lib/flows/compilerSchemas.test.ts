import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMA,
  FLOW_SCHEMA,
  READING_SCHEMA,
  changeFromWire,
  configFromWire,
  drawnFromWire,
  flowToWire,
  type WireFlow,
} from "./compilerSchemas";
import { emptyFlow } from "./model";

/**
 * Every object a schema describes, at every depth, with where it sits. Strict
 * mode (Codex's `--output-schema`) refuses a schema where any one of them
 * leaves a key out of `required` or allows keys it does not name.
 */
function objectsIn(schema: unknown, at = "$"): { at: string; node: Record<string, unknown> }[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const found = [];
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object")) found.push({ at, node });
  for (const [key, inner] of Object.entries(node.properties ?? {}))
    found.push(...objectsIn(inner, `${at}.${key}`));
  if (node.items !== undefined) found.push(...objectsIn(node.items, `${at}[]`));
  return found;
}

describe("the compiler's schemas", () => {
  const schemas = { FLOW_SCHEMA, READING_SCHEMA, ...CONFIG_SCHEMA };

  it("are strict: every object requires all its keys and allows no others", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      for (const { at, node } of objectsIn(schema)) {
        const keys = Object.keys(node.properties ?? {}).sort();
        expect(node.additionalProperties, `${name} ${at}`).toBe(false);
        expect([...((node.required ?? []) as string[])].sort(), `${name} ${at}`).toEqual(keys);
      }
    }
  });
});

describe("drawnFromWire", () => {
  const wire: WireFlow = {
    name: "Tests",
    description: "",
    hints: [{ name: "branch", kind: null, note: null, default: "main", choices: null }],
    steps: [
      {
        id: "run",
        name: "Run",
        does: "npm test",
        ability: "command",
        config: '{"command":{"all":[{"program":"npm","args":["test"]}],"windows":null},"cwd":"api"}',
        onError: null,
        retries: null,
        forEach: null,
      },
    ],
    wires: [{ from: "input", port: "out", to: "run", maxRounds: null }],
  };

  it("reads the config the model wrote as text, and leaves out what it left null", () => {
    const drawn = drawnFromWire(wire);
    expect(drawn.hints).toEqual([{ name: "branch", default: "main" }]);
    expect(drawn.steps[0]).toEqual({
      id: "run",
      name: "Run",
      does: "npm test",
      ability: "command",
      config: { command: { all: [{ program: "npm", args: ["test"] }] }, cwd: "api" },
    });
    expect(drawn.wires).toEqual([{ from: "input", port: "out", to: "run" }]);
  });

  it("refuses a config that is not a JSON object, naming the step", () => {
    const broken = { ...wire, steps: [{ ...wire.steps[0], config: "npm test" }] };
    expect(() => drawnFromWire(broken)).toThrow(/run is not JSON/);
  });

  it("reads back a flow it was shown, unchanged", () => {
    const flow = emptyFlow("Shown");
    const back = drawnFromWire(flowToWire(flow));
    expect(back.steps.map((step) => [step.id, step.ability, step.config])).toEqual(
      flow.steps.map((step) => [step.id, step.config.ability, {}]),
    );
  });
});

describe("configFromWire and changeFromWire", () => {
  it("turns HTTP headers back into a map and drops what was left null", () => {
    const config = configFromWire("http", {
      method: "GET",
      url: "https://example.com",
      headers: [{ name: "Authorization", value: "Bearer {{secret.TOKEN}}" }],
      body: null,
      parse: null,
    });
    expect(config).toEqual({
      ability: "http",
      method: "GET",
      url: "https://example.com",
      headers: { Authorization: "Bearer {{secret.TOKEN}}" },
    });
  });

  it("reads a proposed change, or none", () => {
    expect(changeFromWire("transform", null)).toBeNull();
    expect(changeFromWire("transform", '{"program":".a"}')).toEqual({ ability: "transform", program: ".a" });
  });
});
