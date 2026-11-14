import { invoke } from "@tauri-apps/api/core";
import type { TaskDef } from "../stores/tasks";
import { fingerprint } from "./fingerprint";
import type { CheckPass } from "./qualityGate";
import type { Baseline } from "./regressionGate";
import type { TestEnvironment } from "./testEnvironment";

/**
 * The suites and checks as a commit left them, kept for the next run on that
 * commit.
 *
 * The baseline is a full pass over every suite and every check before a line
 * is written - on a large repository the longest wait of a run - and two runs
 * started on the same clean commit measure exactly the same tree. So the pass
 * is kept, and a run that starts where the last one measured reads it back
 * instead of paying for it again.
 *
 * Only for a clean tree: an uncommitted change is part of what the baseline
 * has to measure, and no commit names it. And not for long, because what the
 * suites need from outside the tree - installed packages, a service they
 * reach - can change under a commit that does not.
 */

/** Where a project keeps its last baseline, inside its own `.aime/`. */
export const BASELINE_CACHE_FILE = ".aime/cache/baseline.json";

/** How long a kept baseline is believed. */
export const BASELINE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One measured pass, and what it was measured on. */
export interface KeptBaseline {
  /** The commits and the commands the pass was taken with (`baselineKey`). */
  key: string;
  takenAt: number;
  baseline: Baseline;
  checks: CheckPass;
  environment: TestEnvironment | null;
}

/** What a baseline depends on: the commit of every tree it measured, and every command it ran. */
export function baselineKey(heads: readonly string[], tasks: readonly TaskDef[]): string {
  const commands = tasks.map((task) => `${task.kind}|${task.cwd ?? "."}|${task.command}`).sort();
  return fingerprint(JSON.stringify({ heads, commands }));
}

function fileIn(root: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${BASELINE_CACHE_FILE}`;
}

/** The kept pass for exactly this key, while it is young enough to believe; null otherwise. */
export async function keptBaseline(root: string, key: string, now: number): Promise<KeptBaseline | null> {
  let kept: KeptBaseline;
  try {
    kept = JSON.parse(await invoke<string>("read_file", { path: fileIn(root) })) as KeptBaseline;
  } catch {
    // Nothing kept yet, or a file from another shape: measured afresh, which is never wrong.
    return null;
  }
  const fresh = now - kept.takenAt < BASELINE_MAX_AGE_MS;
  return kept.key === key && fresh ? kept : null;
}

/** Keeps a pass for the next run on the same commit. A pass that cannot be kept only costs that run its head start. */
export async function keepBaseline(root: string, kept: KeptBaseline): Promise<void> {
  try {
    await invoke("write_file", { path: fileIn(root), content: JSON.stringify(kept) });
  } catch (error: unknown) {
    console.warn("could not keep the baseline for the next run:", error);
  }
}
