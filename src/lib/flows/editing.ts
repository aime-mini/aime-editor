/**
 * What the designer does to a flow when the person edits it on the canvas:
 * add a step where it was dropped, take steps out, copy, paste and duplicate
 * them, put a step into a wire, cut a step's wires. Pure - each takes a flow
 * and returns the next one - so the designer can keep every version for undo.
 */
import { freshStepId, freshStepName, mapStrings, withStepRenamed } from "./ids";
import { arrange, COLUMN_STEP } from "./layout";
import { OUT_PORT, type Flow, type Step, type Wire } from "./model";
import { loopWires } from "./validate";

export interface Point {
  x: number;
  y: number;
}

/** A port a new step is wired from: which step, which of its outputs. */
export interface PortRef {
  step: string;
  port: string;
}

/** Steps and the wires between them, lifted out of a flow: what copy and paste carry. */
export interface Fragment {
  steps: Step[];
  wires: Wire[];
  layout: Record<string, Point>;
}

/** How far a duplicate sits from what it copies, so both stay visible. */
const DUPLICATE_OFFSET = 40;

const isInput = (step: Step) => step.config.ability === "input";

/** Where every step is: the saved layout, filled in by Arrange for a step that has none. */
function placesOf(flow: Flow): Record<string, Point> {
  const saved = flow.layout ?? {};
  const arranged = flow.steps.every((step) => step.id in saved) ? {} : arrange(flow);
  return Object.fromEntries(
    flow.steps.map((step) => [step.id, step.id in saved ? saved[step.id] : arranged[step.id]]),
  );
}

/** Adds a step at `at`, wired from `from` when the person dragged it out of a port. */
export function addStep(flow: Flow, step: Step, at: Point, from?: PortRef): Flow {
  const wires =
    from === undefined ? flow.wires : [...flow.wires, { from: from.step, port: from.port, to: step.id }];
  return { ...flow, steps: [...flow.steps, step], wires, layout: { ...placesOf(flow), [step.id]: at } };
}

/** Takes steps out with every wire touching them; the input step stays, as every flow needs one. */
export function removeSteps(flow: Flow, ids: readonly string[]): Flow {
  const gone = new Set(
    flow.steps.filter((step) => ids.includes(step.id) && !isInput(step)).map((step) => step.id),
  );
  if (gone.size === 0) return flow;
  return {
    ...flow,
    steps: flow.steps.filter((step) => !gone.has(step.id)),
    wires: flow.wires.filter((wire) => !gone.has(wire.from) && !gone.has(wire.to)),
    layout: Object.fromEntries(Object.entries(placesOf(flow)).filter(([id]) => !gone.has(id))),
  };
}

/** The steps picked and the wires among them; the input step is never copied. */
export function fragmentOf(flow: Flow, ids: readonly string[]): Fragment | null {
  const steps = flow.steps.filter((step) => ids.includes(step.id) && !isInput(step));
  if (steps.length === 0) return null;
  const kept = new Set(steps.map((step) => step.id));
  const places = placesOf(flow);
  return {
    steps: structuredClone(steps),
    wires: flow.wires.filter((wire) => kept.has(wire.from) && kept.has(wire.to)).map((wire) => ({ ...wire })),
    layout: Object.fromEntries(steps.map((step) => [step.id, places[step.id]])),
  };
}

/**
 * Puts a fragment into the flow under ids of its own. Its top-left step lands
 * at `at`, or a little below and right of where it was copied from; the
 * fragment's steps that name each other - in jq, in a template - name the new
 * ids, so a pasted branch still reads its own steps.
 */
export function pasteFragment(flow: Flow, fragment: Fragment, at?: Point): { flow: Flow; ids: string[] } {
  const taken = flow.steps.map((step) => step.id);
  const renames = new Map<string, string>();
  for (const step of fragment.steps) {
    const id = freshStepId(step.id.replace(/_\d+$/, ""), [...taken, ...renames.values()]);
    renames.set(step.id, id);
  }
  const names = new Map<string, string>();
  for (const step of fragment.steps) {
    const shown = [...flow.steps.map((other) => other.name), ...names.values()];
    names.set(step.id, freshStepName(step.name, shown));
  }
  const renamed = (text: string) =>
    [...renames].reduce((current, [from, to]) => withStepRenamed(current, from, to), text);
  const corner = {
    x: Math.min(...Object.values(fragment.layout).map((point) => point.x)),
    y: Math.min(...Object.values(fragment.layout).map((point) => point.y)),
  };
  const shift =
    at === undefined
      ? { x: DUPLICATE_OFFSET, y: DUPLICATE_OFFSET }
      : { x: at.x - corner.x, y: at.y - corner.y };
  const idOf = (id: string) => renames.get(id) ?? id;

  const steps = fragment.steps.map((step) => ({
    ...step,
    id: idOf(step.id),
    name: names.get(step.id) ?? step.name,
    does: renamed(step.does),
    config: mapStrings(step.config, renamed) as Step["config"],
  }));
  const wires = fragment.wires.map((wire) => ({ ...wire, from: idOf(wire.from), to: idOf(wire.to) }));
  const layout = Object.fromEntries(
    Object.entries(fragment.layout).map(([id, point]) => [
      idOf(id),
      { x: Math.round(point.x + shift.x), y: Math.round(point.y + shift.y) },
    ]),
  );
  return {
    flow: {
      ...flow,
      steps: [...flow.steps, ...steps],
      wires: [...flow.wires, ...wires],
      layout: { ...placesOf(flow), ...layout },
    },
    ids: steps.map((step) => step.id),
  };
}

/** The picked steps again, beside the originals. */
export function duplicateSteps(flow: Flow, ids: readonly string[]): { flow: Flow; ids: string[] } {
  const fragment = fragmentOf(flow, ids);
  return fragment === null ? { flow, ids: [] } : pasteFragment(flow, fragment);
}

/**
 * Puts a step into a wire: what went from A to B now goes from A to the step
 * and on to B. The first half keeps the port it left A from; a loop's limit
 * stays with the half that goes back. On a wire that runs forward the step
 * takes the column after A, and B moves right with what follows it as far as
 * the room needs - dropped where it was let go, the step sat on top of both.
 */
export function insertOnWire(flow: Flow, wire: Wire, step: Step, at: Point): Flow {
  const into = { from: wire.from, port: wire.port, to: step.id };
  const onward: Wire = { from: step.id, port: OUT_PORT, to: wire.to, maxRounds: wire.maxRounds };
  if (onward.maxRounds === undefined) delete onward.maxRounds;
  return {
    ...flow,
    steps: [...flow.steps, step],
    wires: [
      ...flow.wires.filter((candidate) => candidate !== wire && !sameWire(candidate, wire)),
      into,
      onward,
    ],
    layout: roomOnWire(flow, wire, step.id, at),
  };
}

/** The layout with `id` put into `wire` and the steps after the wire moved right to make room. */
function roomOnWire(flow: Flow, wire: Wire, id: string, at: Point): Record<string, Point> {
  const places = placesOf(flow);
  const source = places[wire.from];
  const target = places[wire.to];
  if (target.x <= source.x) return { ...places, [id]: at };
  const spot = { x: source.x + COLUMN_STEP, y: source.y };
  const shift = spot.x + COLUMN_STEP - target.x;
  const moved =
    shift <= 0
      ? {}
      : Object.fromEntries(
          [...stepsOnward(flow, places, wire.to)].map((onward) => [
            onward,
            { x: places[onward].x + shift, y: places[onward].y },
          ]),
        );
  return { ...places, ...moved, [id]: spot };
}

/**
 * `from` and the steps its wires lead on to, rightwards. A loop's wire back
 * is not followed, nor one that turns to the start of the next row: what
 * sits there is not in the way.
 */
function stepsOnward(flow: Flow, places: Record<string, Point>, from: string): Set<string> {
  const loops = new Set(loopWires(flow));
  const reached = new Set([from]);
  const waiting = [from];
  for (let id = waiting.pop(); id !== undefined; id = waiting.pop()) {
    for (const wire of flow.wires) {
      const forward = !loops.has(wire) && places[wire.to].x > places[wire.from].x;
      if (wire.from === id && forward && !reached.has(wire.to)) {
        reached.add(wire.to);
        waiting.push(wire.to);
      }
    }
  }
  return reached;
}

/** Cuts every wire into and out of a step, leaving it where it is. */
export function disconnect(flow: Flow, id: string): Flow {
  return { ...flow, wires: flow.wires.filter((wire) => wire.from !== id && wire.to !== id) };
}

function sameWire(a: Wire, b: Wire): boolean {
  return a.from === b.from && a.port === b.port && a.to === b.to;
}
