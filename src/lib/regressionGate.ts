import { folderOf, type TaskDef } from "../stores/tasks";
import { allOutput, type CommandOutcome } from "./exec";
import { compareRuns, isRegression, readTestOutput, type Comparison, type TestReport } from "./testReport";

/**
 * The gate that answers "did this change break anything that was working?".
 *
 * It is the cheapest honest answer there is: run the project's own test
 * commands before the change and again after it, and compare. No opinion, no
 * model, no heuristic — the same suites, twice, and the difference between the
 * two.
 *
 * **Every** suite, not the first one. A repository that keeps `test` apart from
 * `test:e2e` has two of them, and a gate that runs one while reporting on the
 * project has measured half of it — which is worse than measuring none, because
 * it says the word "passing" out loud.
 *
 * Three outcomes are worth telling apart, and a gate that collapses them lies:
 * a project with no test command cannot be checked at all, a suite that was
 * already failing is not this change's fault, and a test that was passing and
 * is not any more is the one thing that blocks.
 */

/** One run of one suite, kept so the two passes can be compared and shown. */
export interface SuiteRun {
  /** The command line that was run, so a report can say what it measured. */
  command: string;
  report: TestReport;
  outcome: CommandOutcome;
}

/** Why one suite has nothing to say. */
export type SuiteSilence =
  /** The command itself would not start - a missing runner, a bad folder. */
  | { reason: "couldNotRun"; detail: string }
  /**
   * It ran and never stopped. Reported apart from a failure on purpose: a suite
   * killed at the timeout says nothing about the code, and counting it as red
   * would blame the change for a watcher.
   */
  | { reason: "didNotFinish"; detail: string };

/** What one suite did on one pass over the project. */
export interface SuiteAttempt {
  /** The task's id, which is how the same suite is matched across two passes. */
  id: string;
  /** How the suite is named on screen - "npm test:e2e". */
  label: string;
  run: SuiteRun | null;
  silence: SuiteSilence | null;
}

/** Every suite of the project, on one pass. */
export interface Baseline {
  suites: SuiteAttempt[];
}

/** One suite's before and after, and what moved between them. */
export interface SuiteComparison {
  id: string;
  label: string;
  comparison: Comparison;
  before: SuiteRun;
  after: SuiteRun;
}

/** What the gate concluded once both passes are in. */
export interface GateVerdict {
  suites: SuiteComparison[];
  /** Suites that had something to say before and nothing to say now. */
  silent: SuiteAttempt[];
  /** True when the run must not carry on as though nothing happened. */
  blocks: boolean;
}

/** How long one suite is given before it is treated as hung. */
export const SUITE_TIMEOUT_MS = 15 * 60 * 1000;

/** How a caller runs a command; injected so this module is testable. */
export type RunCommand = (
  id: string,
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<CommandOutcome>;

/**
 * Every test command the project declares, in the order it was detected.
 *
 * All of them: which one matters is not a question this can answer, and the
 * one that does not run is exactly the one a change tends to break.
 */
export function testTasksOf(tasks: TaskDef[]): TaskDef[] {
  return tasks.filter((task) => task.kind === "test");
}

/**
 * Runs every suite once and reads what each said.
 *
 * Taken before a change this is the baseline; taken after, it is the thing
 * compared against it. A project with no test command answers with no suites
 * rather than an empty pass, because "nothing to check" and "everything is
 * fine" are the two answers a gate must never confuse.
 *
 * `skip` is how a later pass avoids a suite the baseline already proved
 * unusable: paying a fifteen-minute timeout again, three times over in the
 * repair loop, buys nothing that the first timeout did not already say.
 */
export async function runSuites(
  tasks: TaskDef[],
  root: string,
  nextId: () => string,
  run: RunCommand,
  skip: ReadonlySet<string> = new Set(),
): Promise<Baseline> {
  const suites: SuiteAttempt[] = [];
  for (const task of testTasksOf(tasks)) {
    if (skip.has(task.id)) continue;
    suites.push(await runOne(task, root, nextId(), run));
  }
  return { suites };
}

async function runOne(task: TaskDef, root: string, id: string, run: RunCommand): Promise<SuiteAttempt> {
  const attempt = { id: task.id, label: task.label };
  try {
    const outcome = await run(id, task.command, folderOf(task, root), SUITE_TIMEOUT_MS);
    if (outcome.timedOut) {
      return {
        ...attempt,
        run: null,
        silence: { reason: "didNotFinish", detail: task.command },
      };
    }
    return {
      ...attempt,
      run: {
        command: task.command,
        report: readTestOutput(allOutput(outcome), outcome.code),
        outcome,
      },
      silence: null,
    };
  } catch (error: unknown) {
    // The command could not even start. That is not a failing suite, and
    // calling it one would blame the change for a missing runner.
    return { ...attempt, run: null, silence: { reason: "couldNotRun", detail: String(error) } };
  }
}

/** Every suite that answered on this pass. */
export function measured(baseline: Baseline): SuiteAttempt[] {
  return baseline.suites.filter((suite) => suite.run !== null);
}

/** Every suite that could not be measured, with the reason it could not. */
export function unusable(baseline: Baseline): SuiteAttempt[] {
  return baseline.suites.filter((suite) => suite.silence !== null);
}

/** The ids no later pass should spend time on again. */
export function skipList(baseline: Baseline): Set<string> {
  return new Set(unusable(baseline).map((suite) => suite.id));
}

/**
 * Compares a pass taken after a change with the baseline taken before it.
 *
 * Matched by task id rather than by position: a pass that skipped a suite must
 * not be read against the wrong one, and a suite that has gone quiet is
 * reported as quiet instead of silently dropping out of the verdict.
 */
export function judge(before: Baseline, after: Baseline): GateVerdict {
  const suites: SuiteComparison[] = [];
  const silent: SuiteAttempt[] = [];
  for (const was of measured(before)) {
    const now = after.suites.find((suite) => suite.id === was.id);
    if (now === undefined) continue;
    if (now.run === null) {
      silent.push(now);
      continue;
    }
    // Non-null by the loop above; kept in a const so the reader can see it.
    const beforeRun = was.run;
    if (beforeRun === null) continue;
    suites.push({
      id: was.id,
      label: was.label,
      comparison: compareRuns(beforeRun.report, now.run.report),
      before: beforeRun,
      after: now.run,
    });
  }
  return {
    suites,
    silent,
    // A suite that stopped answering blocks as well: it was measurable before
    // this change and is not now, which is a thing the change did.
    blocks: suites.some((suite) => isRegression(suite.comparison)) || silent.length > 0,
  };
}

/** Every test named as newly broken, across all suites. */
export function brokenNames(verdict: GateVerdict): string[] {
  return verdict.suites.flatMap((suite) => suite.comparison.broken);
}

/**
 * Whether the two passes differ at all in the only direction that proves a test
 * is worth having: something that passed now fails.
 *
 * This is what makes red-then-green a measurement rather than a promise. A test
 * written before the code must fail, and "the suite got worse" is exactly that
 * fact — read from the same comparison the regression gate uses, so there is one
 * definition of "worse" in the whole pipeline rather than two that can drift.
 */
export function wentRed(verdict: GateVerdict): boolean {
  return verdict.suites.some((suite) => isRegression(suite.comparison));
}

/**
 * What the gate is able to say about this project, in one line for the report.
 *
 * Stated up front rather than discovered at the end: a team whose suites Aime
 * cannot read should know that before the run, not after it.
 */
export function gateResolution(baseline: Baseline): "named" | "verdictOnly" | "none" {
  const ran = measured(baseline);
  if (ran.length === 0) return "none";
  return ran.every((suite) => suite.run?.report.reader === null) ? "verdictOnly" : "named";
}

/** Totals across every suite that answered, for a summary line that adds up. */
export function tally(baseline: Baseline): { passed: boolean; failed: number; total: number | null } {
  const runs = measured(baseline).map((suite) => suite.run);
  const counted = runs.filter((run) => run?.report.total !== null && run !== null);
  return {
    passed: runs.every((run) => run?.report.passed === true),
    failed: runs.reduce((sum, run) => sum + (run?.report.failed.length ?? 0), 0),
    total: counted.length === 0 ? null : counted.reduce((sum, run) => sum + (run?.report.total ?? 0), 0),
  };
}
