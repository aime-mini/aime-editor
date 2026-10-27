/**
 * Undo and redo for the designer: every version of the flow the person made.
 *
 * Edits close together are one step back, the way an editor treats typing: a
 * name typed letter by letter is undone in one go, not one letter at a time.
 * A drag is already one edit - the canvas reports a step's place when it is
 * dropped, not while it moves.
 */
import type { Flow } from "./model";

/** Edits closer together than this are undone together. */
export const MERGE_WITHIN_MS = 1000;
/** How far back undo reaches. */
const DEPTH = 100;

export interface History {
  past: Flow[];
  future: Flow[];
  /** When the last version was kept, for merging the edits that follow it. */
  lastAt: number;
}

export const EMPTY_HISTORY: History = { past: [], future: [], lastAt: 0 };

/** Keeps the flow as it was before an edit made at `now`; a new edit drops what had been undone. */
export function recorded(history: History, before: Flow, now: number): History {
  if (now - history.lastAt < MERGE_WITHIN_MS && history.past.length > 0) {
    return { ...history, future: [], lastAt: now };
  }
  return { past: [...history.past, before].slice(-DEPTH), future: [], lastAt: now };
}

/** One step back from `current`, or null when there is nothing to undo. */
export function undone(history: History, current: Flow): { history: History; flow: Flow } | null {
  const flow = history.past.at(-1);
  if (flow === undefined) return null;
  return {
    flow,
    history: { past: history.past.slice(0, -1), future: [current, ...history.future], lastAt: 0 },
  };
}

/** One step forward again, or null when nothing was undone. */
export function redone(history: History, current: Flow): { history: History; flow: Flow } | null {
  const flow = history.future.at(0);
  if (flow === undefined) return null;
  return { flow, history: { past: [...history.past, current], future: history.future.slice(1), lastAt: 0 } };
}
