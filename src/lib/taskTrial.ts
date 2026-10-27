import type { DiscoveredTask } from "./aiTasks";
import { allOutput, type CommandOutcome } from "./exec";
import { folderIn } from "./testEnvironment";

/**
 * Running a command the AI read out of a project once, before it is saved.
 *
 * A command that names a real program in a real folder can still be wrong: a
 * script that does not exist, a flag the tool never had, a project file in
 * another place. Measured on the CLIs Aime drives, `--help` and "it is on
 * PATH" prove very little; running it is what does. So the commands that end
 * by themselves are run here, and what they print is the evidence.
 *
 * Not tried: `run` - a dev server never ends, and started in the background
 * it would fight the person's own server for its port - and `publish`, which
 * run for a trial would publish.
 */

/** How long a build, a check or a test run may take on its first try. */
export const TRIAL_TIMEOUT_MS = 10 * 60_000;

/** How much of a failed trial's output is kept to show and to hand back. */
const OUTPUT_KEPT = 4_000;

export type Trial = { kind: "ran" } | { kind: "failed"; output: string } | { kind: "notTried" };

/** Runs one command line in a folder and waits for it; injected, so trials can be tested without a machine. */
export type TrialRunner = (command: string, cwd: string, timeoutMs: number) => Promise<CommandOutcome>;

export function isTried(task: DiscoveredTask): boolean {
  return task.kind === "build" || task.kind === "check" || task.kind === "test";
}

export async function tryTask(task: DiscoveredTask, root: string, run: TrialRunner): Promise<Trial> {
  if (!isTried(task)) return { kind: "notTried" };
  const outcome = await run(task.command, folderIn(root, task.dir), TRIAL_TIMEOUT_MS);
  if (outcome.code === 0 && !outcome.timedOut) return { kind: "ran" };
  return { kind: "failed", output: failureOf(outcome) };
}

/** What a failed trial said, ending where its last words are. */
function failureOf(outcome: CommandOutcome): string {
  if (outcome.timedOut) return `did not finish within ${String(TRIAL_TIMEOUT_MS / 60_000)} minutes`;
  const said = allOutput(outcome).trim();
  return said === "" ? `exited with ${String(outcome.code)} and printed nothing` : said.slice(-OUTPUT_KEPT);
}

/** The last line of a failure, for a one-line notice. */
export function lastLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? output
  );
}
