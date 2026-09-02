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

export type PhaseId = "understand" | "design" | "implement" | "verify" | "review" | "report";

/**
 * The model a phase runs, which decides what that model is allowed to touch.
 *
 * It describes the model, not the phase: Aime's own tool work - taking a
 * branch, running the declared suites, reading files off disk - happens in
 * whichever phase needs it and is never a model's doing.
 */
export type PhaseWorker =
  /** No model runs at all, so nothing in this phase can be imagined. */
  | "tools"
  /** A model that may only read. */
  | "reader"
  /** A model that may edit files. */
  | "writer";

export interface Phase {
  id: PhaseId;
  worker: PhaseWorker;
  /** True when a red gate here stops the run rather than being noted. */
  blocking: boolean;
}

/**
 * The phases in order: the six steps a developer already takes.
 *
 * Understand the task and the code it lands in, decide the approach, write it,
 * test it until the bugs are out, check your own work, hand it over. Named that
 * way on purpose - a run whose steps a person does not recognise is a run they
 * cannot judge the progress of.
 *
 * A phase is a *gate*, not a chapter heading, and gates are cheap: two of these
 * run no model at all in their own right. What is not cheap is a model call, so
 * questions that share one answer share one phase. `understand` reads the ticket
 * and the code together, because what a change is for cannot be settled without
 * the code it will live in. `design` settles the approach, the test cases and
 * the plan in one page - the page the reader is asked to agree to - because a
 * plan can be flawless about the wrong approach.
 *
 * The last three are what make walking away rational. `verify` cannot be
 * argued with: the project's own checks and every suite it declares, measured
 * against the baseline taken in step one, what this change broke put right and
 * measured again, and then the thing built, deployed and driven where a case
 * needs the running software to be believed. `review` is a reader with a clean
 * context that then fixes what it found. `report` is what a person comes back
 * to. A run that downed tools at the first red gate would hand back homework,
 * so every gate here tries again before it refuses, and refusing is the last
 * resort.
 */
export const PHASES: Phase[] = [
  // Aime's own work comes first inside this one: a branch of its own, and every
  // suite and check as they stand. Without that baseline "your change broke
  // this" and "this was already broken" are the same sentence, which is the
  // sentence that makes every later gate untrustworthy.
  { id: "understand", worker: "reader", blocking: true },
  { id: "design", worker: "reader", blocking: true },
  // The tests are written here with the code, not in a phase of their own. The
  // hole that leaves - a test asserting nothing passes just as well - is what
  // `review` reads the diff for.
  { id: "implement", worker: "writer", blocking: true },
  // Measuring and mending are one phase, not three: finding a regression and
  // then reporting it is what handing back homework looks like. Its own loops
  // live inside - the checks are fixed until they pass, the suites until they
  // are no worse than the baseline, the declared builds until they build - and
  // only what will not mend stops the run.
  { id: "verify", worker: "writer", blocking: true },
  // Blocking, but selectively: what stops a run here is an unfixed finding
  // about architecture or security, because a change sitting in the wrong layer
  // does not belong in the repository however well it works. A reviewer's taste
  // is the one voice here that can simply be wrong, so everything else it found
  // is reported and never fatal.
  { id: "review", worker: "writer", blocking: true },
  { id: "report", worker: "tools", blocking: false },
];

// A run saved by a build that had ten phases is not translated into these six:
// its journal is a version behind and `readRun` ignores it outright, which is
// the mechanism this file already uses for a shape change (see SavedRun's
// version). Half-reading someone's record would be worse than not offering it.

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
 * A blocked phase stops the run only when that phase is a blocking one. Which
 * findings are worth stopping for is the phase's own judgement, not this
 * function's: `review` decides that an unfixed architecture or security finding
 * is, and that its opinion of a name is not.
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
