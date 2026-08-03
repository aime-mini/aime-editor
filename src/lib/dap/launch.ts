import type { AdapterBreakpoint, SourceBreakpoint } from "./protocol";

/**
 * The launch configuration for one program.
 *
 * `configType` comes from the Rust adapter catalog rather than from a table
 * repeated here, so adding an adapter is a one-file change. Everything else is
 * the same for every adapter Aime drives: run this file, in this folder, and
 * report the program's output over the protocol instead of opening a console
 * window the editor cannot read.
 */
export function launchConfig(configType: string, program: string, cwd: string): Record<string, unknown> {
  const common = {
    type: configType,
    request: "launch",
    name: "Aime",
    program,
    cwd,
    // Output comes back as `output` events. Any other console setting hands the
    // program to a terminal Aime does not own, and the Debug Console stays empty.
    console: "internalConsole",
    stopOnEntry: false,
  };

  if (configType === "pwa-node") {
    return {
      ...common,
      // Node's own frames are noise in a user's call stack, and a debugger that
      // steps into them looks broken.
      skipFiles: ["<node_internals>/**"],
      sourceMaps: true,
    };
  }
  if (configType === "python") {
    return { ...common, justMyCode: true };
  }
  if (configType === "go") {
    // delve compiles the program before running it, and `mode` is how its
    // launch request is told to: without it there is nothing to debug. "debug"
    // is `dlv debug` — build this source, then run the binary under the
    // debugger — which is what pressing F5 on a .go file means.
    return { ...common, mode: "debug" };
  }
  return common;
}

/** A breakpoint in the editor: what was asked for, and what the adapter made of it. */
export interface EditorBreakpoint {
  /** The line the user clicked. Kept so the adapter can be asked again after an edit. */
  line: number;
  /** Where the adapter actually placed it; null until an adapter has answered. */
  actualLine: number | null;
  verified: boolean;
  /**
   * The id the adapter gave it. Useless for reading the `setBreakpoints`
   * answer — that is positional — but it is the only handle a later
   * `breakpoint` event carries, and js-debug resolves its breakpoints that way.
   */
  id: number | null;
  /**
   * Why the adapter would not take it, in the adapter's own words.
   *
   * Not decoration: delve refuses a breakpoint on a line without a statement
   * rather than moving it to one ("could not find statement at main.go:8,
   * please use a line with a statement"). Dropping that leaves the user with a
   * grey dot and no idea why, on a line where js-debug would simply have moved
   * it - the reason is the only thing that distinguishes the two.
   */
  message: string | null;
}

export function newBreakpoint(line: number): EditorBreakpoint {
  return { line, actualLine: null, verified: false, id: null, message: null };
}

/** The line to draw the marker on: what the adapter said, or what was asked. */
export function displayLine(breakpoint: EditorBreakpoint): number {
  return breakpoint.actualLine ?? breakpoint.line;
}

export function toSourceBreakpoints(breakpoints: EditorBreakpoint[]): SourceBreakpoint[] {
  return breakpoints.map((breakpoint) => ({ line: breakpoint.line }));
}

/**
 * Folds an adapter's `setBreakpoints` answer back into the editor's list.
 *
 * Matching is **by position in the array**, as the specification requires:
 * the nth answer belongs to the nth request. Ids are captured on the way past
 * but never used to match here — debugpy numbers from 0, js-debug from 1, and
 * neither guarantees the answers come back in id order.
 *
 * An answer shorter than the request (an adapter that dropped one) leaves the
 * extra breakpoints unverified rather than shifting every marker up by one.
 */
export function applyBreakpointAnswer(
  requested: EditorBreakpoint[],
  answered: AdapterBreakpoint[],
): EditorBreakpoint[] {
  return requested.map((breakpoint, index) => {
    const answer = answered[index] as AdapterBreakpoint | undefined;
    if (!answer) return { ...breakpoint, actualLine: null, verified: false, id: null, message: null };
    return {
      line: breakpoint.line,
      // A provisional answer carries no line; the requested one is the best
      // guess until the adapter says otherwise in a `breakpoint` event.
      actualLine: answer.line ?? breakpoint.line,
      verified: answer.verified === true,
      id: answer.id ?? null,
      message: answer.message ?? null,
    };
  });
}

/**
 * Folds a `breakpoint` event into the editor's list, matching **by id**.
 *
 * This is not a second way of doing the same thing. Measured against js-debug
 * 1.117.0: it answers `setBreakpoints` with `verified: false`, no line, and
 * `message: "breakpoint.provisionalBreakpoint"` — the real answer arrives later
 * as `breakpoint` events, out of order, each carrying only its id. Without
 * this, every js-debug breakpoint stays grey and drawn on the wrong line while
 * the program stops on the right one.
 */
export function applyBreakpointEvent(
  breakpoints: EditorBreakpoint[],
  changed: AdapterBreakpoint,
): EditorBreakpoint[] {
  if (changed.id === undefined) return breakpoints;
  const index = breakpoints.findIndex((breakpoint) => breakpoint.id === changed.id);
  // Same array when nothing matched: the caller uses identity to skip a redraw.
  if (index === -1) return breakpoints;

  const target = breakpoints[index];
  const updated = [...breakpoints];
  updated[index] = {
    ...target,
    actualLine: changed.line ?? target.actualLine,
    verified: changed.verified === true,
    message: changed.message ?? null,
  };
  return updated;
}
