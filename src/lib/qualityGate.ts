import { folderOf, type TaskDef } from "../stores/tasks";
import { allOutput, type CommandOutcome } from "./exec";

/**
 * The gate that answers "would this code be allowed in?".
 *
 * Not the test suite's job and not a reviewer's opinion: the project's own
 * linter, type checker and formatter, run exactly as the project runs them. In
 * this repository that is `npm run check` and `cargo clippy`; in someone else's
 * it is whatever they declared. Aime never invents the standard — a rule the
 * team did not write is a rule the team did not agree to.
 *
 * Compared against a pass taken before the change, for the same reason the test
 * gate is: a project that was already failing its own linter is not this
 * change's doing, and a gate that blamed it would be a gate nobody keeps.
 */

/** One check, and what running it said. */
export interface CheckRun {
  /** The task's id, which is how the same check is matched across two passes. */
  id: string;
  /** How it reads on screen - "npm run check". */
  label: string;
  command: string;
  /** Null when the command would not start at all. */
  outcome: CommandOutcome | null;
  /** Why there is no outcome, when there is none. */
  error: string | null;
}

/** Every check of the project, on one pass. */
export interface CheckPass {
  checks: CheckRun[];
}

/**
 * How long one check is given. Shorter than a suite on purpose: a linter that
 * has not finished in ten minutes is not linting.
 */
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** Every check command the project declares, in the order it was detected. */
export function checkTasksOf(tasks: TaskDef[]): TaskDef[] {
  return tasks.filter((task) => task.kind === "check");
}

/** Runs every check once. */
export async function runChecks(
  tasks: TaskDef[],
  root: string,
  nextId: () => string,
  run: (id: string, command: string, cwd: string, timeoutMs: number) => Promise<CommandOutcome>,
): Promise<CheckPass> {
  const checks: CheckRun[] = [];
  for (const task of checkTasksOf(tasks)) {
    const base = { id: task.id, label: task.label, command: task.command };
    try {
      const outcome = await run(nextId(), task.command, folderOf(task, root), CHECK_TIMEOUT_MS);
      checks.push({ ...base, outcome, error: null });
    } catch (error: unknown) {
      checks.push({ ...base, outcome: null, error: String(error) });
    }
  }
  return { checks };
}

/** Whether one check is satisfied. A check that could not run is not. */
export function isClean(check: CheckRun): boolean {
  return check.outcome !== null && check.outcome.code === 0;
}

/**
 * Checks the change has to answer for: failing now, and not failing before.
 *
 * A check that could not run at all in the baseline is left out entirely rather
 * than counted either way — it never established anything to regress from.
 */
export function newlyFailing(before: CheckPass, after: CheckPass): CheckRun[] {
  const wasClean = new Set(before.checks.filter(isClean).map((check) => check.id));
  return after.checks.filter((check) => !isClean(check) && wasClean.has(check.id));
}

/** Checks that were already failing before the change, so not its fault. */
export function alreadyFailing(before: CheckPass, after: CheckPass): CheckRun[] {
  const wasDirty = new Set(before.checks.filter((check) => !isClean(check)).map((check) => check.id));
  return after.checks.filter((check) => !isClean(check) && wasDirty.has(check.id));
}

/** How much of a failing check's output is worth handing to whoever must fix it. */
const OUTPUT_LIMIT = 6_000;

/**
 * What the failing checks said, tail first.
 *
 * The tail, because every one of these tools prints its summary last and its
 * progress first, and the summary is the part that names the file and line.
 */
export function checkEvidence(checks: CheckRun[]): string {
  return checks
    .map((check) => {
      const said = check.outcome === null ? (check.error ?? "") : allOutput(check.outcome);
      return [`$ ${check.command}`, said.slice(-OUTPUT_LIMIT)].join("\n");
    })
    .join("\n\n");
}
