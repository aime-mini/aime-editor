import { invoke } from "@tauri-apps/api/core";
import type { Brief, Plan, Review } from "./aiRun";
import type { Radius } from "./blastRadius";
import type { Baseline, GateVerdict, SuiteRun } from "./regressionGate";
import type { Run } from "./runPlan";

/**
 * A run, on disk.
 *
 * A run takes minutes and sometimes much longer, and the machine it runs on
 * gets closed, put to sleep, and knocked off the network. Losing an hour of
 * work to a lid closing would make handing a task over a gamble, so every phase
 * writes what it learned and a run that was interrupted comes back offering to
 * carry on from where it stopped.
 *
 * It lives in the project's own `.aime/` folder rather than in Aime's config,
 * because a run is about *this* repository: the branch it made, the baseline it
 * measured and the plan it agreed are meaningless anywhere else. That folder
 * ignores itself in git (`aime_dir::ensure_self_ignored`), so none of it can
 * end up in a commit.
 */

/** Where a project's current run is kept. */
export const RUN_FILE = ".aime/run.json";

/**
 * How much of a suite's output survives to disk.
 *
 * The whole capture can be megabytes of build chatter and would have to be read
 * back on every open. What a resumed run needs is the tail - the failures are
 * at the end - and that is what the repair prompt quotes anyway.
 */
const KEEP_OUTPUT = 8_000;

/** Everything a run needs to be picked back up. */
export interface SavedRun {
  /** Bumped when the shape changes, so an old file is ignored rather than misread. */
  version: 2;
  run: Run;
  brief: Brief | null;
  /** What the language server said depends on the files being changed. */
  radius: Radius | null;
  plan: Plan | null;
  review: Review | null;
  baseline: Baseline | null;
  verdict: GateVerdict | null;
}

const VERSION = 2;

/** The path of the run file inside one project. */
function pathIn(root: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${RUN_FILE}`;
}

/**
 * Writes the run, keeping only as much command output as is worth re-reading.
 *
 * Failure is deliberately quiet: a run that cannot write its journal is still a
 * run doing the task, and stopping it because the disk is full would be the
 * wrong trade. The console keeps the reason.
 */
export async function saveRun(root: string, saved: Omit<SavedRun, "version">): Promise<void> {
  try {
    await invoke("write_file", {
      path: pathIn(root),
      content: JSON.stringify({ version: VERSION, ...clip(saved) }, null, 2),
    });
  } catch (error: unknown) {
    console.warn("could not write the run journal:", error);
  }
}

/** The run this project left behind, or null when there is none to read. */
export async function loadRun(root: string): Promise<SavedRun | null> {
  try {
    const text = await invoke<string>("read_file", { path: pathIn(root) });
    const saved = JSON.parse(text) as Partial<SavedRun>;
    // A file from an older shape is ignored rather than half-read: a resumed
    // run built out of fields that moved would be worse than starting over.
    if (saved.version !== VERSION || saved.run === undefined) return null;
    return saved as SavedRun;
  } catch {
    // No file, or nothing readable in it. Both mean the same thing here.
    return null;
  }
}

/** Removes the journal, for a run the reader has finished with. */
export async function forgetRun(root: string): Promise<void> {
  try {
    await invoke("delete_path", { path: pathIn(root) });
  } catch {
    // Already gone, which is the state this asks for.
  }
}

/**
 * Whether this run was interrupted rather than finished.
 *
 * A phase was in flight and nothing ended it, which on disk is exactly what a
 * closed lid, a killed process or a lost network looks like.
 */
export function wasInterrupted(saved: SavedRun): boolean {
  return saved.run.current !== null && saved.run.ended === null;
}

/** The same run with its command output cut down to what is worth keeping. */
function clip(saved: Omit<SavedRun, "version">): Omit<SavedRun, "version"> {
  return {
    ...saved,
    baseline:
      saved.baseline?.taken === true ? { taken: true, run: clipSuite(saved.baseline.run) } : saved.baseline,
    verdict:
      saved.verdict === null
        ? null
        : {
            ...saved.verdict,
            before: clipSuite(saved.verdict.before),
            after: clipSuite(saved.verdict.after),
          },
  };
}

function clipSuite(suite: SuiteRun): SuiteRun {
  return {
    ...suite,
    outcome: {
      ...suite.outcome,
      stdout: tail(suite.outcome.stdout),
      stderr: tail(suite.outcome.stderr),
    },
  };
}

function tail(text: string): string {
  return text.length > KEEP_OUTPUT ? text.slice(-KEEP_OUTPUT) : text;
}
