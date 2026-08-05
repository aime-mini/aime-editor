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
export function launchConfig(
  configType: string,
  program: string,
  cwd: string,
  /**
   * Fields a taught adapter declared it needs (`mainClass`, `classPaths`, …).
   * Merged last: an adapter Aime never measured knows its own requirements
   * better than this function does.
   */
  extra: Record<string, unknown> = {},
  /** What this target passes to its program (`.aime/launch.json`). */
  options: { args?: string[]; env?: Record<string, string> } = {},
): Record<string, unknown> {
  const common = {
    type: configType,
    request: "launch",
    name: "Aime",
    program,
    cwd,
    // Both are protocol fields every adapter reads; empty ones are left out so a
    // configuration says only what it means.
    ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
    ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
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
      ...extra,
    };
  }
  if (configType === "python") {
    return { ...common, justMyCode: true, ...extra };
  }
  if (configType === "go") {
    // delve compiles the program before running it, and `mode` is how its
    // launch request is told to: without it there is nothing to debug. "debug"
    // is `dlv debug` — build this source, then run the binary under the
    // debugger — which is what pressing F5 on a .go file means.
    return { ...common, mode: "debug", ...extra };
  }
  return { ...common, ...extra };
}

/** Where a program that is already running can be reached. */
export interface AttachTarget {
  host: string;
  port: number;
}

/**
 * The configuration for attaching to a program that is already running.
 *
 * Every adapter spells this differently and there is no way around knowing
 * which: js-debug takes a flat `port`, debugpy expects a `connect` object, and
 * anything Aime was taught brings its own fields. The shared half - the request
 * kind and where source is - is still shared.
 */
export function attachConfig(
  configType: string,
  target: AttachTarget,
  cwd: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const common = { type: configType, request: "attach", name: "Aime", cwd };

  if (configType === "pwa-node") {
    // js-debug attaches to a Node inspector port (`node --inspect`), and its own
    // frames are as much noise here as in a launch.
    return {
      ...common,
      address: target.host,
      port: target.port,
      skipFiles: ["<node_internals>/**"],
      ...extra,
    };
  }
  if (configType === "python") {
    // debugpy listens with `python -m debugpy --listen`, and the client connects.
    return { ...common, connect: { host: target.host, port: target.port }, justMyCode: true, ...extra };
  }
  return { ...common, host: target.host, port: target.port, ...extra };
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
  /**
   * What makes this breakpoint fire, all three optional and all three the
   * adapter's job rather than Aime's: an expression that has to be true, a hit
   * count expression ("> 5"), and a message to log instead of stopping.
   *
   * A logpoint is the one that changes the nature of the breakpoint - the
   * program does not stop, the message goes to the Debug Console - and adapters
   * that do not support one simply stop instead, which is why the marker says
   * which kind it is.
   */
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** Everything about a breakpoint except where it is. */
export type BreakpointRule = Pick<EditorBreakpoint, "condition" | "hitCondition" | "logMessage">;

export function newBreakpoint(line: number, rule: BreakpointRule = {}): EditorBreakpoint {
  return {
    line,
    actualLine: null,
    verified: false,
    id: null,
    message: null,
    ...stripEmpty(rule),
  };
}

/** An empty expression is not a rule; storing it would send `condition: ""`. */
export function stripEmpty(rule: BreakpointRule): BreakpointRule {
  const kept: BreakpointRule = {};
  if (rule.condition?.trim()) kept.condition = rule.condition.trim();
  if (rule.hitCondition?.trim()) kept.hitCondition = rule.hitCondition.trim();
  if (rule.logMessage?.trim()) kept.logMessage = rule.logMessage.trim();
  return kept;
}

/** Whether anything makes this breakpoint conditional, for the marker to say so. */
export function hasRule(breakpoint: EditorBreakpoint): boolean {
  return Boolean(breakpoint.condition ?? breakpoint.hitCondition ?? breakpoint.logMessage);
}

/** The line to draw the marker on: what the adapter said, or what was asked. */
export function displayLine(breakpoint: EditorBreakpoint): number {
  return breakpoint.actualLine ?? breakpoint.line;
}

export function toSourceBreakpoints(breakpoints: EditorBreakpoint[]): SourceBreakpoint[] {
  // The rules travel with the line, and the adapter enforces them: evaluating a
  // condition here would mean stopping the program to ask, then resuming it,
  // which is precisely the overhead the protocol exists to avoid.
  return breakpoints.map((breakpoint) => ({
    line: breakpoint.line,
    ...stripEmpty(breakpoint),
  }));
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
      // Spread first: the rules the user set are the editor's, not the answer's.
      ...breakpoint,
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
