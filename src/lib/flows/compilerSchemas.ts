/**
 * The JSON the compiler asks an AI CLI for, and how it becomes a flow.
 *
 * Every schema here is written for the strictest reader: OpenAI's structured
 * outputs, which Codex's `--output-schema` holds to (measured on 0.146.0:
 * a schema with an optional key was refused with "'required' is
 * required to include every key in properties"). Strict means every object
 * names all its keys as required and allows no others, so a key that may be
 * left out is required and nullable, and anything free-form - a step's config,
 * an HTTP header map - travels as text or as a list. Claude's `--json-schema`
 * takes the same schemas, so there is one shape for every CLI.
 */
import type { Ability, Flow, InputHint, Step, StepConfig, Wire } from "./model";

const ABILITIES: Ability[] = [
  "input",
  "ai",
  "transform",
  "gate",
  "wait",
  "human",
  "command",
  "http",
  "service",
  "git",
  "mail",
  "files",
  "subflow",
];
const ON_ERROR: Step["onError"][] = ["stop", "errorWire", "skipItems"];
const HINT_KINDS: NonNullable<InputHint["kind"]>[] = [
  "file",
  "folder",
  "image",
  "ticket",
  "pr",
  "link",
  "run",
];

/** A key that may be left out: required, and allowed to be null. */
const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, "null"], ...extra });
/** An object as strict mode wants it: every key required, no others. */
const strictObject = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

export const FLOW_SCHEMA = strictObject({
  name: { type: "string" },
  description: { type: "string" },
  hints: {
    type: "array",
    items: strictObject({
      name: { type: "string" },
      kind: nullable("string", { enum: [...HINT_KINDS, null] }),
      note: nullable("string"),
      default: nullable("string"),
      choices: nullable("array", { items: { type: "string" } }),
    }),
  },
  steps: {
    type: "array",
    items: strictObject({
      id: { type: "string" },
      name: { type: "string" },
      does: { type: "string" },
      ability: { type: "string", enum: ABILITIES },
      config: {
        type: "string",
        description:
          'The step\'s settings as one JSON object written out as text, e.g. {"permission":"readOnly"}.',
      },
      onError: nullable("string", { enum: [...ON_ERROR, null] }),
      retries: nullable("integer"),
      forEach: nullable("boolean"),
    }),
  },
  wires: {
    type: "array",
    items: strictObject({
      from: { type: "string" },
      port: { type: "string" },
      to: { type: "string" },
      maxRounds: nullable("integer"),
    }),
  },
});

const INVOCATION = strictObject({
  program: { type: "string" },
  args: { type: "array", items: { type: "string" } },
});

/** The config of a compiled step, per ability. */
export const CONFIG_SCHEMA: Partial<Record<Ability, unknown>> = {
  transform: strictObject({ program: { type: "string" } }),
  gate: strictObject({
    branches: {
      type: "array",
      items: strictObject({ label: { type: "string" }, program: { type: "string" } }),
    },
  }),
  command: strictObject({
    command: strictObject({
      all: nullable("array", { items: INVOCATION }),
      windows: nullable("string"),
      macos: nullable("string"),
      linux: nullable("string"),
    }),
    cwd: nullable("string"),
  }),
  http: strictObject({
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    url: { type: "string" },
    headers: nullable("array", {
      items: strictObject({ name: { type: "string" }, value: { type: "string" } }),
    }),
    body: nullable("string"),
    parse: nullable("string", { enum: ["json", "text", null] }),
  }),
};

export const READING_SCHEMA = strictObject({
  explanation: { type: "string" },
  change: nullable("string", {
    description: "The whole new config of the step as one JSON object written out as text, or null.",
  }),
});

/** What a model sends back for a flow, before it is a flow. */
export interface WireFlow {
  name: string;
  description: string;
  hints: {
    name: string;
    kind: InputHint["kind"] | null;
    note: string | null;
    default: string | null;
    choices: string[] | null;
  }[];
  steps: {
    id: string;
    name: string;
    does: string;
    ability: Ability;
    config: string;
    onError: Step["onError"] | null;
    retries: number | null;
    forEach: boolean | null;
  }[];
  wires: { from: string; port: string; to: string; maxRounds: number | null }[];
}

/** A drawn flow with its config read and its empty keys gone - what `normalise` makes a flow of. */
export interface DrawnFlow {
  name: string;
  description: string;
  hints: InputHint[];
  steps: {
    id: string;
    name: string;
    does: string;
    ability: Ability;
    config: Record<string, unknown>;
    onError?: Step["onError"];
    retries?: number;
    forEach?: boolean;
  }[];
  wires: Wire[];
}

/** Copies `value` with every null object key left out, at every depth - strict mode's "not given". */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, inner]) => inner !== null)
      .map(([key, inner]) => [key, withoutNulls(inner)]),
  );
}

/** A config the model wrote as text, read back; one that is not a JSON object is a broken answer. */
function configFromText(text: string, where: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the config the AI wrote for ${where} is not JSON: ${text.slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the config the AI wrote for ${where} is not a JSON object`);
  }
  return withoutNulls(parsed) as Record<string, unknown>;
}

export function drawnFromWire(wire: WireFlow): DrawnFlow {
  return {
    name: wire.name,
    description: wire.description,
    hints: wire.hints.map((hint) => withoutNulls(hint) as InputHint),
    steps: wire.steps.map((step) => ({
      ...(withoutNulls({ ...step, config: null }) as Omit<DrawnFlow["steps"][number], "config">),
      config: configFromText(step.config, step.id),
    })),
    wires: wire.wires.map((link) => withoutNulls(link) as Wire),
  };
}

/** A flow as the compiler shows it to a model: the shape it is asked to answer in. */
export function flowToWire(flow: Flow): WireFlow {
  return {
    name: flow.name,
    description: flow.description,
    hints: flow.input.hints.map((hint) => ({
      name: hint.name,
      kind: hint.kind ?? null,
      note: hint.note ?? null,
      default: hint.default ?? null,
      choices: hint.choices ?? null,
    })),
    steps: flow.steps.map((step) => {
      const { ability, ...config } = step.config;
      return {
        id: step.id,
        name: step.name,
        does: step.does,
        ability,
        config: JSON.stringify(config),
        onError: step.onError,
        retries: step.retries,
        forEach: step.forEach ?? null,
      };
    }),
    wires: flow.wires.map((link) => ({ ...link, maxRounds: link.maxRounds ?? null })),
  };
}

/** A compiled config as the step keeps it: empty keys gone, HTTP headers a map again. */
export function configFromWire(ability: Ability, answer: unknown): StepConfig {
  const config = withoutNulls(answer) as Record<string, unknown>;
  if (ability === "http" && Array.isArray(config.headers)) {
    const pairs = config.headers as { name: string; value: string }[];
    config.headers = Object.fromEntries(pairs.map(({ name, value }) => [name, value]));
  }
  return { ...config, ability } as StepConfig;
}

/** What a failure reading proposes, as a config, or nothing when it proposes nothing. */
export function changeFromWire(ability: Ability, change: string | null): StepConfig | null {
  if (change === null || change.trim() === "") return null;
  return { ...configFromText(change, "the failed step"), ability } as StepConfig;
}
