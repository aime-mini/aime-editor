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
  | "baseline"
  | "understand"
  | "design"
  | "tests"
  | "implement"
  | "verify"
  | "review"
  | "polish"
  | "deliver"
  | "report";

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
 * The shape of it: **understand what is asked and the ground it stands on,
 * decide how and what proof looks like, get it confirmed, then write — and prove
 * every claim with something that is not the author.**
 *
 * There are ten of them because a phase is a *gate*, not a chapter heading:
 * splitting one question into three costs three model calls and buys nothing a
 * reader can act on. So `understand` reads the ticket and the code together —
 * the ground a change stands on is part of understanding it — and `design`
 * settles the approach, the test cases and the plan in one answer, which is the
 * page the reader is asked to agree to. Anything a person could not redirect on
 * its own is not worth stopping for.
 *
 * `tests` stays separate so red-then-green can be *measured*: the tests go in
 * first and the suites must get worse, because a test that passes before the
 * code exists is testing nothing. `implement` then has to turn that red green.
 *
 * The rest are what make walking away rational. `verify` is the one that
 * cannot be argued with: the project's own checks and every suite it declares,
 * measured against the baseline, with what this change broke fixed and measured
 * again until it holds. `review` is a reader with a clean context, `polish` acts
 * on what it found, `deliver` builds, deploys and proves every case against the
 * running software, and `report` is what a person comes back to. A run that
 * downed tools at the first red gate would hand back homework, so every gate
 * here tries again before it refuses, and refusing is the last resort.
 */
export const PHASES: Phase[] = [
  { id: "baseline", worker: "tools", blocking: true },
  { id: "understand", worker: "reader", blocking: true },
  { id: "design", worker: "reader", blocking: true },
  { id: "tests", worker: "writer", blocking: true },
  { id: "implement", worker: "writer", blocking: true },
  // Measuring and mending are one phase, not three: finding a regression and
  // then reporting it is what handing back homework looks like. Its own loops
  // live inside - the checks are fixed until they pass, the suites until they
  // are no worse than the baseline - and only what will not mend stops the run.
  { id: "verify", worker: "writer", blocking: true },
  { id: "review", worker: "reader", blocking: false },
  // A finding the polish phase could not fix is reported, not fatal: a reviewer
  // is the one voice here that can be wrong, so it never gets to end the work.
  { id: "polish", worker: "writer", blocking: false },
  // "Done" means deployed and seen working, not green on a dev machine: the
  // declared builds run, the software is deployed the way this project deploys,
  // and every agreed case is proved against the running thing - with artifacts
  // on disk, because Aime checks files, not claims. Last of the writers so that
  // what gets deployed is the polished code, not a draft of it.
  { id: "deliver", worker: "writer", blocking: true },
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
  /**
   * Cut off rather than ended: the app closed, the machine slept, the network
   * went. Read back from the journal, and offered to be carried on.
   */
  | { kind: "interrupted"; phase: PhaseId }
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
