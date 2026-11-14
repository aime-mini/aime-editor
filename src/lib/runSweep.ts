import { invoke } from "@tauri-apps/api/core";
import type { CommandOutcome } from "./exec";
import { RUNS_DIR } from "./runFile";

/**
 * Everything a task run made for its own use, taken back when the run is over.
 *
 * A run that proves a change on running software builds things the project
 * does not keep: a database in a container, an emulator, a test browser, a
 * scratch project, logs. Left behind, each run adds gigabytes to the
 * developer's disk for nothing. So whatever the run makes for itself is made
 * where it can be found again - a scratch folder of its own, a label on every
 * Docker object, a list of every tool it installed with how to remove it, and
 * the mark every process its AI turns start carries - and the sweep takes all
 * of it back however the run ended: finished, blocked, stopped or failed.
 *
 * What the sweep never touches is anything it cannot prove the run made: the
 * change itself, the evidence a person reads, a file that was there before.
 */

/** The Docker label every object a run creates carries, its value the run's id. */
export const RUN_LABEL = "aime.run";

/** A run's own folder inside the project's `.aime/`. */
export function runFolder(root: string, runId: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${RUNS_DIR}/${runId}`;
}

/** Where a run keeps what it makes for itself; all of it goes when the run is over. */
export function scratchOf(root: string, runId: string): string {
  return `${runFolder(root, runId)}/scratch`;
}

/** The list of everything a run installed, each with the command that removes it. */
export function installedListOf(root: string, runId: string): string {
  return `${runFolder(root, runId)}/installed.json`;
}

/** One thing a run installed. */
export interface Installed {
  what: string;
  /** The command that takes it off this machine again. */
  remove: string;
}

/** The installs a run listed; an unreadable list is an empty one, never a guess at what to remove. */
export function parseInstalled(text: string): Installed[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { installed?: unknown }).installed;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const { what, remove } = (entry ?? {}) as { what?: unknown; remove?: unknown };
    return typeof what === "string" && typeof remove === "string" && remove.trim() !== ""
      ? [{ what, remove }]
      : [];
  });
}

/** The rules every builder turn is given about where its own things go. */
export function footprintRules(root: string, runId: string): string {
  return `Whatever you make for your own use - scratch files, test data, logs, a portable tool, a downloaded
binary - goes under ${scratchOf(root, runId)}, never into the project. Every Docker container, volume
and network you create carries the label ${RUN_LABEL}=${runId} (docker run --label ${RUN_LABEL}=${runId} ...).
Anything you install outside that folder - a package, an SDK, a pulled image - is listed in
${installedListOf(root, runId)} as {"installed": [{"what": "...", "remove": "the command that removes it"}]}.
All of it is removed when the run is over, so never install into a place the project or the user relies on.`;
}

/** What the sweep did, for the run's log and its report. */
export interface SweepReport {
  /** Bytes given back by the folders the run kept for itself. */
  freedBytes: number;
  /** Docker objects removed, by kind. */
  docker: number;
  /** Installs taken back off the machine. */
  uninstalled: number;
  /** What could not be removed, each with why - never left unsaid. */
  failed: string[];
}

/** A command run in the sweep, through the platform's shell. */
export type Runner = (command: string, cwd: string) => Promise<CommandOutcome>;

/**
 * Takes back everything the run made for itself. Each step goes on whatever the
 * one before it managed: a container Docker refused to remove is no reason to
 * leave a gigabyte of scratch on the disk.
 */
export async function sweepRun(options: {
  root: string;
  runId: string;
  /** The ids of every AI turn the run started. */
  turns: readonly string[];
  run: Runner;
}): Promise<SweepReport> {
  const { root, runId, turns, run } = options;
  const report: SweepReport = { freedBytes: 0, docker: 0, uninstalled: 0, failed: [] };

  try {
    await invoke("ai_end_left_running", { runIds: turns });
  } catch (error: unknown) {
    report.failed.push(`processes the run's AI turns left running: ${String(error)}`);
  }

  await sweepDocker(runId, root, run, report);

  let installed: Installed[] = [];
  try {
    installed = parseInstalled(await invoke<string>("read_file", { path: installedListOf(root, runId) }));
  } catch {
    // No list: the run installed nothing outside its scratch folder.
  }
  for (const one of installed) {
    const outcome = await run(one.remove, root);
    if (outcome.code === 0) report.uninstalled += 1;
    else report.failed.push(`${one.what}: \`${one.remove}\` exited ${String(outcome.code)}`);
  }

  for (const path of [scratchOf(root, runId), `${root.replace(/[\\/]+$/, "")}/.aime/review/change.diff`]) {
    report.freedBytes += await removeCounted(path, report);
  }
  return report;
}

/** The kinds of Docker object a run labels, each with how to list and remove them. */
const DOCKER_KINDS = [
  { list: "docker ps -aq", remove: "docker rm -f" },
  { list: "docker volume ls -q", remove: "docker volume rm -f" },
  { list: "docker network ls -q", remove: "docker network rm" },
] as const;

async function sweepDocker(runId: string, root: string, run: Runner, report: SweepReport): Promise<void> {
  for (const kind of DOCKER_KINDS) {
    const listed = await run(`${kind.list} --filter "label=${RUN_LABEL}=${runId}"`, root);
    // No Docker on this machine, or not running: there is nothing of the run's in it.
    if (listed.code !== 0) return;
    const ids = listed.stdout.split(/\s+/).filter(Boolean);
    if (ids.length === 0) continue;
    const removed = await run(`${kind.remove} ${ids.join(" ")}`, root);
    if (removed.code === 0) report.docker += ids.length;
    else
      report.failed.push(
        `${kind.remove} ${ids.join(" ")}: ${removed.stderr.trim() || `exited ${String(removed.code)}`}`,
      );
  }
}

/** Deletes a file or folder and answers how many bytes that gave back; a path that is not there gives nothing. */
async function removeCounted(path: string, report: SweepReport): Promise<number> {
  let bytes: number;
  try {
    bytes = await invoke<number>("path_size", { path });
  } catch {
    return 0;
  }
  try {
    await invoke("delete_path", { path });
    return bytes;
  } catch (error: unknown) {
    report.failed.push(`${path}: ${String(error)}`);
    return 0;
  }
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_UNIT = 1024;

/** A byte count as a person reads one: 3.4 GB, not 3650722201. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${BYTE_UNITS[unit]}`;
}
