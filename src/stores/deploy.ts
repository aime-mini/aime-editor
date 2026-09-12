import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { translate } from "../i18n";
import { agentTurn, cancelAgentTurn, type TurnPermission } from "../lib/agentTurn";
import { billingOff } from "../lib/cloudErrors";
import {
  commandLine,
  filesPrompt,
  fixPrompt,
  overwritten,
  parsePlan,
  parseRevision,
  parseSurvey,
  planPrompt,
  readLine,
  surveyPrompt,
  urlIn,
  TOOLING_TO_REPORT,
  type CheckedPlan,
  type DeployPlan,
  type DeployStep,
  type Probe,
  type ReadAnswer,
  type Rejected,
  type Survey,
} from "../lib/deploy";
import type { PlannedRead } from "../lib/cloudReads";
import { allOutput, execCancel, type CommandOutcome } from "../lib/exec";
import { formatProviderError } from "../lib/providerErrors";
import { slotOf, useCloud, type CloudAccount } from "./cloud";
import { useWorkspace } from "./workspace";

/**
 * A deployment: the four steps a developer takes, with the AI planning, the
 * person confirming, and Aime running and proving (ARCHITECTURE.md §5, session 31).
 *
 * Not a chat turn and not a task run: its own log, its own stop, no session id,
 * and every command it runs is one the person saw on the confirm page. The AI
 * is launched with files-only tools throughout, so nothing it does can reach
 * the cloud; `cloud/deploy.rs` runs the commands with the project pinned.
 */

export interface DeployLogLine {
  text: string;
  kind: "note" | "output" | "problem";
}

/** One step as the panel draws it while the deploy runs. */
export interface StepRun {
  step: DeployStep;
  state: "passed" | "failed" | "running" | "pending";
}

export type DeployStage =
  | { kind: "surveying" }
  | { kind: "planning" }
  | { kind: "confirm"; survey: Survey; plan: DeployPlan }
  | { kind: "deploying"; plan: DeployPlan; steps: StepRun[] }
  | { kind: "proving"; plan: DeployPlan; steps: StepRun[]; url: string }
  | { kind: "done"; plan: DeployPlan; steps: StepRun[]; url: string; probe: Probe; kept: number }
  | { kind: "blocked"; plan: DeployPlan | null; steps: StepRun[]; reason: string };

export interface DeploySlot {
  cloudId: string;
  account: CloudAccount;
  stage: DeployStage;
  log: DeployLogLine[];
}

interface DeployState {
  /** One deploy per account, keyed by `slotOf(cloud, account)`. */
  slots: Record<string, DeploySlot | undefined>;
  /** The slot whose pane is in front of the account's resources, or null. */
  open: string | null;
  /** Begins a deploy for this account: survey, reads, plan, then waits at the confirm page. */
  start: (cloudId: string, account: CloudAccount) => Promise<void>;
  /** The person agreed to the plan: write the files, run the steps, prove it. */
  confirm: (slot: string) => Promise<void>;
  /** Stops whatever the slot has in flight. */
  cancel: (slot: string) => Promise<void>;
  /** Puts the account's resources back in front; a running deploy carries on. */
  close: () => void;
  /** Puts the deploy pane in front again. */
  show: (slot: string) => void;
  /** Forgets a deploy that has come to rest. */
  dismiss: (slot: string) => void;
}

/** How many times the AI is asked to fix a failed step or an unanswered service. */
const MAX_ROUNDS = 6;
/** How many times a plan or a fix that the checker refused is asked for again. */
const MAX_REJECTIONS = 2;
const LOG_LIMIT = 500;

/**
 * What a slot has in flight, outside the store because none of it renders.
 * Kept per slot: stopping one account's deploy must not pull another's process.
 */
interface Engine {
  inFlight: { kind: "command" | "agent"; id: string } | null;
  cancelled: boolean;
}

const engines = new Map<string, Engine>();

function engineFor(slot: string): Engine {
  const found = engines.get(slot);
  if (found !== undefined) return found;
  const fresh: Engine = { inFlight: null, cancelled: false };
  engines.set(slot, fresh);
  return fresh;
}

export const useDeploy = create<DeployState>((set, get) => ({
  slots: {},
  open: null,

  start: async (cloudId, account) => {
    const slot = slotOf(cloudId, account.id);
    engines.set(slot, { inFlight: null, cancelled: false });
    set((state) => ({
      open: slot,
      slots: { ...state.slots, [slot]: { cloudId, account, stage: { kind: "surveying" }, log: [] } },
    }));
    const ops = opsFor(slot, set, get);
    try {
      await survey(ops);
    } catch (error: unknown) {
      ops.problem(formatProviderError(error));
      ops.stage({ kind: "blocked", plan: null, steps: [], reason: formatProviderError(error) });
    }
  },

  confirm: async (slot) => {
    const current = get().slots[slot];
    if (current?.stage.kind !== "confirm") return;
    const ops = opsFor(slot, set, get);
    try {
      await deploy(current.stage.plan, ops);
    } catch (error: unknown) {
      ops.problem(formatProviderError(error));
      ops.stage({
        kind: "blocked",
        plan: current.stage.plan,
        steps: [],
        reason: formatProviderError(error),
      });
    }
  },

  cancel: async (slot) => {
    const engine = engineFor(slot);
    engine.cancelled = true;
    if (engine.inFlight?.kind === "command") await execCancel(engine.inFlight.id);
    if (engine.inFlight?.kind === "agent") await cancelAgentTurn(engine.inFlight.id);
    // A deploy waiting at the confirm page has nothing in flight to end; it is
    // simply not going ahead.
    const current = get().slots[slot];
    if (current?.stage.kind === "confirm") {
      opsFor(slot, set, get).stage({
        kind: "blocked",
        plan: current.stage.plan,
        steps: [],
        reason: translate("deploy.cancelled"),
      });
    }
  },

  close: () => {
    set({ open: null });
  },

  show: (slot) => {
    set({ open: slot });
  },

  dismiss: (slot) => {
    engines.delete(slot);
    set((state) => ({
      open: state.open === slot ? null : state.open,
      slots: Object.fromEntries(Object.entries(state.slots).filter(([key]) => key !== slot)),
    }));
  },
}));

type Set = (partial: Partial<DeployState> | ((state: DeployState) => Partial<DeployState>)) => void;
type Get = () => DeployState;

/** What a driving function needs: the slot's log, its stage, and its cancel state. */
interface Ops {
  slot: () => DeploySlot;
  stage: (stage: DeployStage) => void;
  note: (text: string) => void;
  output: (text: string) => void;
  problem: (text: string) => void;
  engine: Engine;
  /** Read through a call, because Stop flips it between two awaits and a narrowed field would not see that. */
  cancelled: () => boolean;
}

function opsFor(slot: string, set: Set, get: Get): Ops {
  const patch = (change: (current: DeploySlot) => Partial<DeploySlot>) => {
    set((state) => {
      const current = state.slots[slot];
      if (current === undefined) return {};
      return { slots: { ...state.slots, [slot]: { ...current, ...change(current) } } };
    });
  };
  const line = (kind: DeployLogLine["kind"]) => (text: string) => {
    patch((current) => ({ log: [...current.log, { text, kind }].slice(-LOG_LIMIT) }));
  };
  return {
    slot: () => {
      const current = get().slots[slot];
      if (current === undefined) throw new Error(`deploy slot ${slot} was dismissed`);
      return current;
    },
    stage: (stage) => {
      patch(() => ({ stage }));
    },
    note: line("note"),
    output: line("output"),
    problem: line("problem"),
    engine: engineFor(slot),
    cancelled: () => engineFor(slot).cancelled,
  };
}

/**
 * Steps one and two: the AI reads the repository, Aime runs the reads it asks
 * for, the AI writes the plan, Aime checks it - and the pane waits for the person.
 */
async function survey(ops: Ops): Promise<void> {
  const { cloudId, account } = ops.slot();
  const root = projectRoot();
  const loaded = useCloud.getState().resources[slotOf(cloudId, account.id)];
  const inventory = loaded?.kind === "loaded" ? loaded.resources : [];
  const tooling = await invoke<string[]>("programs_present", { names: TOOLING_TO_REPORT });

  ops.note(translate("deploy.readingRepo"));
  const survey = await askUntilReadable(ops, root, surveyPrompt({ inventory, tooling }), parseSurvey);
  if (survey === null) return;
  ops.note(
    translate("deploy.surveyed", {
      app: survey.app.name || survey.app.kind,
      existing: survey.existing.length,
    }),
  );

  const answers = await readAll(ops, survey.inspect);

  ops.stage({ kind: "planning" });
  let rejected: Rejected[] = [];
  for (let attempt = 1; attempt <= MAX_REJECTIONS; attempt += 1) {
    const plan = await askUntilReadable(
      ops,
      root,
      planPrompt({ survey, answers, tooling, rejected }),
      parsePlan,
    );
    if (plan === null) return;
    const checked = await check(ops, plan, plan.steps, plan.keep, plan.prove);
    if (checked.rejected.length === 0) {
      const usable: DeployPlan = { ...plan, steps: checked.steps, keep: checked.keep, prove: checked.prove };
      if (usable.prove === null) {
        blocked(ops, usable, [], translate("deploy.noProof"));
        return;
      }
      ops.stage({ kind: "confirm", survey, plan: usable });
      return;
    }
    rejected = checked.rejected;
    for (const one of rejected) {
      ops.problem(translate("deploy.rejected", { part: one.part, label: one.label, reason: one.reason }));
    }
  }
  blocked(ops, null, [], translate("deploy.stillRejected"));
}

/**
 * Steps three and four: files, the settings to keep as they stand, the
 * commands one by one, then the service asked over HTTP - with the AI asked
 * to rewrite the remainder whenever a step or the service fails.
 */
async function deploy(plan: DeployPlan, ops: Ops): Promise<void> {
  const root = projectRoot();
  const { cloudId, account } = ops.slot();
  const ran: StepRun[] = [];
  let queue = plan.steps;
  const show = (current: DeployStep | null) => {
    const steps: StepRun[] = [
      ...ran,
      ...(current === null ? [] : [{ step: current, state: "running" as const }]),
      ...queue.filter((step) => step !== current).map((step) => ({ step, state: "pending" as const })),
    ];
    ops.stage({ kind: "deploying", plan, steps });
    return steps;
  };
  show(null);

  if (plan.files.length > 0) {
    ops.note(translate("deploy.writingFiles", { count: plan.files.length }));
    const written = await turn(ops, root, filesPrompt(plan.files, plan), "edits");
    if (written === null) return;
  }

  ops.note(translate("deploy.snapshot"));
  const before = await readAll(
    ops,
    plan.keep.map((keep) => keep.read),
  );

  let rounds = 0;
  const failures: string[] = [];
  while (!ops.cancelled()) {
    // Run what is queued, stopping at the first failure.
    let failed: { label: string; command: string; output: string } | null = null;
    while (queue.length > 0) {
      const [step, ...rest] = queue;
      show(step);
      const outcome = await runStep(ops, cloudId, account, plan.target.existing, step, root);
      if (outcome === null) return;
      queue = rest;
      if (outcome.code === 0) {
        ran.push({ step, state: "passed" });
        continue;
      }
      ran.push({ step, state: "failed" });
      ops.problem(translate("deploy.stepFailed", { label: step.label, code: String(outcome.code ?? "-") }));
      failed = { label: step.label, command: commandLine(step, account), output: allOutput(outcome) };
      break;
    }

    if (failed === null) {
      // Everything ran: the service itself is the judge.
      const steps = show(null);
      const verdict = await prove(ops, plan, steps);
      if (verdict.kind === "running") {
        const after = await readAll(
          ops,
          plan.keep.map((keep) => keep.read),
        );
        const lost = overwritten(plan.keep, before, after);
        if (lost.length > 0) {
          const labels = lost.map((keep) => keep.label).join(", ");
          ops.problem(translate("deploy.overwritten", { labels }));
          blocked(ops, plan, steps, translate("deploy.overwritten", { labels }));
          return;
        }
        if (plan.keep.length > 0) ops.note(translate("deploy.kept", { count: plan.keep.length }));
        ops.stage({
          kind: "done",
          plan,
          steps,
          url: verdict.url,
          probe: verdict.probe,
          kept: plan.keep.length,
        });
        return;
      }
      if (verdict.kind === "wrongPath") {
        blocked(ops, plan, steps, verdict.output);
        return;
      }
      failed = verdict.failed;
    }

    // Some failures are walls, not mistakes. Measured 2026-09-10 on the first
    // real deploy: step one answered "Billing account for project … is not
    // found", and no rewritten command enables an API on a project that cannot
    // be billed. The AI was asked anyway and spent a turn of somebody's money
    // to say so. The CLI's own words become the reason, because the panel
    // reads them to offer the one command that fixes it (`CloudBilling.tsx`).
    if (billingOff(failed.output) !== null) {
      blocked(ops, plan, show(null), failed.output);
      return;
    }

    // Something failed: the same failure twice is a loop, and looping
    // unattended is what makes an unattended deploy frightening.
    rounds += 1;
    const signature = `${failed.label}\n${failed.output.slice(-400)}`;
    if (failures.at(-1) === signature) {
      blocked(ops, plan, show(null), translate("deploy.stalled"));
      return;
    }
    if (rounds > MAX_ROUNDS) {
      blocked(ops, plan, show(null), translate("deploy.tooManyRounds", { max: MAX_ROUNDS }));
      return;
    }
    failures.push(signature);
    ops.note(translate("deploy.fixing", { round: rounds, max: MAX_ROUNDS }));
    const revised = await askFix(ops, root, plan, failed, queue);
    if (revised === null) {
      if (!ops.cancelled()) blocked(ops, plan, show(null), translate("deploy.noWayOn"));
      return;
    }
    ops.note(translate("deploy.revised", { count: revised.length }));
    queue = revised;
  }
  blocked(ops, plan, show(null), translate("deploy.cancelled"));
}

type Verdict =
  | { kind: "running"; url: string; probe: Probe }
  /** Serving, but not on the path the plan chose - nothing to fix by deploying again. */
  | { kind: "wrongPath"; output: string }
  | { kind: "failed"; failed: { label: string; command: string; output: string } };

/** Asks the deployed service, the way the plan said to. */
async function prove(ops: Ops, plan: DeployPlan, steps: StepRun[]): Promise<Verdict> {
  const { account } = ops.slot();
  const proveRead = plan.prove;
  if (proveRead === null) {
    return { kind: "failed", failed: { label: "prove", command: "", output: translate("deploy.noProof") } };
  }
  const [answer] = await readAll(ops, [proveRead.read]);
  const url = answer.ok ? urlIn(answer.json, proveRead.urlPath, proveRead.scheme) : null;
  if (url === null) {
    const output = answer.ok
      ? translate("deploy.noUrl", { label: proveRead.read.label, path: proveRead.urlPath })
      : answer.json;
    ops.problem(output);
    return {
      kind: "failed",
      failed: { label: proveRead.read.label, command: readLine(proveRead.read, account), output },
    };
  }
  const target = new URL(proveRead.path, url).toString();
  ops.stage({ kind: "proving", plan, steps, url: target });
  ops.note(translate("deploy.proving", { url: target }));
  let probe: Probe;
  try {
    probe = await invoke<Probe>("cloud_http_probe", { url: target });
  } catch (error: unknown) {
    ops.problem(String(error));
    return {
      kind: "failed",
      failed: { label: `GET ${target}`, command: `GET ${target}`, output: String(error) },
    };
  }
  ops.output(translate("deploy.probe", { url: target, status: probe.status, ms: probe.durationMs }));
  if (probe.status === proveRead.expect) return { kind: "running", url, probe };
  // The path can be wrong when the service is right. Measured 2026-09-10 on a
  // deploy that worked: Cloud Run's front end answers `/healthz` itself with
  // Google's own 404 page and never reaches the container, while `/` and every
  // other path answer 200. Reporting that as a failed deploy would have sent
  // somebody hunting a service that was already serving, so the root is asked
  // before any verdict is given.
  const root = await answersAtRoot(url);
  const serving = root !== null && root >= 200 && root < 400;
  const output = [
    translate("deploy.probeWrong", { status: probe.status, expect: proveRead.expect }),
    serving ? translate("deploy.probeRoot", { url, status: root, path: proveRead.path }) : "",
    probe.bodyHead,
  ]
    .filter((line) => line !== "")
    .join("\n");
  ops.problem(output);
  // Deploying again cannot change which paths Cloud Run answers for itself,
  // and every round of that is another Cloud Build on somebody's bill.
  if (serving) return { kind: "wrongPath", output };
  return { kind: "failed", failed: { label: `GET ${target}`, command: `GET ${target}`, output } };
}

/**
 * What the service's own root answers, or null when even that cannot be asked.
 *
 * Only used to tell "nothing is deployed" apart from "the health path is not
 * the one the plan guessed"; a failure here is not itself a verdict.
 */
async function answersAtRoot(url: string): Promise<number | null> {
  try {
    const probe = await invoke<Probe>("cloud_http_probe", { url: new URL("/", url).toString() });
    return probe.status;
  } catch {
    return null;
  }
}

/**
 * The fix loop's inner conversation: the AI may ask for reads first, and what
 * it answers is checked like the plan was. Null when it gave up, could not be
 * read, kept proposing what Aime refuses, or was stopped.
 */
async function askFix(
  ops: Ops,
  root: string,
  plan: DeployPlan,
  failed: { label: string; command: string; output: string },
  remaining: DeployStep[],
): Promise<DeployStep[] | null> {
  let answers: ReadAnswer[] = [];
  let rejected: Rejected[] = [];
  for (let round = 1; round <= MAX_REJECTIONS + 1; round += 1) {
    const reply = await turn(ops, root, fixPrompt({ plan, failed, remaining, answers, rejected }), "edits");
    if (reply === null) return null;
    const revision = parseRevision(reply);
    if (revision === null) {
      ops.problem(translate("deploy.unreadable"));
      return null;
    }
    if (revision.giveUp !== null) {
      ops.problem(translate("deploy.gaveUp", { reason: revision.giveUp }));
      return null;
    }
    if (revision.steps.length === 0) {
      answers = await readAll(ops, revision.inspect);
      continue;
    }
    const checked = await check(ops, plan, revision.steps, [], null);
    if (checked.rejected.length === 0) return checked.steps;
    rejected = checked.rejected;
    for (const one of rejected) {
      ops.problem(translate("deploy.rejected", { part: one.part, label: one.label, reason: one.reason }));
    }
  }
  ops.problem(translate("deploy.stillRejected"));
  return null;
}

/** Runs the Rust check for a set of steps and reads, against the plan's target. */
function check(
  ops: Ops,
  plan: DeployPlan,
  steps: DeployStep[],
  keep: DeployPlan["keep"],
  prove: DeployPlan["prove"],
): Promise<CheckedPlan> {
  return invoke<CheckedPlan>("cloud_check_deploy", {
    cloudId: ops.slot().cloudId,
    existing: plan.target.existing,
    plan: { steps, keep, prove },
  });
}

/** Runs one confirmed step, streaming its lines into the log. Null when stopped. */
async function runStep(
  ops: Ops,
  cloudId: string,
  account: CloudAccount,
  existing: boolean,
  step: DeployStep,
  cwd: string,
): Promise<CommandOutcome | null> {
  const id = `deploy-${slotOf(cloudId, account.id)}-${String(Date.now())}`;
  ops.note(translate("deploy.running", { command: commandLine(step, account) }));
  // Listen before the command starts: its first line can arrive before the
  // invoke promise settles, and a listener registered afterwards missed it.
  const off = await listen<{ id: string; line: string }>("exec:output", ({ payload }) => {
    if (payload.id === id) ops.output(payload.line);
  });
  ops.engine.inFlight = { kind: "command", id };
  try {
    const outcome = await invoke<CommandOutcome>("cloud_deploy_step", {
      id,
      request: { cloudId, account, existing, step, cwd },
    });
    if (outcome.cancelled || ops.cancelled()) {
      blocked(ops, null, [], translate("deploy.cancelled"));
      return null;
    }
    return outcome;
  } finally {
    off();
    ops.engine.inFlight = null;
  }
}

/** Runs reads for the AI, one after another, and keeps every answer - refusals included. */
async function readAll(ops: Ops, reads: PlannedRead[]): Promise<ReadAnswer[]> {
  const { cloudId, account } = ops.slot();
  const answers: ReadAnswer[] = [];
  for (const read of reads) {
    ops.note(translate("deploy.runningRead", { command: readLine(read, account) }));
    try {
      const json = await invoke<string>("cloud_deploy_read", { cloudId, account, read });
      answers.push({ label: read.label, json, ok: true });
    } catch (error: unknown) {
      const reason = String(error);
      ops.problem(translate("deploy.readFailed", { label: read.label, reason }));
      answers.push({ label: read.label, json: reason, ok: false });
    }
  }
  return answers;
}

/**
 * Asks, and asks once more when the answer was not the JSON requested - a
 * model that answered in prose is told so rather than being read as "nothing".
 */
async function askUntilReadable<T>(
  ops: Ops,
  root: string,
  prompt: string,
  parse: (reply: string) => T | null,
): Promise<T | null> {
  const first = await turn(ops, root, prompt, "readOnly");
  if (first === null) return null;
  const parsed = parse(first);
  if (parsed !== null) return parsed;
  ops.problem(translate("deploy.unreadableHead", { head: head(first) }));
  const second = await turn(
    ops,
    root,
    `${prompt}\n\nYour previous answer was not the JSON asked for. Answer with ONLY the JSON.`,
    "readOnly",
  );
  if (second === null) return null;
  const again = parse(second);
  if (again === null) {
    ops.problem(translate("deploy.unreadableHead", { head: head(second) }));
    blocked(ops, null, [], translate("deploy.unreadable"));
  }
  return again;
}

/** How much of a reply the log shows when it could not be read: enough to see what it was instead. */
const REPLY_HEAD = 400;

function head(reply: string): string {
  const trimmed = reply.trim();
  return trimmed === "" ? "(empty)" : trimmed.slice(0, REPLY_HEAD);
}

/**
 * One AI turn with files-only tools, whatever its permission: the AI reads and
 * writes the repository and nothing else. Null when the turn was stopped.
 */
async function turn(
  ops: Ops,
  root: string,
  prompt: string,
  permission: TurnPermission,
): Promise<string | null> {
  if (ops.cancelled()) return null;
  const outcome = await agentTurn({
    prompt,
    cwd: root,
    permission,
    tools: "filesOnly",
    onToolCall: ops.output,
    onStderr: ops.output,
    onStarted: (runId) => {
      ops.engine.inFlight = { kind: "agent", id: runId };
    },
  });
  ops.engine.inFlight = null;
  if (outcome.code === null || ops.cancelled()) {
    blocked(ops, null, [], translate("deploy.cancelled"));
    return null;
  }
  return outcome.text;
}

function blocked(ops: Ops, plan: DeployPlan | null, steps: StepRun[], reason: string): void {
  const current = ops.slot();
  const keptPlan = plan ?? planOf(current.stage);
  ops.stage({ kind: "blocked", plan: keptPlan, steps, reason });
}

function planOf(stage: DeployStage): DeployPlan | null {
  return "plan" in stage ? stage.plan : null;
}

function projectRoot(): string {
  const root = useWorkspace.getState().rootPath;
  if (root === null) throw new Error(translate("deploy.needsProject"));
  return root;
}
