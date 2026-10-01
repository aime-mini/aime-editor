import { invoke } from "@tauri-apps/api/core";
import { allOutput, type CommandOutcome } from "./exec";
import { folderIn } from "./testEnvironment";

/**
 * The performance gate of a task run: the changed path timed with large data
 * on the code before the change and on the code after it, and a change that
 * makes it slower is sent back.
 *
 * Which path matters, and what "large" means for it, is the AI's call - it
 * read the code - so it writes the benchmark and registers it
 * (`.aime/perf/bench.json`). The verdict is not its call: Aime runs the
 * benchmark itself, on a checkout of the code as it was before the change and
 * on the tree as it is now, and compares the timings the benchmark printed.
 */

export const BENCH_FILE = ".aime/perf/bench.json";

/** Runs of each side. Measured: one or two runs of the same thing differ by up to 40 %. */
export const BENCH_RUNS = 3;

/** How much slower, and by how many milliseconds at least, counts as slower rather than noise. */
const SLOWER_BY = 0.25;
const NOISE_FLOOR_MS = 5;

/** The line a benchmark prints with its timing: the changed path alone, in milliseconds. */
const TIMING = /AIME_BENCH_MS=(\d+(?:\.\d+)?)/g;

/** A benchmark as the AI registered it. */
export interface Bench {
  label: string;
  command: string;
  /** Where it runs, relative to the root of the tree. */
  dir: string;
  /** The files the change adds that the benchmark needs, copied into the old checkout to time it there. */
  files: string[];
}

/** What the gate found. */
export type PerfOutcome =
  /** Timed on both sides: the medians, and whether the change made it slower. */
  | { kind: "measured"; before: number; after: number; slower: boolean }
  /** The old code could not run the benchmark - it calls what the change added. */
  | { kind: "noBaseline"; after: number }
  /** The benchmark printed no timing on the changed tree; what it printed instead. */
  | { kind: "broken"; output: string };

/** Starts a command and waits for it; injected, so the comparison can be tested without a machine. */
export type BenchRunner = (command: string, cwd: string) => Promise<CommandOutcome>;

/** Reads `bench.json`; null when it is not the shape the implement prompt asks for. */
export function parseBench(text: string): Bench | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { label, command, dir, files } = value as Record<string, unknown>;
  if (typeof command !== "string" || command.trim() === "") return null;
  return {
    label: typeof label === "string" && label !== "" ? label : command,
    command,
    dir: typeof dir === "string" && dir !== "" ? dir : ".",
    files: Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [],
  };
}

/** The last timing a run printed, or null when it printed none or failed. */
export function readTiming(outcome: CommandOutcome): number | null {
  if (outcome.code !== 0 || outcome.timedOut) return null;
  const all = [...allOutput(outcome).matchAll(TIMING)];
  const last = all.at(-1);
  return last === undefined ? null : Number(last[1]);
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function isSlower(before: number, after: number): boolean {
  return after > before * (1 + SLOWER_BY) && after - before > NOISE_FLOOR_MS;
}

/**
 * Times the benchmark on both trees, the runs interleaved - old, new, old,
 * new - so a machine that gets busier halfway through slows both sides alike
 * rather than the one that happened to run second.
 */
export async function compare(
  bench: Bench,
  oldRoot: string,
  newRoot: string,
  run: BenchRunner,
): Promise<PerfOutcome> {
  const before: (number | null)[] = [];
  const after: number[] = [];
  for (let round = 0; round < BENCH_RUNS; round += 1) {
    before.push(readTiming(await run(bench.command, folderIn(oldRoot, bench.dir))));
    const now = await run(bench.command, folderIn(newRoot, bench.dir));
    const timing = readTiming(now);
    if (timing === null) return { kind: "broken", output: allOutput(now).slice(-2_000) };
    after.push(timing);
  }
  const old = before.filter((timing): timing is number => timing !== null);
  if (old.length < BENCH_RUNS) return { kind: "noBaseline", after: median(after) };
  const was = median(old);
  const is = median(after);
  return { kind: "measured", before: was, after: is, slower: isSlower(was, is) };
}

/** One line for the reader and the agent: what was timed, and what came of it. */
export function describePerf(bench: Bench, outcome: PerfOutcome): string {
  switch (outcome.kind) {
    case "measured":
      return `${bench.label}: ${ms(outcome.before)} before the change, ${ms(outcome.after)} after (medians of ${String(BENCH_RUNS)} interleaved runs each)`;
    case "noBaseline":
      return `${bench.label}: ${ms(outcome.after)} after the change; the code before it cannot run this benchmark`;
    case "broken":
      return `${bench.label}: printed no AIME_BENCH_MS timing`;
  }
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

/** The benchmark the AI registered in this tree, or null when it registered none. */
export async function readBench(root: string): Promise<Bench | null> {
  try {
    return parseBench(await invoke<string>("read_file", { path: `${root}/${BENCH_FILE}` }));
  } catch {
    return null; // never written: nothing in this change was worth timing
  }
}

/**
 * Runs `work` with a checkout of the code as it was before the change beside
 * the project - a detached worktree at HEAD, which a run has not committed to -
 * holding the benchmark's own files, and made runnable the way the project
 * says. The checkout is discarded afterwards whatever `work` does, through the
 * command that does not follow links into the real `node_modules`.
 */
export async function withOldCode<T>(
  gitRoot: string,
  workRoot: string,
  bench: Bench,
  setUp: (install: string, cwd: string) => Promise<CommandOutcome>,
  work: (oldRoot: string) => Promise<T>,
): Promise<T> {
  const oldRoot = `${gitRoot.replace(/[\\/]+$/, "")}-before-${String(Date.now())}`;
  await invoke("git_worktree_add", { root: gitRoot, path: oldRoot });
  try {
    for (const file of bench.files) {
      const content = await invoke<string>("read_file", { path: `${workRoot}/${file}` });
      await invoke("write_file", { path: `${oldRoot}/${file}`, content });
    }
    const install = await invoke<string | null>("worktree_setup_command", { rootPath: oldRoot });
    if (install !== null) await setUp(install, oldRoot);
    return await work(oldRoot);
  } finally {
    await invoke("git_worktree_discard", { root: gitRoot, path: oldRoot });
  }
}
