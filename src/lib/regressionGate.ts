import type { TaskDef } from "../stores/tasks";
import { allOutput, type CommandOutcome } from "./exec";
import { compareRuns, isRegression, readTestOutput, type Comparison, type TestReport } from "./testReport";

/**
 * The gate that answers "did this change break anything that was working?".
 *
 * It is the cheapest honest answer there is: run the project's own test command
 * before the change and again after it, and compare. No opinion, no model, no
 * heuristic — the same suite, twice, and the difference between the two.
 *
 * Three outcomes are worth telling apart, and a gate that collapses them lies:
 * a project with no test command cannot be checked at all, a suite that was
 * already failing is not this change's fault, and a test that was passing and
 * is not any more is the one thing that blocks.
 */

/** One run of the suite, kept so the two can be compared and shown. */
export interface SuiteRun {
  /** The command line that was run, so a report can say what it measured. */
  command: string;
  report: TestReport;
  outcome: CommandOutcome;
}

/** Why the gate has nothing to say. */
export type GateSilence =
  /** The project declares no test command; there is nothing to run. */
  | { reason: "noTestCommand" }
  /** The suite could not be run at all - the command itself failed to start. */
  | { reason: "couldNotRun"; detail: string };

export type Baseline = { taken: true; run: SuiteRun } | ({ taken: false } & GateSilence);

/** What the gate concluded once both runs are in. */
export interface GateVerdict {
  comparison: Comparison;
  /** True when the run must stop here. */
  blocks: boolean;
  before: SuiteRun;
  after: SuiteRun;
}

/** How long a suite is given before it is treated as hung. */
export const SUITE_TIMEOUT_MS = 15 * 60 * 1000;

/** How a caller runs a command; injected so this module is testable. */
export type RunCommand = (
  id: string,
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<CommandOutcome>;

/** The project's own test command, if it declares one. */
export function testTaskOf(tasks: TaskDef[]): TaskDef | null {
  return tasks.find((task) => task.kind === "test") ?? null;
}

/**
 * Runs the suite once and reads what it said.
 *
 * Taken before a change, this is the baseline; taken after, it is the thing
 * compared against it. A project with no test command answers `taken: false`
 * rather than an empty pass, because "nothing to check" and "everything is
 * fine" are the two answers a gate must never confuse.
 */
export async function runSuite(
  tasks: TaskDef[],
  root: string,
  runId: string,
  run: RunCommand,
): Promise<Baseline> {
  const task = testTaskOf(tasks);
  if (task === null) return { taken: false, reason: "noTestCommand" };

  try {
    const outcome = await run(runId, task.command, root, SUITE_TIMEOUT_MS);
    return {
      taken: true,
      run: { command: task.command, report: readTestOutput(allOutput(outcome), outcome.code), outcome },
    };
  } catch (error: unknown) {
    // The command could not even start - a missing runner, a bad folder. That
    // is not a failing suite, and calling it one would blame the change.
    return { taken: false, reason: "couldNotRun", detail: String(error) };
  }
}

/** Compares the run taken after a change with the baseline taken before it. */
export function judge(before: SuiteRun, after: SuiteRun): GateVerdict {
  const comparison = compareRuns(before.report, after.report);
  return { comparison, blocks: isRegression(comparison), before, after };
}

/**
 * What the gate is able to say about this project, in one line for the report.
 *
 * Stated up front rather than discovered at the end: a team whose suite Aime
 * cannot read should know that before the run, not after it.
 */
export function gateResolution(baseline: Baseline): "named" | "verdictOnly" | "none" {
  if (!baseline.taken) return "none";
  return baseline.run.report.reader === null ? "verdictOnly" : "named";
}
