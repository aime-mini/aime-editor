import { agentTurn } from "../agentTurn";
import {
  CONFIG_SCHEMA,
  FLOW_SCHEMA,
  READING_SCHEMA,
  changeFromWire,
  configFromWire,
  drawnFromWire,
  flowToWire,
  type DrawnFlow,
  type WireFlow,
} from "./compilerSchemas";
import { parseJson } from "./executors";
import { jqSafeId, mapStrings, withStepRenamed } from "./ids";
import {
  DEFAULT_RETRIES,
  DEFAULT_SETTINGS,
  FLOW_VERSION,
  type Ability,
  type Flow,
  type Step,
  type StepConfig,
} from "./model";
import type { RunView } from "../../stores/flows";
import { loopWires, validate } from "./validate";

/**
 * The AI as the compiler of a flow (ARCHITECTURE §Flows): it draws a flow
 * from a description, edits one on request, turns a step's "what it does"
 * into the jq, command or branches that run it, and reads a failed step.
 * Each is one turn with a JSON schema the CLI enforces, read-only in the
 * repository so the compiler can look at what is there and never changes it.
 *
 * Nothing here runs; what comes back is validated like any hand-drawn flow.
 */

const ABILITY_CATALOGUE = `Abilities and their config (every step: {id, name, does, ability, config, onError, retries, forEach}; config is the JSON object below written out as text; onError, retries and forEach are null where the default is right):
- input: the one start step; config {}. Its hints describe what a run expects: {name, kind?: file|folder|image|ticket|pr|link|run, note?, default?, choices?[]}. A hint with a default is a parameter.
- ai: an AI turn in the repository; config {permission: readOnly|edits|full, tools?: everything|filesOnly, json?: boolean, model?: string}. Use json:true when later steps need fields from it.
- transform: a jq program over the earlier steps' outputs; config {program}. The jq input is {<stepId>: {value, files, summary}, ...} for every step that ran before it - wired in or further back - e.g. ".read.value.items | length".
- gate: branches with jq conditions, first true wins; config {branches: [{label, program}]}. Wires leave a gate from its branch labels.
- wait: sleep; config {seconds} (1..3600). With a wire back to an earlier step and maxRounds, a flow polls.
- human: a person's turn; config {mode: approve|choose|edit|form, options?: string[], fields?: [{name, note?}]}.
- command: a program run in the repository; config {command: {all?: [{program, args[]}], windows?, macos?, linux?}, cwd?, env?}. Prefer "all": programs with arguments, NO shell syntax (no &&, |, >, $VAR). A shell line per platform only when a shell is needed (PowerShell on windows, sh on macos/linux).
- http: an HTTP call; config {method, url, headers?, body?, connection?, parse?: json|text}. Secrets as {{secret.NAME}} in headers.
- service: one of Aime's connections; config {door: tracker|mcp|cli, action, ...}. tracker: {door:"tracker", action: list|detail|comment|setState, ...}; mcp: an AI step told to use the named server {door:"mcp", server}; cli: {door:"cli", command: {all: [...]}}.
- git: config {action: branch|commit|push|pr|diff|log, branch?, message?, title?, base?}.
- mail: config {connection, to[], subject, body}.
- files: read files; config {globs: string[]}.
- subflow: config {slug}.
Text fields may insert earlier outputs as {{stepId.value.path}}, {{stepId.summary}}, {{input.text}}, {{input.params.NAME}}, and inside a for-each {{item.value}}.
Wires: {from, port, to, maxRounds}; port is "out", "error", or a gate's branch label. A wire back to an earlier step is a loop and MUST carry maxRounds (1..50); every other wire has maxRounds null.
Rules: exactly one input step with id "input"; ids are lowercase letters, digits and underscores (jq reads .run_tests as a path, but .run-tests as a subtraction); every step reachable from input; make steps deterministic (transform, gate, command) wherever judgement is not needed - an AI step only where it is.`;

export interface DrawOutcome {
  flow: Flow;
  /** What the compiler decided alone, for the person to check. */
  notes: string[];
  costUsd: number | null;
}

/** Draws a flow from a description, looking at the repository read-only. */
export async function drawFlow(description: string, cwd: string): Promise<DrawOutcome> {
  const prompt = [
    "Draw a flow for the person below, as JSON matching the schema you were given.",
    ABILITY_CATALOGUE,
    "You may read the repository (read-only) to choose real commands, test suites and file paths; never guess a command the project does not have.",
    "Keep it to the steps the description needs; name steps in the person's language; put short notes for a person in `does` (for ai and human steps, `does` is the actual instruction).",
    "## The description",
    description,
  ].join("\n\n");
  const outcome = await agentTurn({
    prompt,
    cwd,
    permission: "readOnly",
    tools: "filesOnly",
    schema: FLOW_SCHEMA,
  });
  if (outcome.code !== 0) throw new Error(`the AI could not draw the flow (exit ${String(outcome.code)})`);
  const drawn = drawnFromWire(parseJson(outcome.text) as WireFlow);
  return { flow: normalise(drawn), notes: decisionsIn(drawn), costUsd: outcome.costUsd };
}

/** Changes a flow the way the request says, and returns the whole flow back. */
export async function editFlow(flow: Flow, request: string, cwd: string): Promise<DrawOutcome> {
  const prompt = [
    "Change the flow below as the person asks, and answer with the WHOLE flow as JSON matching the schema. Keep every step and wire the request does not touch, ids included.",
    ABILITY_CATALOGUE,
    "## The flow as it is",
    JSON.stringify(flowToWire(flow), null, 2),
    "## The request",
    request,
  ].join("\n\n");
  const outcome = await agentTurn({
    prompt,
    cwd,
    permission: "readOnly",
    tools: "filesOnly",
    schema: FLOW_SCHEMA,
  });
  if (outcome.code !== 0) throw new Error(`the AI could not edit the flow (exit ${String(outcome.code)})`);
  const drawn = drawnFromWire(parseJson(outcome.text) as WireFlow);
  const next = normalise(drawn);
  return {
    flow: { ...next, layout: keptLayout(flow, next), settings: flow.settings },
    notes: decisionsIn(drawn),
    costUsd: outcome.costUsd,
  };
}

// ---- compiling one step ------------------------------------------------------------

/** Every step a run passes before this one, by its forward wires: what the step's templates and jq can name. */
export function stepsBefore(flow: Flow, stepId: string): string[] {
  const loops = loopWires(flow);
  const seen = new Set<string>();
  const queue = [stepId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const wire of flow.wires) {
      if (wire.to !== current || loops.includes(wire) || seen.has(wire.from)) continue;
      seen.add(wire.from);
      queue.push(wire.from);
    }
  }
  return flow.steps.map((step) => step.id).filter((id) => seen.has(id));
}

/** The abilities whose config the AI writes from `does`. */
export const COMPILED_ABILITIES: readonly Ability[] = ["transform", "gate", "command", "http"];

/** A stable mark of the text a config was compiled from. */
export function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Whether a step's config no longer matches what its text says. */
export function needsCompiling(step: Step): boolean {
  if (!COMPILED_ABILITIES.includes(step.config.ability) || step.does.trim() === "") return false;
  return step.compiled?.from !== hashOf(step.does);
}

/**
 * Writes the config of a step from its text, with the real input it will
 * get (the last run's, when there was one) in front of the AI.
 */
export async function compileStep(flow: Flow, step: Step, sampleInput: unknown, cwd: string): Promise<Step> {
  const schema = CONFIG_SCHEMA[step.config.ability];
  if (schema === undefined) throw new Error(`a ${step.config.ability} step is not compiled`);
  const before = stepsBefore(flow, step.id);
  const prompt = [
    `Write the config of a "${step.config.ability}" step of a flow, as JSON matching the schema.`,
    ABILITY_CATALOGUE,
    `## The step\nname: ${step.name}\nwhat it does: ${step.does}\nsteps before it, whose outputs it reads: ${before.join(", ") || "(none)"}`,
    "## The input the step gets (JSON, keyed by the earlier steps' ids)",
    sampleInput === undefined
      ? "(no run yet - assume the shape the earlier steps' names suggest)"
      : JSON.stringify(sampleInput, null, 2).slice(0, 6000),
    step.config.ability === "command"
      ? "You may read the repository to find the real command; prefer the shared form with no shell syntax."
      : "",
  ].join("\n\n");
  const outcome = await agentTurn({ prompt, cwd, permission: "readOnly", tools: "filesOnly", schema });
  if (outcome.code !== 0) throw new Error(`the AI could not compile the step (exit ${String(outcome.code)})`);
  return {
    ...step,
    config: configFromWire(step.config.ability, parseJson(outcome.text)),
    compiled: { from: hashOf(step.does), at: Date.now() },
  };
}

// ---- reading a failure ---------------------------------------------------------------

export interface FailureReading {
  explanation: string;
  /** A changed config for the step, when the AI sees one that would help. */
  change: StepConfig | null;
  costUsd: number | null;
}

/** What went wrong with a step, and the change that would fix it. */
export async function explainFailure(run: RunView, stepId: string, cwd: string): Promise<FailureReading> {
  const step = run.flow.steps.find((candidate) => candidate.id === stepId);
  const view = run.steps[stepId];
  if (step === undefined || view === undefined) throw new Error("no such step in the run");
  const prompt = [
    "A step of a flow failed. Say in two or three sentences, in the person's language, what went wrong and what to do; and if a change to the step's config would fix it, give the whole new config as `change` (same shape as the current one), else null.",
    ABILITY_CATALOGUE,
    `## The step\n${JSON.stringify({ name: step.name, does: step.does, config: step.config }, null, 2)}`,
    `## The error\n${view.error ?? "(none recorded)"}`,
    `## The step's log\n${view.log.join("\n") || "(empty)"}`,
  ].join("\n\n");
  const outcome = await agentTurn({
    prompt,
    cwd,
    permission: "readOnly",
    tools: "filesOnly",
    schema: READING_SCHEMA,
  });
  if (outcome.code !== 0) throw new Error(`the AI could not read the failure (exit ${String(outcome.code)})`);
  const reading = parseJson(outcome.text) as { explanation: string; change: string | null };
  return {
    explanation: reading.explanation,
    change: changeFromWire(step.config.ability, reading.change),
    costUsd: outcome.costUsd,
  };
}

// ---- shapes ------------------------------------------------------------------------------

/**
 * The bounds a model is told and the schema cannot say - strict mode has no
 * room for them - so they are held here instead.
 */
const RETRIES = { min: 0, max: 5 };
const ROUNDS = { min: 1, max: 50 };

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A drawn flow as a flow the app stores: defaults filled in, ids made safe for
 * jq - and every place the flow names a renamed step renamed with it, so a
 * gate written as `.run-tests.value` reads `.run_tests.value` once its step is
 * `run_tests`.
 */
export function normalise(drawn: DrawnFlow): Flow {
  const renames = new Map(
    drawn.steps.map((step) => [step.id, jqSafeId(step.id)] as const).filter(([from, to]) => from !== to),
  );
  const renamed = (text: string) =>
    [...renames].reduce((current, [from, to]) => withStepRenamed(current, from, to), text);
  const idOf = (id: string) => renames.get(id) ?? jqSafeId(id);
  const drawnAt = Date.now();
  const steps: Step[] = drawn.steps.map((step) => {
    const does = renamed(step.does);
    return {
      id: idOf(step.id),
      name: step.name,
      does,
      config: {
        ...(mapStrings(step.config, renamed) as Record<string, unknown>),
        ability: step.ability,
      } as StepConfig,
      onError: step.onError ?? "stop",
      retries: clamp(step.retries ?? DEFAULT_RETRIES[step.ability], RETRIES),
      forEach: step.forEach === true ? true : undefined,
      // The config was written together with its text, by the same compiler:
      // compiling it again before the first run would only spend a turn per step.
      compiled:
        COMPILED_ABILITIES.includes(step.ability) && does.trim() !== ""
          ? { from: hashOf(does), at: drawnAt }
          : undefined,
    };
  });
  if (!steps.some((step) => step.config.ability === "input")) {
    steps.unshift({
      id: "input",
      name: "Input",
      does: "",
      config: { ability: "input" },
      onError: "stop",
      retries: 0,
    });
  }
  const wires = drawn.wires.map((wire) => ({
    ...wire,
    from: idOf(wire.from),
    to: idOf(wire.to),
    maxRounds: wire.maxRounds === undefined ? undefined : clamp(wire.maxRounds, ROUNDS),
  }));
  const flow: Flow = {
    version: FLOW_VERSION,
    name: drawn.name,
    description: drawn.description,
    input: { hints: drawn.hints },
    steps,
    wires,
    settings: { ...DEFAULT_SETTINGS },
  };
  const errors = validate(flow).filter((problem) => problem.kind === "error");
  if (errors.length > 0) {
    throw new Error(
      `the drawn flow does not hold together: ${errors.map((problem) => problem.message).join("; ")}`,
    );
  }
  return flow;
}

/** Steps keep their place when they survive an edit; new ones are laid out by Arrange. */
function keptLayout(before: Flow, after: Flow): Flow["layout"] {
  if (before.layout === undefined) return undefined;
  const kept = Object.fromEntries(
    Object.entries(before.layout).filter(([id]) => after.steps.some((step) => step.id === id)),
  );
  return after.steps.every((step) => step.id in kept) ? kept : undefined;
}

/** The choices a drawing made that the description did not: a loop limit, a model, a guard. */
function decisionsIn(drawn: DrawnFlow): string[] {
  const notes: string[] = [];
  for (const wire of drawn.wires)
    if (wire.maxRounds !== undefined)
      notes.push(`${wire.from} → ${wire.to}: at most ${String(wire.maxRounds)} rounds`);
  for (const step of drawn.steps) {
    if (step.ability === "ai") {
      const permission = typeof step.config.permission === "string" ? step.config.permission : "readOnly";
      notes.push(`${step.name}: AI, ${permission}${step.config.json === true ? ", answers JSON" : ""}`);
    }
    if (step.forEach === true) notes.push(`${step.name}: once per item`);
  }
  return notes;
}
