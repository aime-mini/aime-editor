import dagre from "@dagrejs/dagre";
import type { Flow, Step } from "./model";
import { loopWires } from "./validate";

/** A step's card on the canvas (`StepNode`, `w-48`), for laying cards out before they are drawn. */
export const NODE_WIDTH = 192;
export const NODE_HEIGHT = 64;

/** The space between two columns of steps, and around the whole flow. */
const COLUMN_GAP = 56;
const MARGIN = 20;
/**
 * How many columns a row holds before a long flow wraps onto the next one, as
 * the designer draws it (screen 02). A flow laid out in one long line had to
 * be zoomed out until no step could be read; three cards are what the canvas
 * beside the palette and the inspector shows at life size in a 1280px window
 * (measured: 800px of canvas, where four needed 79%).
 */
const COLUMNS_PER_ROW = 3;
const ROW_GAP = 72;

type Positions = Record<string, { x: number; y: number }>;

/**
 * Left to right, by dagre, wrapping every `COLUMNS_PER_ROW` columns; loop
 * wires are left out so the body reads forward. A column is the set of steps
 * dagre put at the same depth, so branches stay side by side within a row.
 */
export function arrange(flow: Flow): Positions {
  const loops = new Set(loopWires(flow));
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 28, ranksep: COLUMN_GAP, marginx: MARGIN, marginy: MARGIN });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const step of flow.steps) graph.setNode(step.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const wire of flow.wires) if (!loops.has(wire)) graph.setEdge(wire.from, wire.to);
  dagre.layout(graph);

  // dagre types its node records loosely; x and y are the centre it chose.
  const centres = flow.steps.map((step) => ({
    id: step.id,
    ...(graph.node(step.id) as { x: number; y: number }),
  }));
  const columns = [...new Set(centres.map((centre) => Math.round(centre.x)))].sort((a, b) => a - b);
  const top = Math.min(...centres.map((centre) => centre.y));
  const bottom = Math.max(...centres.map((centre) => centre.y));
  const rowHeight = bottom - top + NODE_HEIGHT + ROW_GAP;

  const positions: Positions = {};
  for (const centre of centres) {
    const column = columns.indexOf(Math.round(centre.x));
    const row = Math.floor(column / COLUMNS_PER_ROW);
    positions[centre.id] = {
      x: MARGIN + (column % COLUMNS_PER_ROW) * (NODE_WIDTH + COLUMN_GAP),
      y: Math.round(MARGIN + row * rowHeight + centre.y - top),
    };
  }
  return positions;
}

/** From one column of steps to the next. */
export const COLUMN_STEP = NODE_WIDTH + COLUMN_GAP;
const ROW_STEP = NODE_HEIGHT + ROW_GAP;

/**
 * Where a step added from the palette goes: in the next column after the
 * picked step, or at the start of the next row when that row is full - the
 * way Arrange wraps - and never on top of a card already there. With nothing
 * picked, under everything.
 */
export function placeBeside(flow: Flow, anchor: Step | undefined): { x: number; y: number } {
  const positions = flow.layout ?? arrange(flow);
  const taken = Object.values(positions);
  const base = anchor === undefined ? undefined : positions[anchor.id];
  let spot: { x: number; y: number };
  if (base === undefined) {
    spot = { x: MARGIN, y: taken.length === 0 ? MARGIN : Math.max(...taken.map((p) => p.y)) + ROW_STEP };
  } else {
    const column = Math.round((base.x - MARGIN) / COLUMN_STEP);
    spot =
      column + 1 < COLUMNS_PER_ROW
        ? { x: base.x + COLUMN_STEP, y: base.y }
        : { x: MARGIN, y: base.y + ROW_STEP };
  }
  const occupied = (at: { x: number; y: number }) =>
    taken.some((p) => Math.abs(p.x - at.x) < NODE_WIDTH && Math.abs(p.y - at.y) < NODE_HEIGHT);
  while (occupied(spot)) spot = { ...spot, y: spot.y + ROW_STEP };
  return spot;
}
