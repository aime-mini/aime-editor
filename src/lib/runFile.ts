import { invoke } from "@tauri-apps/api/core";
import type { TaskDef } from "../stores/tasks";
import type { Brief, Plan, Review, Solution, Survey, TestCases } from "./aiRun";
import type { Radius } from "./blastRadius";
import type { RuleFile } from "./projectRules";
import type { CheckPass } from "./qualityGate";
import type { Baseline, GateVerdict, SuiteRun } from "./regressionGate";
import type { Run } from "./runPlan";

/**
 * A run, on disk — and every run before it.
 *
 * Two jobs, one file each. **Resume:** a run takes minutes and sometimes much
 * longer, and the machine it runs on gets closed, put to sleep and knocked off
 * the network; losing an hour of work to a lid closing would make handing a task
 * over a gamble, so every phase writes what it learned and an interrupted run
 * comes back offering to carry on. **History:** what a run decided, proved and
 * changed is the record of how a piece of work came to be, and deleting it the
 * moment the reader clicked away would throw away the only account of it. So
 * runs accumulate, newest first, and any of them can be opened again.
 *
 * They live in the project's own `.aime/` folder rather than in Aime's config,
 * because a run is about *this* repository: the branch it made, the baseline it
 * measured and the cases it agreed are meaningless anywhere else. That folder
 * ignores itself in git (`aime_dir::ensure_self_ignored`), so none of it can end
 * up in a commit.
 */

/** Where a project's runs are kept, one file each. */
export const RUNS_DIR = ".aime/runs";

/**
 * How many runs are read back when the list is shown.
 *
 * The files are never deleted - somebody's record of their own work is not
 * Aime's to tidy away - but a project with three hundred runs must not pay for
 * all of them to open a panel. The newest are the ones anybody looks at.
 */
const HISTORY_LIMIT = 50;

/**
 * How much of a command's output survives to disk.
 *
 * The whole capture can be megabytes of build chatter and would have to be read
 * back on every open. What a resumed run needs is the tail - the failures are at
 * the end - and that is what the repair prompt quotes anyway.
 */
const KEEP_OUTPUT = 8_000;

/** Everything a run needs to be picked back up, and to be read months later. */
export interface SavedRun {
  /** Bumped when the shape changes, so an old file is ignored rather than misread. */
  version: 5;
  run: Run;
  brief: Brief | null;
  /** The files and the conventions read out of the repository. */
  survey: Survey | null;
  /** What the language server said depends on the files being changed. */
  radius: Radius | null;
  /** The approaches weighed, and the one taken. */
  solution: Solution | null;
  /** The agreed statement of what proof looks like. */
  cases: TestCases | null;
  plan: Plan | null;
  review: Review | null;
  baseline: Baseline | null;
  /** The project's own linters as they stood before the change. */
  checks: CheckPass | null;
  verdict: GateVerdict | null;
  /** Files the suites left behind - screenshots, traces, reports. */
  evidence: string[];
  /**
   * Test commands the model found for a project whose manifest declares none,
   * kept only after Aime ran each one for real. Every later pass over the
   * suites runs these too.
   */
  discovered: TaskDef[];
  /** The rules this project wrote down, as they read when the run started. */
  rules: RuleFile[];
  /**
   * Git's untracked list as it stood at the baseline. What is untracked at
   * cleanup time and not in here is what this run created — the only files the
   * trash button may ever offer.
   */
  untrackedBefore: string[];
  /**
   * Where the run worked, when that was a worktree of its own rather than the
   * project — a run that ran beside another one. Absent for the common case,
   * and optional rather than a version bump: an old file without it reads
   * correctly as "worked in the project itself".
   */
  workRoot?: string;
}

const VERSION = 5;

/** What a run is called on disk. The id carries the time, so names sort by age. */
function fileFor(root: string, id: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${RUNS_DIR}/${id}.json`;
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
      path: fileFor(root, saved.run.id),
      content: JSON.stringify({ version: VERSION, ...clip(saved) }, null, 2),
    });
  } catch (error: unknown) {
    console.warn("could not write the run journal:", error);
  }
}

/** Mirror of the Rust `DirEntry`, for the one field this needs. */
interface DirEntry {
  name: string;
  is_dir: boolean;
}

/**
 * Every run this project kept, newest first.
 *
 * Sorted by file name, which is the run id, which starts with the millisecond it
 * began - so the order is chronological without opening a single file. Only the
 * newest `HISTORY_LIMIT` are then read.
 */
export async function listRuns(root: string): Promise<SavedRun[]> {
  let names: string[];
  try {
    const entries = await invoke<DirEntry[]>("list_dir", {
      path: `${root.replace(/[\\/]+$/, "")}/${RUNS_DIR}`,
    });
    names = entries
      .filter((entry) => !entry.is_dir && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, HISTORY_LIMIT);
  } catch {
    // No folder yet: a project that has never had a run, which is not an error.
    return [];
  }

  const runs: SavedRun[] = [];
  for (const name of names) {
    const saved = await readRun(`${root.replace(/[\\/]+$/, "")}/${RUNS_DIR}/${name}`);
    if (saved !== null) runs.push(saved);
  }
  // By the run's own clock rather than by its file name, so a hand-copied file
  // cannot put itself at the top of somebody's history.
  return runs.sort((a, b) => b.run.startedAt - a.run.startedAt);
}

/** One run by id, or null when there is nothing readable under that name. */
export async function loadRun(root: string, id: string): Promise<SavedRun | null> {
  return readRun(fileFor(root, id));
}

async function readRun(path: string): Promise<SavedRun | null> {
  try {
    const text = await invoke<string>("read_file", { path });
    const saved = JSON.parse(text) as Partial<SavedRun>;
    // A file from an older shape is ignored rather than half-read: a run rebuilt
    // out of fields that moved would be worse than not offering it at all.
    if (saved.version !== VERSION || saved.run === undefined) return null;
    return saved as SavedRun;
  } catch {
    return null;
  }
}

/**
 * The run this project left in flight, if it left one.
 *
 * A phase was running and nothing ended it, which on disk is exactly what a
 * closed lid, a killed process or a lost network looks like. The newest such run
 * is the one worth offering to carry on.
 */
export async function interruptedRun(root: string): Promise<SavedRun | null> {
  const runs = await listRuns(root);
  return runs.find(wasInterrupted) ?? null;
}

/** Removes one run's file, for a reader who asked for it to be gone. */
export async function forgetRun(root: string, id: string): Promise<void> {
  try {
    await invoke("delete_path", { path: fileFor(root, id) });
  } catch {
    // Already gone, which is the state this asks for.
  }
}

/** Whether this run was interrupted rather than finished. */
export function wasInterrupted(saved: SavedRun): boolean {
  return saved.run.current !== null && saved.run.ended === null;
}

/** The same run with its command output cut down to what is worth keeping. */
function clip(saved: Omit<SavedRun, "version">): Omit<SavedRun, "version"> {
  return {
    ...saved,
    baseline: saved.baseline === null ? null : clipPass(saved.baseline),
    checks:
      saved.checks === null
        ? null
        : {
            checks: saved.checks.checks.map((check) => ({
              ...check,
              outcome:
                check.outcome === null
                  ? null
                  : {
                      ...check.outcome,
                      stdout: tail(check.outcome.stdout),
                      stderr: tail(check.outcome.stderr),
                    },
            })),
          },
    verdict:
      saved.verdict === null
        ? null
        : {
            ...saved.verdict,
            suites: saved.verdict.suites.map((suite) => ({
              ...suite,
              before: clipSuite(suite.before),
              after: clipSuite(suite.after),
            })),
          },
  };
}

function clipPass(baseline: Baseline): Baseline {
  return {
    suites: baseline.suites.map((suite) => ({
      ...suite,
      run: suite.run === null ? null : clipSuite(suite.run),
    })),
  };
}

function clipSuite(suite: SuiteRun): SuiteRun {
  return {
    ...suite,
    outcome: { ...suite.outcome, stdout: tail(suite.outcome.stdout), stderr: tail(suite.outcome.stderr) },
  };
}

function tail(text: string): string {
  return text.length > KEEP_OUTPUT ? text.slice(-KEEP_OUTPUT) : text;
}
