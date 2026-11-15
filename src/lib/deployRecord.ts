import { invoke } from "@tauri-apps/api/core";
import type { DeployLogLine, DeploySlot, StepRun } from "../stores/deploy";
import type { DeployNote, DeployPlan } from "./deploy";

/**
 * Every deploy, on disk.
 *
 * A deploy changes a cloud, and what it ran there is the record of how that
 * cloud came to be the way it is - the plan, every command and how it ended,
 * the reason it stopped. Kept in memory only, all of it went with the app.
 * So each deploy that comes to rest writes one file, and the next deploy to
 * the same account starts from what the last one did instead of from nothing.
 *
 * They live in the project's own `.aime/` folder, beside the task runs
 * (`runFile.ts`): a deploy is of *this* repository, and that folder ignores
 * itself in git.
 */

/** Where a project's deploys are kept, one file each. */
export const DEPLOY_HISTORY_DIR = ".aime/deploy/history";

/** Bumped when the shape changes; a file of another shape is not read. */
const VERSION = 1;

/** How many steps of the last deploy a prompt lists. */
const STEPS_SHOWN = 20;

/** One deploy as it came to rest. */
export interface DeployRecord {
  version: number;
  cloudId: string;
  accountId: string;
  startedAt: number;
  endedAt: number;
  outcome: "done" | "blocked";
  plan: DeployPlan | null;
  steps: StepRun[];
  /** The address the deployment was proved at, when it was. */
  url: string | null;
  /** Why it stopped, when it did not finish. */
  reason: string | null;
  notes: DeployNote[];
  log: DeployLogLine[];
  spentUsd: number;
}

/** The record of a deploy that has come to rest; null while it is still going. */
export function recordOf(slot: DeploySlot, startedAt: number, endedAt: number): DeployRecord | null {
  const { stage } = slot;
  if (stage.kind !== "done" && stage.kind !== "blocked") return null;
  return {
    version: VERSION,
    cloudId: slot.cloudId,
    accountId: slot.account.id,
    startedAt,
    endedAt,
    outcome: stage.kind,
    plan: stage.plan,
    steps: stage.steps,
    url: stage.kind === "done" ? stage.url : null,
    reason: stage.kind === "blocked" ? stage.reason : null,
    notes: slot.notes,
    log: slot.log,
    spentUsd: slot.spentUsd,
  };
}

/**
 * Writes a deploy's record. The deploy itself is over by now and went the way
 * it went, so a record that cannot be written is said and not raised.
 */
export async function keepRecord(root: string, record: DeployRecord): Promise<void> {
  try {
    await invoke("write_file", {
      path: `${historyOf(root)}/${fileNameOf(record.startedAt, record.cloudId, record.accountId)}`,
      content: JSON.stringify(record, null, 2),
    });
  } catch (error: unknown) {
    console.error("could not write the deploy's record:", error);
  }
}

/** Mirror of the Rust `DirEntry`, for the fields this needs. */
interface DirEntry {
  name: string;
  is_dir: boolean;
}

/** The newest deploy of this project to this account, or null when there is none. */
export async function lastRecord(
  root: string,
  cloudId: string,
  accountId: string,
): Promise<DeployRecord | null> {
  const suffix = `-${safe(cloudId)}-${safe(accountId)}.json`;
  let names: string[];
  try {
    const entries = await invoke<DirEntry[]>("list_dir", { path: historyOf(root) });
    names = entries
      .filter((entry) => !entry.is_dir && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    // No folder yet: a project that has never been deployed from here.
    return null;
  }
  for (const name of names) {
    try {
      const record = parseRecord(await invoke<string>("read_file", { path: `${historyOf(root)}/${name}` }));
      if (record !== null) return record;
    } catch (error: unknown) {
      console.error("could not read the deploy record", name, error);
    }
  }
  return null;
}

/** A record read back; null for a file of another shape or none at all. */
export function parseRecord(text: string): DeployRecord | null {
  try {
    const record = JSON.parse(text) as Partial<DeployRecord>;
    return record.version === VERSION && Array.isArray(record.steps) ? (record as DeployRecord) : null;
  } catch {
    return null;
  }
}

/** The last deploy to this account, as the next deploy's prompt tells it. */
export function lastDeployLines(record: DeployRecord | null, program: string): string[] {
  if (record === null) return [];
  const steps = record.steps.slice(0, STEPS_SHOWN).map(({ step, state }) => {
    const named = step.program !== undefined && step.program !== "" ? step.program : program;
    return `- ${state}: ${step.label} - ${named} ${step.args.join(" ")}`;
  });
  return [
    `The last deploy of this repository to this account, ${new Date(record.endedAt).toISOString()}:`,
    record.plan === null ? "(it stopped before a plan was agreed)" : `Plan: ${record.plan.summary}`,
    ...steps,
    record.outcome === "done"
      ? `It finished, proved at ${record.url ?? "(no address)"}.`
      : `It stopped: ${record.reason ?? "(no reason was given)"}`,
  ];
}

function historyOf(root: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${DEPLOY_HISTORY_DIR}`;
}

/** Starts with the millisecond the deploy began, so names sort in time order. */
function fileNameOf(startedAt: number, cloudId: string, accountId: string): string {
  return `${String(startedAt)}-${safe(cloudId)}-${safe(accountId)}.json`;
}

/** An id as a file name may hold it: an Azure subscription or a profile name may not. */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
