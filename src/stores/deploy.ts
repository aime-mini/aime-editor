import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { translate } from "../i18n";
import { agentTurn, cancelAgentTurn, haveTurn, waitWhile, type TurnPermission } from "../lib/agentTurn";
import { SessionBook } from "../lib/agentSession";
import { billingOff } from "../lib/cloudErrors";
import {
  commandLine,
  filesPrompt,
  fixPrompt,
  notAgreed,
  overwritten,
  parsePlan,
  parseRevision,
  parseSteer,
  parseSurvey,
  planPrompt,
  readLine,
  STAGED_DIR,
  targetsExisting,
  unanswered,
  type Inventory,
  type PlannedFile,
  type StagedFile,
  steerPrompt,
  surveyPrompt,
  urlIn,
  TOOLING_TO_REPORT,
  type CheckedPlan,
  type DeployNote,
  type DeployPlan,
  type DeployStep,
  type Probe,
  type ReadAnswer,
  type Rejected,
  type Survey,
} from "../lib/deploy";
import { recipeOf } from "../lib/deployDialect";
import type { PlannedRead } from "../lib/cloudReads";
import { allOutput, execCancel, type CommandOutcome } from "../lib/exec";
import { formatProviderError } from "../lib/providerErrors";
import { slotOf, useCloud, type CloudAccount, type CloudResource } from "./cloud";
import { failedTo } from "./notices";
import { useWorkspace } from "./workspace";

/**
 * A deployment: the four steps a developer takes, with the AI planning, the
 * person confirming, and Aime running and proving.
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
  /** `stopped`: it was running when the deploy ended, so what it did is not known. */
  state: "passed" | "failed" | "running" | "stopped" | "pending";
}

export type DeployStage =
  | { kind: "surveying" }
  | { kind: "planning" }
  /**
   * Waiting for the person - and holding what a revision needs.
   *
   * `answers` and `tooling` were read before the plan was written, and asking
   * for them again would cost the same CLI calls to learn the same thing. A
   * revision re-runs the PLAN step only.
   */
  | {
      kind: "confirm";
      survey: Survey;
      plan: DeployPlan;
      answers: ReadAnswer[];
      tooling: string[];
      /** The plan's files as written, for the person to read before agreeing (`STAGED_DIR`). */
      files: StagedFile[];
    }
  | { kind: "deploying"; plan: DeployPlan; steps: StepRun[] }
  /**
   * The AI rewrote the steps still to run - after a failure, or when the person
   * spoke while it ran - and nothing it rewrote runs until the person agrees:
   * a confirmed plan is what was confirmed, not whatever came after it.
   * `changed` marks the steps that are not among the ones already agreed.
   */
  | {
      kind: "reconfirm";
      plan: DeployPlan;
      steps: StepRun[];
      revised: DeployStep[];
      changed: boolean[];
      /** Files the rewrite changed, staged for the person to read; empty when it changed none. */
      files: StagedFile[];
      why: string;
    }
  | { kind: "proving"; plan: DeployPlan; steps: StepRun[]; url: string }
  | { kind: "done"; plan: DeployPlan; steps: StepRun[]; url: string; probe: Probe; kept: number }
  | { kind: "blocked"; plan: DeployPlan | null; steps: StepRun[]; reason: string };

export interface DeploySlot {
  cloudId: string;
  account: CloudAccount;
  stage: DeployStage;
  log: DeployLogLine[];
  /**
   * The exchange at the confirm page, oldest first: what the person asked and
   * what Aime answered. Every plan since carries all of it.
   */
  notes: DeployNote[];
  /** What this deploy's AI turns have cost so far, as the CLIs reported it. */
  spentUsd: number;
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
  /**
   * The person wants the plan changed: the note joins the others and the AI
   * writes the plan again from the same survey. Nothing has run at this point
   * and nothing runs now - the new plan waits at the same page.
   */
  revise: (slot: string, note: string) => Promise<void>;
  /**
   * The person says something while the steps are running.
   *
   * It does not touch the command in flight - that is what Stop is for. The
   * words wait for the step to end and are then put to the AI, either with the
   * failure that stopped the run or on their own, and its answer lands against
   * the question. Nothing to await here: the run picks this up itself.
   */
  steer: (slot: string, note: string) => void;
  /** The person agreed to the rewritten steps: they run, and the deploy carries on. */
  agree: (slot: string) => void;
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
  /** What the person said while a step was running, until the run takes it. */
  steer: string | null;
  /** Answers the question at the reconfirm page: true to run the rewritten steps. */
  agreement: ((agreed: boolean) => void) | null;
  /**
   * The deploy's own AI session, carried from turn to turn while warm: the
   * plan, the files and a fix then build on what the survey already read
   * instead of reading the repository again.
   */
  sessions: SessionBook;
}

const engines = new Map<string, Engine>();

function newEngine(): Engine {
  return {
    inFlight: null,
    cancelled: false,
    steer: null,
    agreement: null,
    sessions: new SessionBook(),
  };
}

function engineFor(slot: string): Engine {
  const found = engines.get(slot);
  if (found !== undefined) return found;
  const fresh = newEngine();
  engines.set(slot, fresh);
  return fresh;
}

export const useDeploy = create<DeployState>((set, get) => ({
  slots: {},
  open: null,

  start: async (cloudId, account) => {
    const slot = slotOf(cloudId, account.id);
    engines.set(slot, newEngine());
    set((state) => ({
      open: slot,
      slots: {
        ...state.slots,
        [slot]: { cloudId, account, stage: { kind: "surveying" }, log: [], notes: [], spentUsd: 0 },
      },
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

  revise: async (slot, note) => {
    const current = get().slots[slot];
    const asked = note.trim();
    if (current?.stage.kind !== "confirm" || asked === "") return;
    const { survey, answers, tooling } = current.stage;
    // A fresh engine for a fresh attempt, still carrying the AI's session on.
    const before = engineFor(slot);
    engines.set(slot, { ...newEngine(), sessions: before.sessions });
    const ops = opsFor(slot, set, get);
    // Asked now, answered when the next plan comes back: the page shows the
    // question the moment it is sent, so nobody wonders whether it went
    // anywhere.
    ops.ask(asked);
    // In the log as the person's own line, because the plan that comes back is
    // only readable next to what was asked for.
    ops.note(translate("deploy.asked", { note: asked }));
    try {
      await writePlan(ops, { survey, answers, tooling });
    } catch (error: unknown) {
      ops.problem(formatProviderError(error));
      ops.stage({ kind: "blocked", plan: null, steps: [], reason: formatProviderError(error) });
    }
  },

  steer: (slot, note) => {
    const current = get().slots[slot];
    const asked = note.trim();
    if (current === undefined || asked === "") return;
    // Only while the steps are running: before them the confirm page takes
    // notes and replans, after them there is nothing left to steer.
    if (current.stage.kind !== "deploying" && current.stage.kind !== "proving") return;
    const engine = engineFor(slot);
    const waiting = engine.steer;
    // A second thought before the first has been taken is part of the same
    // message: one question on the page, one answer under it - rather than an
    // older line left hanging because only the last one was ever taken.
    engine.steer = waiting === null ? asked : `${waiting}\n${asked}`;
    const ops = opsFor(slot, set, get);
    if (waiting === null) ops.ask(asked);
    else ops.addToAsk(asked);
    ops.note(translate("deploy.asked", { note: asked }));
  },

  agree: (slot) => {
    const engine = engineFor(slot);
    engine.agreement?.(true);
    engine.agreement = null;
  },

  cancel: async (slot) => {
    const engine = engineFor(slot);
    engine.cancelled = true;
    // A deploy waiting for the person to agree to rewritten steps is told no.
    engine.agreement?.(false);
    engine.agreement = null;
    if (engine.inFlight?.kind === "command") await execCancel(engine.inFlight.id);
    if (engine.inFlight?.kind === "agent") await cancelAgentTurn(engine.inFlight.id);
    // A deploy waiting at the confirm page has nothing in flight to end; it is
    // simply not going ahead.
    const current = get().slots[slot];
    if (current?.stage.kind === "confirm") {
      await clearStaging(projectRoot());
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
  /** A question from the person, filed the moment it is sent and answered later. */
  ask: (text: string) => void;
  /** Another line for the question that has not been taken yet. */
  addToAsk: (text: string) => void;
  /** The AI's answer to the last thing the person asked, against that question. */
  answer: (text: string) => void;
  /** What the person said while a step was running - taken once, then gone. */
  takeSteer: () => string | null;
  /** Adds what one AI turn cost to the deploy's total. */
  spend: (usd: number) => void;
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
    spend: (usd) => {
      if (usd > 0) patch((current) => ({ spentUsd: current.spentUsd + usd }));
    },
    output: line("output"),
    problem: line("problem"),
    ask: (text) => {
      patch((current) => ({ notes: [...current.notes, { asked: text, answered: "" }] }));
    },
    addToAsk: (text) => {
      patch((current) => {
        const last = current.notes.at(-1);
        if (last === undefined) return {};
        return { notes: [...current.notes.slice(0, -1), { ...last, asked: `${last.asked}\n${text}` }] };
      });
    },
    answer: (text) => {
      const said = text.trim();
      if (said === "") return;
      patch((current) => {
        const last = current.notes.at(-1);
        if (last === undefined) return {};
        return { notes: [...current.notes.slice(0, -1), { ...last, answered: said }] };
      });
    },
    takeSteer: () => {
      const engine = engineFor(slot);
      const { steer } = engine;
      engine.steer = null;
      return steer;
    },
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
  const read = await readInventory(cloudId, account.id);
  if (read.kind === "failed") {
    blocked(ops, null, [], translate("deploy.inventoryUnread", { reason: read.reason }));
    return;
  }
  const inventory = read.resources;
  const tooling = await invoke<string[]>("programs_present", { names: TOOLING_TO_REPORT });

  ops.note(translate("deploy.readingRepo"));
  const survey = await askUntilReadable(
    ops,
    root,
    surveyPrompt({ cloudId, inventory, tooling }),
    parseSurvey,
  );
  if (survey === null) return;
  ops.note(
    translate("deploy.surveyed", {
      app: survey.app.name || survey.app.kind,
      existing: survey.existing.length,
    }),
  );

  const answers = await readAll(ops, survey.inspect);
  await writePlan(ops, { survey, answers, tooling });
}

/**
 * The account's resource list, read first when it has not been: a plan made
 * against a list that was never read would take every running service for a
 * new one. A list already being read is waited for rather than asked twice.
 */
async function readInventory(
  cloudId: string,
  accountId: string,
): Promise<{ kind: "loaded"; resources: CloudResource[] } | { kind: "failed"; reason: string }> {
  const slot = slotOf(cloudId, accountId);
  const current = useCloud.getState().resources[slot];
  if (current === undefined) await useCloud.getState().reload(cloudId, accountId);
  else if (current.kind === "loading") await settled(slot);
  const state = useCloud.getState().resources[slot];
  if (state?.kind === "loaded") return { kind: "loaded", resources: state.resources };
  return { kind: "failed", reason: state?.kind === "failed" ? state.reason : "" };
}

/** Resolves once the account's resource list is no longer being read. */
function settled(slot: string): Promise<void> {
  return new Promise((resolve) => {
    const stop = useCloud.subscribe((state) => {
      if (state.resources[slot]?.kind === "loading") return;
      stop();
      resolve();
    });
  });
}

/**
 * The account's resource list as it stands now. One being read again, or one
 * whose read failed, proves nothing absent, so it counts as a partial list.
 */
function inventoryNow(ops: Ops): Inventory {
  const { cloudId, account } = ops.slot();
  const state = useCloud.getState().resources[slotOf(cloudId, account.id)];
  return state?.kind === "loaded"
    ? { resources: state.resources, truncated: state.truncated }
    : { resources: [], truncated: true };
}

/**
 * Step two on its own: the AI writes the plan, Aime checks it, the pane waits.
 *
 * Separate from the survey because it runs twice: once after the repository is
 * read, and again each time the person asks for something different. The
 * survey and the reads are not asked for a second time - they would answer the
 * same thing at the same cost.
 */
async function writePlan(
  ops: Ops,
  input: { survey: Survey; answers: ReadAnswer[]; tooling: string[] },
): Promise<void> {
  const { survey, answers, tooling } = input;
  const { cloudId } = ops.slot();
  const root = projectRoot();

  ops.stage({ kind: "planning" });
  let rejected: Rejected[] = [];
  for (let attempt = 1; attempt <= MAX_REJECTIONS; attempt += 1) {
    const notes = ops.slot().notes;
    const plan = await askUntilReadable(
      ops,
      root,
      planPrompt({ cloudId, survey, answers, tooling, rejected, notes }),
      // Where Aime builds the address itself, a plan needs no path into a
      // read's answer - see `asProve`.
      (reply) => parsePlan(reply, recipeOf(cloudId).endpoint === undefined),
    );
    if (plan === null) return;
    const checked = await check(ops, plan, plan.steps, plan.keep, plan.prove);
    if (checked.rejected.length === 0) {
      const existing = targetsExisting(plan.target, checked.steps, inventoryNow(ops));
      const usable: DeployPlan = {
        ...plan,
        target: { ...plan.target, existing },
        steps: checked.steps,
        keep: checked.keep,
        prove: checked.prove,
      };
      if (usable.prove === null) {
        blocked(ops, usable, [], translate("deploy.noProof"));
        return;
      }
      const files = await stageFiles(ops, root, usable);
      if (files === null) return;
      // The answer lands against the question that prompted it, so the page
      // reads as an exchange rather than as a plan that silently changed.
      ops.answer(usable.reply);
      ops.stage({ kind: "confirm", survey, plan: usable, answers, tooling, files });
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
    const placed = await placeStagedFiles(root, plan.files);
    if (placed.length > 0) {
      blocked(ops, plan, show(null), translate("deploy.filesNotPlaced", { detail: placed.join("; ") }));
      return;
    }
    ops.note(translate("deploy.filesPlaced", { count: plan.files.length }));
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
      // Stop pressed between two steps has no command in flight to end, so it
      // is honoured here, before the next one starts.
      if (ops.cancelled()) {
        blocked(ops, plan, show(null), translate("deploy.cancelled"));
        return;
      }
      const [step, ...rest] = queue;
      show(step);
      const existing = targetsExisting(plan.target, [step], inventoryNow(ops));
      const outcome = await runStep(ops, cloudId, account, existing, step, root);
      if (outcome === null) return;
      queue = rest;
      if (outcome.code === 0) {
        ran.push({ step, state: "passed" });
        // The gap between two steps is the only safe place to listen: a
        // command that is halfway through putting a repository into a cloud
        // gets to finish, and Stop - not a sentence - is what ends one.
        const asked = ops.takeSteer();
        if (asked !== null) {
          const steered = await askSteer(ops, root, plan, asked, ran, queue);
          if (steered === null) return;
          if (!(await agreedTo(ops, root, plan, ran, queue, steered, translate("deploy.reconfirmSteer"))))
            return;
          queue = steered.steps;
          show(null);
        }
        continue;
      }
      ran.push({ step, state: "failed" });
      ops.problem(translate("deploy.stepFailed", { label: step.label, code: String(outcome.code ?? "-") }));
      failed = {
        label: step.label,
        command: commandLine(cloudId, step, account),
        output: allOutput(outcome),
      };
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
        const unchecked = unanswered(plan.keep, before);
        if (unchecked.length > 0) {
          ops.problem(
            translate("deploy.keepUnanswered", { labels: unchecked.map((keep) => keep.label).join(", ") }),
          );
        }
        const kept = plan.keep.length - unchecked.length;
        if (kept > 0) ops.note(translate("deploy.kept", { count: kept }));
        // Said while the service was being asked: there is no step left to
        // steer, and saying so beats leaving the question without an answer.
        if (ops.takeSteer() !== null) ops.answer(translate("deploy.steerTooLate"));
        ops.stage({
          kind: "done",
          plan,
          steps,
          url: verdict.url,
          probe: verdict.probe,
          kept,
        });
        return;
      }
      if (verdict.kind === "wrongPath") {
        blocked(ops, plan, steps, verdict.output);
        return;
      }
      failed = verdict.failed;
    }

    // Some failures are walls, not mistakes. Measured on a real deploy: step
    // one answered "Billing account for project … is not found", and no
    // rewritten command enables an API on a project that cannot be billed -
    // asking the AI only spends a paid turn to say so. The CLI's own words
    // become the reason, because the panel reads them to offer the one
    // command that fixes it (`CloudBilling.tsx`).
    if (billingOff(failed.output) !== null) {
      blocked(ops, plan, show(null), failed.output);
      return;
    }

    // Something failed: a failure seen before is a loop - back to back, or
    // two fixes undoing each other in turn - and looping unattended is what
    // makes an unattended deploy frightening.
    rounds += 1;
    const signature = `${failed.label}\n${failed.output.slice(-400)}`;
    if (failures.includes(signature)) {
      blocked(ops, plan, show(null), translate("deploy.stalled"));
      return;
    }
    if (rounds > MAX_ROUNDS) {
      blocked(ops, plan, show(null), translate("deploy.tooManyRounds", { max: MAX_ROUNDS }));
      return;
    }
    failures.push(signature);
    ops.note(translate("deploy.fixing", { round: rounds, max: MAX_ROUNDS }));
    // The thing the person was trying to say when it broke goes in with the
    // failure: they can see the same output the AI does, and often know the
    // one thing it cannot read out of it.
    const revised = await askFix(ops, root, plan, failed, queue, ops.takeSteer() ?? "");
    if (revised === null) {
      if (!ops.cancelled()) blocked(ops, plan, show(null), translate("deploy.noWayOn"));
      return;
    }
    ops.note(translate("deploy.revised", { count: revised.steps.length }));
    const why = translate("deploy.reconfirmFix", { label: failed.label });
    if (!(await agreedTo(ops, root, plan, ran, queue, revised, why))) return;
    queue = revised.steps;
  }
  blocked(ops, plan, show(null), translate("deploy.cancelled"));
}

/** A path inside the project, from the project's root and a project-relative path. */
function inProject(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${path}`;
}

/** The staging folder of the project open now. */
function stagingOf(root: string): string {
  return inProject(root, STAGED_DIR);
}

/**
 * Has the AI write the plan's files into the staging folder and reads them back
 * for the confirm page - so what goes into the project is read before Deploy is
 * pressed, not discovered after. Null when the turn was stopped or failed.
 */
async function stageFiles(ops: Ops, root: string, plan: DeployPlan): Promise<StagedFile[] | null> {
  if (plan.files.length === 0) return [];
  const { cloudId } = ops.slot();
  await clearStaging(root);
  ops.note(translate("deploy.writingFiles", { count: plan.files.length }));
  const written = await turn(ops, root, filesPrompt(cloudId, plan.files, plan), "edits");
  if (written === null) return null;
  return readStaged(root, plan.files);
}

/** The staged files as written - each read back, or marked unwritten when it is not there. */
function readStaged(root: string, files: readonly PlannedFile[]): Promise<StagedFile[]> {
  const staging = stagingOf(root);
  return Promise.all(
    files.map(async (file) => {
      try {
        return { ...file, content: await invoke<string>("read_file", { path: `${staging}/${file.path}` }) };
      } catch {
        return { ...file, content: null };
      }
    }),
  );
}

/**
 * Moves each agreed file from the staging folder into the project, replacing
 * what was there - the person read and agreed to exactly these bytes. Answers
 * what could not be placed; nothing that was not staged is written.
 */
async function placeStagedFiles(root: string, files: readonly PlannedFile[]): Promise<string[]> {
  const staging = stagingOf(root);
  const problems: string[] = [];
  for (const file of files) {
    const from = `${staging}/${file.path}`;
    const to = inProject(root, file.path);
    try {
      await invoke<number>("path_size", { path: from });
    } catch {
      problems.push(translate("deploy.fileNeverWritten", { path: file.path }));
      continue;
    }
    try {
      await invoke("move_into_place", { from, to });
    } catch (error: unknown) {
      problems.push(`${file.path}: ${String(error)}`);
    }
  }
  if (problems.length === 0) await clearStaging(root);
  return problems;
}

/**
 * Empties the staging folder; one that is not there is already empty. A folder
 * that will not go is said out loud rather than left behind in silence.
 */
async function clearStaging(root: string): Promise<void> {
  const staging = stagingOf(root);
  const present = await invoke<number>("path_size", { path: staging }).then(
    () => true,
    () => false,
  );
  if (!present) return;
  await invoke("delete_path", { path: staging }).catch(failedTo(translate("deploy.stagingNotCleared")));
}

/**
 * Whether the rewritten steps may run. Steps the person already agreed to - the
 * remainder of the plan, tried again as it was - need no second yes; anything
 * else the AI wrote waits at the reconfirm page, so the commands that change a
 * cloud are only ever the ones a person read.
 */
async function agreedTo(
  ops: Ops,
  root: string,
  plan: DeployPlan,
  ran: StepRun[],
  agreed: DeployStep[],
  rewrite: Rewrite,
  why: string,
): Promise<boolean> {
  const { steps: revised, files } = rewrite;
  const changed = notAgreed(agreed, revised);
  if (!changed.includes(true) && files.length === 0) return true;
  ops.note(translate("deploy.reconfirmWaiting", { count: changed.filter(Boolean).length + files.length }));
  const steps: StepRun[] = [...ran, ...revised.map((step) => ({ step, state: "pending" as const }))];
  // The answer is listened for before the page asks: a yes given the moment
  // the page appears must not fall into the gap between the two.
  const answer = new Promise<boolean>((resolve) => {
    ops.engine.agreement = resolve;
  });
  ops.stage({ kind: "reconfirm", plan, steps, revised, changed, files, why });
  const agreedNow = await answer;
  if (!agreedNow) {
    await clearStaging(root);
    blocked(ops, plan, steps, translate("deploy.cancelled"));
    return false;
  }
  if (files.length > 0) {
    const problems = await placeStagedFiles(root, files);
    if (problems.length > 0) {
      blocked(ops, plan, steps, translate("deploy.filesNotPlaced", { detail: problems.join("; ") }));
      return false;
    }
    ops.note(translate("deploy.filesPlaced", { count: files.length }));
  }
  ops.stage({ kind: "deploying", plan, steps });
  return true;
}

type Verdict =
  | { kind: "running"; url: string; probe: Probe }
  /** Serving, but not on the path the plan chose - nothing to fix by deploying again. */
  | { kind: "wrongPath"; output: string }
  | { kind: "failed"; failed: { label: string; command: string; output: string } };

/** Asks the deployed service, the way the plan said to. */
async function prove(ops: Ops, plan: DeployPlan, steps: StepRun[]): Promise<Verdict> {
  const { cloudId, account } = ops.slot();
  const proveRead = plan.prove;
  if (proveRead === null) {
    return { kind: "failed", failed: { label: "prove", command: "", output: translate("deploy.noProof") } };
  }
  const [answer] = await readAll(ops, [proveRead.read]);
  // Most clouds answer their own address, and the read is where it comes from.
  // Supabase does not: an Edge Function's URL follows from the project ref and
  // is in no listing, so the recipe carries the shape and Aime fills in the
  // account - never the plan, which could then point a request anywhere. The
  // read still has to succeed: it is what says the thing is really there.
  const endpoint = recipeOf(cloudId).endpoint;
  const url = !answer.ok
    ? null
    : endpoint !== undefined
      ? endpoint.replace("<account>", account.id)
      : urlIn(answer.json, proveRead.urlPath, proveRead.scheme);
  if (url === null) {
    const output = answer.ok
      ? translate("deploy.noUrl", { label: proveRead.read.label, path: proveRead.urlPath })
      : answer.json;
    ops.problem(output);
    return {
      kind: "failed",
      failed: { label: proveRead.read.label, command: readLine(cloudId, proveRead.read, account), output },
    };
  }
  // An address a read answered is a service's root, so the path REPLACES
  // whatever path it came with. An address Aime built is a prefix and the path
  // goes after it: measured, `new URL("/aime/healthz",
  // "https://…supabase.co/functions/v1")` is `https://…supabase.co/aime/healthz`,
  // which answered 401 while the function itself answered 200.
  const target = endpoint === undefined ? new URL(proveRead.path, url).toString() : `${url}${proveRead.path}`;
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
  // The path can be wrong when the service is right. Measured on a
  // deploy that worked: Cloud Run's front end answers `/healthz` itself with
  // Google's own 404 page and never reaches the container, while `/` and every
  // other path answer 200. Reporting that as a failed deploy would have sent
  // somebody hunting a service that was already serving, so the root is asked
  // before any verdict is given.
  // Only where the address IS the service's root: `https://<ref>.supabase.co/`
  // is the project's gateway, not the function that was just deployed, and
  // what it answers says nothing about whether the deploy worked.
  const root = endpoint === undefined ? await answersAtRoot(url) : null;
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
  asked: string,
): Promise<Rewrite | null> {
  const { cloudId } = ops.slot();
  // Only when there is a question: a fix round nobody prompted must not file
  // its words against something the person asked pages ago.
  const answerThem = (said: string) => {
    if (asked !== "") ops.answer(said);
  };
  let answers: ReadAnswer[] = [];
  let rejected: Rejected[] = [];
  for (let round = 1; round <= MAX_REJECTIONS + 1; round += 1) {
    await clearStaging(root);
    const reply = await turn(
      ops,
      root,
      fixPrompt({ cloudId, plan, failed, remaining, answers, rejected, asked }),
      "edits",
    );
    if (reply === null) return null;
    const revision = parseRevision(reply);
    if (revision === null) {
      ops.problem(translate("deploy.unreadable"));
      answerThem(translate("deploy.steerUnreadable"));
      return null;
    }
    if (revision.giveUp !== null) {
      ops.problem(translate("deploy.gaveUp", { reason: revision.giveUp }));
      answerThem(revision.giveUp);
      return null;
    }
    if (revision.steps.length === 0) {
      answers = await readAll(ops, revision.inspect);
      continue;
    }
    const checked = await check(ops, plan, revision.steps, [], null);
    if (checked.rejected.length === 0) {
      answerThem(revision.reply || translate("deploy.steerNoWords"));
      return { steps: checked.steps, files: await readStaged(root, revision.files) };
    }
    rejected = checked.rejected;
    for (const one of rejected) {
      ops.problem(translate("deploy.rejected", { part: one.part, label: one.label, reason: one.reason }));
    }
  }
  ops.problem(translate("deploy.stillRejected"));
  answerThem(translate("deploy.steerStopped"));
  return null;
}

/**
 * What the person said between two steps, put to the AI - and what comes back.
 *
 * Nothing has failed here: the run is going as confirmed and the person wants
 * something else, so the AI's own words are the point and a rewritten
 * remainder is optional. What it does write goes through the same Rust check a
 * plan does, all of it or none of it: half a rewritten remainder is a
 * deployment nobody agreed to. Returns the steps to run now - the ones handed
 * in, when there is nothing to change or nothing Aime will run - and null only
 * when the run was stopped.
 */
async function askSteer(
  ops: Ops,
  root: string,
  plan: DeployPlan,
  asked: string,
  ran: StepRun[],
  remaining: DeployStep[],
): Promise<Rewrite | null> {
  const { cloudId } = ops.slot();
  ops.note(translate("deploy.steering"));
  const unchanged: Rewrite = { steps: remaining, files: [] };
  await clearStaging(root);
  const reply = await turn(
    ops,
    root,
    steerPrompt({ cloudId, plan, asked, ran: ran.map((one) => one.step.label), remaining }),
    "edits",
  );
  if (reply === null) return null;
  const steer = parseSteer(reply);
  if (steer === null) {
    ops.problem(translate("deploy.unreadable"));
    ops.answer(translate("deploy.steerUnreadable"));
    return unchanged;
  }
  const said = steer.reply || translate("deploy.steerNoWords");
  const files = await readStaged(root, steer.files);
  if (steer.steps.length === 0) {
    ops.answer(said);
    return { steps: remaining, files };
  }
  const checked = await check(ops, plan, steer.steps, [], null);
  if (checked.rejected.length > 0) {
    for (const one of checked.rejected) {
      ops.problem(translate("deploy.rejected", { part: one.part, label: one.label, reason: one.reason }));
    }
    ops.answer(`${said}\n${translate("deploy.steerRefused")}`);
    // Files written for steps that will not run are not put in place either.
    await clearStaging(root);
    return unchanged;
  }
  ops.answer(said);
  ops.note(translate("deploy.revised", { count: checked.steps.length }));
  return { steps: checked.steps, files };
}

/** What a rewrite during the run hands back: the steps still to run, and the files it staged. */
interface Rewrite {
  steps: DeployStep[];
  files: StagedFile[];
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
    // Every step checked is held to the strictest the set calls for; a step
    // run alone is then never refused for what its check let through.
    existing: targetsExisting(plan.target, steps, inventoryNow(ops)),
    plan: { steps, keep, prove },
    // This is a deployment, not work on a resource: it may run the commands
    // that put a repository into the cloud, and the CLI may keep a project in
    // that repository (`cloud/dialect.rs`, `deployOpens`).
    deploying: true,
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
  ops.note(translate("deploy.running", { command: commandLine(cloudId, step, account) }));
  // Listen before the command starts: its first line can arrive before the
  // invoke promise settles, and a listener registered afterwards missed it.
  const off = await listen<{ id: string; line: string }>("exec:output", ({ payload }) => {
    if (payload.id === id) ops.output(payload.line);
  });
  ops.engine.inFlight = { kind: "command", id };
  try {
    // Stop can land while the listener is being set up, with no command yet
    // in flight to end: the command is then never started.
    if (ops.cancelled()) {
      blocked(ops, null, [], translate("deploy.cancelled"));
      return null;
    }
    const outcome = await invoke<CommandOutcome>("cloud_deploy_step", {
      id,
      request: { cloudId, account, existing, step, cwd, deploying: true },
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
    ops.note(translate("deploy.runningRead", { command: readLine(cloudId, read, account) }));
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
 * writes the repository and nothing else. Null when the turn was stopped, or
 * when no answer can be had - a sign-in that ran out, a service still away
 * after every wait (`haveTurn`) - which stops the deploy with the CLI's own
 * words rather than reading the failure as the AI's answer.
 */
async function turn(
  ops: Ops,
  root: string,
  prompt: string,
  permission: TurnPermission,
): Promise<string | null> {
  if (ops.cancelled()) return null;
  const result = await haveTurn(
    async () => {
      const outcome = await agentTurn({
        prompt,
        cwd: root,
        permission,
        tools: "filesOnly",
        sessionId: ops.engine.sessions.warm(),
        onToolCall: ops.output,
        onStderr: ops.output,
        onStarted: (runId) => {
          ops.engine.inFlight = { kind: "agent", id: runId };
        },
      });
      ops.engine.inFlight = null;
      ops.spend(ops.engine.sessions.charge(outcome));
      ops.engine.sessions.carryOn(outcome);
      return outcome;
    },
    {
      waitOrStop: (ms) => waitWhile(() => !ops.cancelled(), ms),
      retrying: (reason, seconds) => {
        ops.problem(translate("deploy.unreachableRetry", { reason, seconds }));
      },
    },
  );
  if (result.kind === "unavailable") {
    const key = result.trouble === "signIn" ? "deploy.signInNeeded" : "deploy.unreachable";
    blocked(ops, null, [], translate(key, { reason: result.reason }));
    return null;
  }
  if (result.kind === "stopped" || ops.cancelled()) {
    blocked(ops, null, [], translate("deploy.cancelled"));
    return null;
  }
  return result.outcome.text;
}

/**
 * Ends the deploy with a reason. The plan and the steps are kept from the page
 * it ends on when the caller has none at hand - a turn or a command stopped
 * deep inside - so the person still sees what ran; a step that was running is
 * marked stopped, since whether it finished is not known.
 */
function blocked(ops: Ops, plan: DeployPlan | null, steps: StepRun[], reason: string): void {
  // Whatever the person said that never reached the AI is answered here, not
  // left hanging under their own question.
  if (ops.takeSteer() !== null) ops.answer(translate("deploy.steerStopped"));
  const current = ops.slot();
  const keptPlan = plan ?? planOf(current.stage);
  const keptSteps = (steps.length > 0 ? steps : stepsOf(current.stage)).map((run) =>
    run.state === "running" ? { ...run, state: "stopped" as const } : run,
  );
  ops.stage({ kind: "blocked", plan: keptPlan, steps: keptSteps, reason });
}

function planOf(stage: DeployStage): DeployPlan | null {
  return "plan" in stage ? stage.plan : null;
}

function stepsOf(stage: DeployStage): StepRun[] {
  return "steps" in stage ? stage.steps : [];
}

function projectRoot(): string {
  const root = useWorkspace.getState().rootPath;
  if (root === null) throw new Error(translate("deploy.needsProject"));
  return root;
}
