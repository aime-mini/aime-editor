/**
 * The phases of a Task Run, and what each one has to prove before the next may
 * start.
 *
 * A run is not a chat turn. It is a sequence of phases, each ending in a gate
 * that something other than the author can check — the test runner, the
 * language server, git, a count. A red gate stops the run where it stands, with
 * the reason on screen, rather than carrying a wrong assumption into the next
 * twenty minutes of work.
 *
 * The order is deliberate and the reasoning is in the phase list below: the
 * cheapest mistakes to catch come first.
 */

export type PhaseId =
  "baseline" | "understand" | "locate" | "plan" | "implement" | "regression" | "review" | "report";

/** Who does the work of a phase, which decides what it is allowed to touch. */
export type PhaseWorker =
  /** Tools only: no model runs, so nothing can be imagined. */
  | "tools"
  /** A model that may only read. */
  | "reader"
  /** A model that may edit files. Only two phases ever get this. */
  | "writer";

export interface Phase {
  id: PhaseId;
  worker: PhaseWorker;
  /** True when a red gate here stops the run rather than being noted. */
  blocking: boolean;
}

/**
 * The phases in order.
 *
 * `understand` and `locate` are early because a run that misread the ticket or
 * missed half the callers is wrong in a way no amount of later checking
 * recovers — and stopping there costs a minute instead of an hour.
 *
 * `implement` is the only phase besides `plan`'s tests that may write, and
 * `regression` immediately after it is the reason a run can be left alone.
 */
export const PHASES: Phase[] = [
  { id: "baseline", worker: "tools", blocking: true },
  { id: "understand", worker: "reader", blocking: true },
  { id: "locate", worker: "reader", blocking: false },
  { id: "plan", worker: "reader", blocking: true },
  { id: "implement", worker: "writer", blocking: true },
  { id: "regression", worker: "tools", blocking: true },
  { id: "review", worker: "reader", blocking: false },
  { id: "report", worker: "tools", blocking: false },
];

/** Where a phase stands. */
export type PhaseState =
  | "waiting"
  | "running"
  /** Its gate was satisfied. */
  | "passed"
  /** Its gate refused, and the run stopped here. */
  | "blocked"
  /** It had nothing to do, which is not the same as having passed. */
  | "skipped"
  /** The run was stopped by hand before this phase got its turn. */
  | "cancelled";

/** What one phase produced, and what its gate made of it. */
export interface PhaseResult {
  state: PhaseState;
  /** One line for the reader: what happened, or why it stopped. */
  summary: string;
  /** Longer evidence — a diff, a test table, a list. Shown when opened. */
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

/** A whole run, as the panel shows it and as it is written to disk. */
export interface Run {
  id: string;
  /** The work item this run is about, for the header and the report. */
  itemId: string;
  itemTitle: string;
  /** Where it is working: always a branch of its own, never the user's. */
  branch: string | null;
  startedAt: number;
  results: Partial<Record<PhaseId, PhaseResult>>;
  /** The phase running now, or null when the run is over. */
  current: PhaseId | null;
  /** Set when the run ended, so the panel can say how. */
  ended: RunEnding | null;
}

export type RunEnding =
  | { kind: "done" }
  /** A blocking gate refused; `phase` says which, `why` says what it wanted. */
  | { kind: "blocked"; phase: PhaseId; why: string }
  /** Waiting on the reader — the plan needs approval, or a question needs an answer. */
  | { kind: "waiting"; phase: PhaseId; question: string }
  | { kind: "cancelled" }
  /** Something broke that is not the change's fault. */
  | { kind: "failed"; phase: PhaseId; error: string };

/** A fresh run over one work item. */
export function newRun(id: string, itemId: string, itemTitle: string, startedAt: number): Run {
  return {
    id,
    itemId,
    itemTitle,
    branch: null,
    startedAt,
    results: {},
    current: null,
    ended: null,
  };
}

/** The phase after this one, or null at the end of the list. */
export function nextPhase(after: PhaseId): PhaseId | null {
  const at = PHASES.findIndex((phase) => phase.id === after);
  return PHASES[at + 1]?.id ?? null;
}

export function phaseAt(id: PhaseId): Phase {
  const found = PHASES.find((phase) => phase.id === id);
  // The ids are a closed union, so this cannot happen; the throw is here so a
  // future phase added to one list and not the other fails loudly.
  if (found === undefined) throw new Error(`no such phase: ${id}`);
  return found;
}

/**
 * Whether a run may go on after this result.
 *
 * A blocked phase stops the run only when that phase is a blocking one — a
 * review that found something worth saying is worth saying, not worth stopping
 * a finished change over.
 */
export function mayContinue(id: PhaseId, result: PhaseResult): boolean {
  if (result.state === "cancelled") return false;
  return result.state !== "blocked" || !phaseAt(id).blocking;
}

/** Every phase that never got its turn, marked as such rather than left blank. */
export function abandonRest(run: Run, from: PhaseId, state: PhaseState, summary: string): Run {
  const at = PHASES.findIndex((phase) => phase.id === from);
  const results = { ...run.results };
  for (const phase of PHASES.slice(at + 1)) {
    results[phase.id] = { state, summary };
  }
  return { ...run, results, current: null };
}

/** How far along a run is, for a progress line that does not lie. */
export function progressOf(run: Run): { done: number; total: number } {
  const done = PHASES.filter((phase) => {
    const state = run.results[phase.id]?.state;
    return state === "passed" || state === "skipped";
  }).length;
  return { done, total: PHASES.length };
}
