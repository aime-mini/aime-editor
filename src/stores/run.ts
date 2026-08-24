import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { translate } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import {
  parseBrief,
  parsePlan,
  parseReview,
  uncoveredCriteria,
  PLAN_PROMPT,
  REVIEW_PROMPT,
  UNDERSTAND_PROMPT,
  type Brief,
  type Criterion,
  type Plan,
  type Review,
} from "../lib/aiRun";
import { aiOneshot } from "../lib/aiOneshot";
import { createEventParser } from "../lib/aiParsers";
import { radiusFrom, radiusIsComplete, type Radius } from "../lib/blastRadius";
import { allOutput, execCancel } from "../lib/exec";
import { judge, runSuite, type Baseline, type GateVerdict, type SuiteRun } from "../lib/regressionGate";
import { forgetRun, loadRun, saveRun, wasInterrupted } from "../lib/runFile";
import {
  abandonRest,
  mayContinue,
  newRun,
  nextPhase,
  PHASES,
  type PhaseId,
  type PhaseResult,
  type Run,
} from "../lib/runPlan";
import { branchNameFor } from "../lib/workItems";
import { useAi } from "./ai";
import { useGit } from "./git";
import type { TaskDef } from "./tasks";
import { useTrackers, type WorkItem } from "./trackers";
import { useWorkspace } from "./workspace";

/**
 * A Task Run: the work item goes in, a branch with a checked change comes out.
 *
 * This is not a chat turn and does not touch the user's conversation — same
 * rule as `stores/setup.ts`, and for the same reason (ARCHITECTURE.md §4): a
 * job Aime starts on the user's behalf has its own log, its own verdict and its
 * own Cancel, and must not spend the session the user is talking in.
 *
 * Every phase ends in a gate that something other than a model can check. What
 * makes the run trustworthy is not that the model is good but that the run
 * stops when the evidence says stop: a suite that regressed, a plan that does
 * not cover a criterion, a ticket with a question nobody answered.
 */

/** One line of the run's log, as the panel shows it. */
export interface LogLine {
  phase: PhaseId;
  text: string;
  kind: "note" | "output" | "problem";
}

/** How far the run may go before it waits for the reader. */
export type Autonomy =
  /** Stops after the plan for a look, for a task worth checking the direction of. */
  | "reviewPlan"
  /**
   * Runs to the end and reports. The default, because the point of handing a
   * task over is coming back to it done: a run that waits for a click halfway
   * has spent the time and produced nothing.
   */
  | "autopilot";

interface RunState {
  run: Run | null;
  log: LogLine[];
  autonomy: Autonomy;
  /** What each phase produced, for the report and for the panel's detail. */
  brief: Brief | null;
  /** What the language server said depends on the files about to change. */
  radius: Radius | null;
  plan: Plan | null;
  review: Review | null;
  baseline: Baseline | null;
  /** What the last comparison with the baseline found; null until one is made. */
  verdict: GateVerdict | null;

  setAutonomy: (autonomy: Autonomy) => void;
  /** Starts a run for this item. Refuses if one is already going. */
  start: (item: WorkItem) => Promise<void>;
  /** Carries on from the plan gate once the reader has looked. */
  approvePlan: () => Promise<void>;
  /** Picks a run back up where a closed lid or a lost network left it. */
  resume: () => Promise<void>;
  /** Reads back the run this project left behind, if any. */
  reopen: (root: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** Forgets a finished run, so the panel goes back to the item. */
  dismiss: () => void;
}

/** The id of the command or agent run in flight, so Cancel has something to pull. */
let inFlight: { kind: "command" | "agent"; id: string } | null = null;
/** Set while a run is going, so a second click cannot start a rival. */
let running = false;
let unlistenAgent: UnlistenFn[] = [];

export const useRun = create<RunState>((set, get) => ({
  run: null,
  log: [],
  autonomy: "autopilot",
  brief: null,
  radius: null,
  plan: null,
  review: null,
  baseline: null,
  verdict: null,

  setAutonomy: (autonomy) => {
    set({ autonomy });
  },

  start: async (item) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null || running) return;
    running = true;
    const run = newRun(`run-${String(Date.now())}`, item.id, item.title, Date.now());
    set({ run, log: [], brief: null, radius: null, plan: null, review: null, baseline: null, verdict: null });
    useWorkspace.getState().openRun();
    await drive("baseline", { item, root: rootPath }, set, get);
  },

  approvePlan: async () => {
    const { run } = get();
    const { rootPath } = useWorkspace.getState();
    if (run === null || rootPath === null || running) return;
    const item = itemOf(run.itemId);
    if (item === null) return;
    running = true;
    await drive("implement", { item, root: rootPath }, set, get);
  },

  cancel: async () => {
    const { run } = get();
    if (run === null) return;
    if (inFlight?.kind === "command") await execCancel(inFlight.id);
    if (inFlight?.kind === "agent") await invoke("ai_cancel", { runId: inFlight.id });
    inFlight = null;
    running = false;
    set({
      run: { ...abandonRest(run, run.current ?? "baseline", "cancelled", ""), ended: { kind: "cancelled" } },
    });
  },

  resume: async () => {
    const { run } = get();
    const { rootPath } = useWorkspace.getState();
    if (run === null || rootPath === null || running) return;
    const item = itemOf(run.itemId);
    if (item === null) return;
    running = true;
    useWorkspace.getState().openRun();
    // From the phase that was in flight: every phase is written to be safe to
    // run twice, which is what makes picking one up again possible at all.
    await drive(run.current ?? "baseline", { item, root: rootPath }, set, get);
  },

  reopen: async (root) => {
    const saved = await loadRun(root);
    if (saved === null) {
      set({
        run: null,
        log: [],
        brief: null,
        radius: null,
        plan: null,
        review: null,
        baseline: null,
        verdict: null,
      });
      return;
    }
    set({
      run: wasInterrupted(saved)
        ? { ...saved.run, ended: { kind: "interrupted", phase: saved.run.current ?? "baseline" } }
        : saved.run,
      log: [],
      brief: saved.brief,
      radius: saved.radius,
      plan: saved.plan,
      review: saved.review,
      baseline: saved.baseline,
      verdict: saved.verdict,
    });
  },

  dismiss: () => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath !== null) void forgetRun(rootPath);
    set({ run: null, log: [] });
    useWorkspace.getState().closeRun();
  },
}));

/**
 * Another project is another run. What was on screen belongs to the folder that
 * was open, and the next folder's own journal is read in its place.
 */
useWorkspace.subscribe((state, previous) => {
  if (state.rootPath === previous.rootPath) return;
  useRun.setState({
    run: null,
    log: [],
    brief: null,
    radius: null,
    plan: null,
    review: null,
    baseline: null,
    verdict: null,
  });
  if (state.rootPath !== null) void useRun.getState().reopen(state.rootPath);
});

/** The work item a run is about, if the board still has it. */
function itemOf(id: string): WorkItem | null {
  return useTrackers.getState().items.find((candidate) => candidate.id === id) ?? null;
}

/** What every phase is handed. */
interface Context {
  item: WorkItem;
  root: string;
}

type Setter = (partial: Partial<RunState> | ((state: RunState) => Partial<RunState>)) => void;
type Getter = () => RunState;

/**
 * Walks the phases from here, stopping at the first gate that says stop.
 *
 * The walk is a plain loop rather than anything clever on purpose: the order of
 * the phases and the reason each one blocks should be readable in one place.
 */
async function drive(start: PhaseId, context: Context, set: Setter, get: Getter): Promise<void> {
  let phase: PhaseId | null = start;
  // Whatever held the run is over the moment it is driven again - carrying the
  // old hold forward is what made a resumed run stop again the instant its
  // first phase finished.
  update(set, (run) => ({ ...run, ended: null }));

  while (phase !== null) {
    const at = phase;
    // Read the run back out of the store rather than carrying a copy: a phase
    // may write to it too (the branch it started, a hold it asked for), and a
    // stale local copy written back over the top would silently undo that.
    update(set, (run) => ({ ...run, current: at }));
    note(set, at, translate(PHASE_LABELS[at]));

    const started = Date.now();
    let result: PhaseResult;
    try {
      result = await runPhase(at, context, set, get);
    } catch (error: unknown) {
      result = { state: "blocked", summary: translate("run.error", { detail: String(error) }) };
    }
    result = { ...result, startedAt: started, endedAt: Date.now() };
    update(set, (run) => ({ ...run, results: { ...run.results, [at]: result } }));
    // Written after every phase, so a lid closing here costs this phase and
    // nothing before it.
    journal(context.root, get);

    // A red gate stops the run only where the phase is a blocking one: a
    // reviewer that found something has found something, not grounds to throw
    // away a change whose tests all pass.
    if (!mayContinue(at, result)) {
      update(set, (run) => ({
        ...abandonRest(run, at, "skipped", ""),
        ended: { kind: "blocked", phase: at, why: result.summary },
      }));
      journal(context.root, get);
      running = false;
      return;
    }
    // A phase may hold the run rather than end it - an unanswered question, or
    // a plan waiting to be looked at.
    if (get().run?.ended != null) {
      journal(context.root, get);
      running = false;
      return;
    }
    phase = nextPhase(at);
  }

  update(set, (run) => ({ ...run, current: null, ended: { kind: "done" } }));
  journal(context.root, get);
  running = false;
}

/**
 * Writes the run to the project's `.aime/` folder.
 *
 * Not awaited: the journal exists so a lost run can be picked up, and making
 * every phase wait on a disk write to serve that would be paying the cost on
 * the path that matters for a benefit on the path that rarely happens.
 */
function journal(root: string, get: Getter): void {
  const { run, brief, radius, plan, review, baseline, verdict } = get();
  if (run === null) return;
  void saveRun(root, { run, brief, radius, plan, review, baseline, verdict });
}

/** Changes the run in place, leaving whatever a phase wrote to it alone. */
function update(set: Setter, change: (run: Run) => Run): void {
  set((state) => (state.run === null ? {} : { run: change(state.run) }));
}

async function runPhase(phase: PhaseId, context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  switch (phase) {
    case "baseline":
      return baseline(context, set);
    case "understand":
      return understand(context, set);
    case "locate":
      return locate(context, set, get);
    case "plan":
      return planPhase(context, set, get);
    case "implement":
      return implement(context, set, get);
    case "regression":
      return regression(context, set, get);
    case "repair":
      return repair(context, set, get);
    case "review":
      return reviewPhase(context, set);
    case "report":
      return report(get);
  }
}

// ------------------------------------------------------------------ phases

/**
 * Before anything is touched: a branch of its own, a checkpoint to undo the
 * whole run, and the suite as it stands. Without this last one the regression
 * gate has nothing to compare against and every later claim is unfounded.
 */
async function baseline(context: Context, set: Setter): Promise<PhaseResult> {
  // A branch left over from an earlier run is the common case, and it is not a
  // reason to hand the task back: the run takes the next free name instead.
  // Only a git that refuses every name has genuinely stopped anything.
  const wanted = branchNameFor(context.item);
  let branch = wanted;
  let refused: string | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    branch = attempt === 1 ? wanted : `${wanted}-${String(attempt)}`;
    await useGit.getState().createBranch(branch);
    refused = useGit.getState().lastError;
    if (refused === null) break;
  }
  if (refused !== null) {
    return { state: "blocked", summary: translate("run.branchRefused", { detail: refused }) };
  }
  set((state) => ({ run: state.run === null ? null : { ...state.run, branch } }));

  const tasks = await invoke<TaskDef[]>("detect_tasks", { rootPath: context.root });
  const taken = await runSuite(tasks, context.root, commandId(), runCommand(set, "baseline"));
  set({ baseline: taken });

  if (!taken.taken && taken.reason === "couldNotRun") {
    return { state: "blocked", summary: translate("run.suiteWontRun", { detail: taken.detail }) };
  }
  if (!taken.taken) {
    // No test command at all. The run may go on, but the gate that matters
    // most cannot speak, and saying so now beats discovering it at the end.
    return { state: "skipped", summary: translate("run.noSuite") };
  }
  const report = taken.run.report;
  // A count is only quoted when a reader understood the output. Otherwise the
  // verdict is all that is honestly known, and the summary says that instead of
  // reporting "0 failing" about a suite it could not read.
  const counted = report.reader !== null;
  return {
    state: "passed",
    summary: report.passed
      ? counted
        ? translate("run.baselineGreen", { count: report.total ?? 0 })
        : translate("run.baselineGreenPlain")
      : counted
        ? translate("run.baselineRed", { count: report.failed.length })
        : translate("run.baselineRedPlain"),
    detail: report.failed.join("\n"),
  };
}

/** What the ticket actually asks for, and what it does not settle. */
async function understand(context: Context, set: Setter): Promise<PhaseResult> {
  const description = await useTrackers.getState().detailOf(context.item);
  const ticket = [
    `# ${context.item.title}`,
    `Type: ${context.item.itemType} · State: ${context.item.state}`,
    description?.description ?? translate("tracker.noDescription"),
  ].join("\n\n");

  const brief = await tryUntil(ATTEMPTS, async () =>
    parseBrief(await aiOneshot(UNDERSTAND_PROMPT + ticket, context.root)),
  );
  if (brief === null) return { state: "blocked", summary: translate("run.briefUnreadable") };
  set({ brief });

  // A question does not stop the run. Waiting for an answer from a desk nobody
  // is sitting at is the one failure that makes handing a task over pointless,
  // so the run takes the sensible default it was told to prefer and writes the
  // assumption down where the reader will meet it in the report.
  const open = brief.questions.filter((question) => question.blocking);
  return {
    state: "passed",
    summary:
      open.length > 0
        ? translate("run.criteriaWithAssumptions", { count: brief.criteria.length, open: open.length })
        : translate("run.criteria", { count: brief.criteria.length }),
    detail: [
      ...brief.criteria.map((one) => `${one.id}. ${one.text}`),
      ...(open.length > 0 ? ["", translate("run.assumed")] : []),
      ...open.map((question) => `- ${question.text}`),
    ].join("\n"),
  };
}

/**
 * Which files the change touches, and what else depends on them.
 *
 * The files are the model's answer, read out of the repository. The dependants
 * are not: they come from `textDocument/references` put to the language server
 * this editor is already running, because asking a model to recall its callers
 * produces a plausible list where the server produces the real one. A file no
 * server could answer for is reported as unknown rather than as clear - "nothing
 * else is affected" and "nobody looked" must never read alike.
 */
async function locate(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const brief = get().brief;
  if (brief === null) return { state: "skipped", summary: translate("run.noBrief") };

  const asked = await readRepository(
    `${LOCATE_PROMPT}\n\nGoal: ${brief.goal}\n${brief.criteria.map((one) => `- ${one.text}`).join("\n")}`,
    context.root,
    set,
    "locate",
  );
  const files = [...new Set(asked.split("\n").map((line) => line.trim().replace(/^[-*]\s*/, "")))]
    .filter((line) => line !== "" && !line.includes(" ") && line.includes("."))
    .slice(0, LOCATE_FILE_LIMIT);
  if (files.length === 0) return { state: "skipped", summary: translate("run.noFiles") };

  // Imported here rather than at the top: the probe speaks to Monaco, and this
  // store is loaded long before an editor exists.
  const { languageServerProbe } = await import("../lib/lsp/impact");
  note(set, "locate", translate("run.asking", { count: files.length }));
  const radius = await radiusFrom(files, languageServerProbe(context.root));
  set({ radius });

  return {
    state: "passed",
    summary: radiusIsComplete(radius)
      ? translate("run.radius", { files: radius.changing.length, dependents: radius.dependents.length })
      : translate("run.radiusPartly", {
          files: radius.changing.length,
          dependents: radius.dependents.length,
          unknown: radius.unknown.length,
        }),
    detail: [
      ...radius.changing,
      ...(radius.dependents.length > 0 ? ["", translate("run.dependents")] : []),
      ...radius.dependents,
    ].join("\n"),
  };
}

/**
 * What the language server said uses the code about to change, for the phases
 * that write it.
 *
 * Empty when nothing could be asked or nothing came back - a heading with an
 * empty list under it reads as "nothing depends on this", which is the one
 * thing an unanswered radius must never be mistaken for.
 */
function whatDependsOnIt(radius: Radius | null): string[] {
  if (radius === null || radius.dependents.length === 0) return [];
  return [
    "",
    "These files use something the files above declare. The language server named them, so this is",
    "what the change must not break - they are not themselves part of the work:",
    ...radius.dependents.map((file) => `- ${file}`),
  ];
}

/** The steps, and one test per criterion. The gate is the mapping. */
async function planPhase(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const brief = get().brief;
  if (brief === null) return { state: "skipped", summary: translate("run.noBrief") };

  const asking = [
    PLAN_PROMPT,
    "Read the files you will change, and two or three of their neighbours, before you answer: the",
    "plan has to fit the conventions this project already uses, and those live in the code rather",
    "than in your habits.",
    "",
    `Goal: ${brief.goal}`,
    "Acceptance criteria:",
    ...brief.criteria.map((one) => `${one.id}: ${one.text}`),
    ...whatDependsOnIt(get().radius),
  ].join("\n");

  // Asked again with the criteria it dropped, rather than refused: a plan that
  // missed one is a plan one sentence away from being right.
  let plan: Plan | null = null;
  let missing: Criterion[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const asked =
      missing.length === 0
        ? asking
        : [
            asking,
            "",
            "Your last plan left these criteria with no test. Cover every one of them:",
            ...missing.map((one) => `${one.id}: ${one.text}`),
          ].join("\n");
    plan = parsePlan(await readRepository(asked, context.root, set, "plan"));
    if (plan === null) continue;
    missing = uncoveredCriteria(brief, plan);
    if (missing.length === 0) break;
  }
  if (plan === null) return { state: "blocked", summary: translate("run.planUnreadable") };
  set({ plan });

  if (missing.length > 0) {
    return {
      state: "blocked",
      summary: translate("run.planIncomplete", { count: missing.length }),
      detail: missing.map((one) => `${one.id}: ${one.text}`).join("\n"),
    };
  }
  const detail = [
    ...plan.steps.map((step) => `- ${step.what} (${step.files.join(", ")})`),
    "",
    ...plan.tests.map((test) => `${test.criterion} → ${test.name} [${test.file}]`),
  ].join("\n");

  if (get().autonomy === "reviewPlan") {
    hold(set, get, "plan", translate("run.planWaiting"));
  }
  return { state: "passed", summary: translate("run.planReady", { count: plan.tests.length }), detail };
}

/** The only phase that writes. Tests first, then the code, then green. */
async function implement(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const { brief, plan } = get();
  if (brief === null || plan === null) return { state: "skipped", summary: translate("run.noPlan") };

  const prompt = [
    IMPLEMENT_PROMPT,
    `Goal: ${brief.goal}`,
    "Acceptance criteria:",
    ...brief.criteria.map((one) => `${one.id}: ${one.text}`),
    "",
    "The plan:",
    ...plan.steps.map((step) => `- ${step.what} (${step.files.join(", ")})`),
    "",
    "The tests to write first, each proving one criterion:",
    ...plan.tests.map((test) => `- [${test.criterion}] ${test.name} in ${test.file}`),
    ...whatDependsOnIt(get().radius),
  ].join("\n");

  let code: number | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) note(set, "implement", translate("run.tryingAgain", { attempt, of: ATTEMPTS }));
    code = await runAgent(prompt, context.root, set);
    // A cancel is the one answer not worth repeating.
    if (code === null || code === 0) break;
  }
  if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
  if (code !== 0) return { state: "blocked", summary: translate("run.agentFailed", { code }) };
  return { state: "passed", summary: translate("run.implemented") };
}

/**
 * The suite again, against the baseline.
 *
 * This phase only *measures*. Finding a regression is not a reason to hand back
 * an unfinished job - `repair` gets that news and does something about it - so
 * nothing here refuses, and what it learned is stored for the phase that acts.
 */
async function regression(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const before = get().baseline;
  if (before === null || !before.taken) return { state: "skipped", summary: translate("run.noBaseline") };

  const after = await suiteNow(context, set, "regression");
  if (!after.taken) {
    set({ verdict: null });
    return { state: "blocked", summary: translate("run.suiteWontRun", { detail: describeSilence(after) }) };
  }
  const verdict = judge(before.run, after.run);
  set({ verdict });
  return { state: "passed", summary: summarise(verdict), detail: differences(verdict) };
}

/**
 * The phase that finishes the job.
 *
 * A workflow that reports "I broke something, goodbye" has not done the task -
 * it has produced homework. So a regression goes straight back to the agent
 * with the failing tests and the output that proves them, and the suite is
 * measured again after every attempt. Only when the attempts run out does the
 * run stop, and then it says what it tried.
 *
 * Bounded, because an agent that has failed three times on the same test is not
 * one attempt from success - it is looping, and looping unattended is how a run
 * spends a night and a fortune.
 */
async function repair(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const before = get().baseline;
  let verdict = get().verdict;
  if (before === null || !before.taken || verdict === null || !verdict.blocks) {
    return { state: "skipped", summary: translate("run.nothingToRepair") };
  }

  const tried: string[] = [];
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt += 1) {
    note(set, "repair", translate("run.repairing", { attempt, of: REPAIR_ATTEMPTS }));
    tried.push(translate("run.repairAttempt", { attempt, detail: summarise(verdict) }));

    const code = await runAgent(repairPrompt(verdict), context.root, set, "repair");
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };

    const after = await suiteNow(context, set, "repair");
    if (!after.taken) {
      return { state: "blocked", summary: translate("run.suiteWontRun", { detail: describeSilence(after) }) };
    }
    verdict = judge(before.run, after.run);
    set({ verdict });
    if (!verdict.blocks) {
      return {
        state: "passed",
        summary: translate("run.repaired", { attempts: attempt }),
        detail: [...tried, differences(verdict)].filter(Boolean).join("\n"),
      };
    }
  }
  return {
    state: "blocked",
    summary: translate("run.repairGaveUp", { attempts: REPAIR_ATTEMPTS, detail: summarise(verdict) }),
    detail: [...tried, differences(verdict)].filter(Boolean).join("\n"),
  };
}

/**
 * Tries something that can come back empty, until it does not.
 *
 * A model that answered with prose instead of JSON has not refused - it has
 * missed, and asking again costs one call. The bound is what stops a miss from
 * becoming an all-night loop.
 */
async function tryUntil<T>(times: number, attempt: () => Promise<T | null>): Promise<T | null> {
  for (let go = 1; go <= times; go += 1) {
    const answer = await attempt();
    if (answer !== null) return answer;
  }
  return null;
}

/** Runs the project's suite now, for whichever phase is asking. */
async function suiteNow(context: Context, set: Setter, phase: PhaseId): Promise<Baseline> {
  const tasks = await invoke<TaskDef[]>("detect_tasks", { rootPath: context.root });
  return runSuite(tasks, context.root, commandId(), runCommand(set, phase));
}

/** One line for what the comparison found, however much of it can be named. */
function summarise(verdict: GateVerdict): string {
  const broken = verdict.comparison.broken;
  if (broken.length > 0) return translate("run.regressed", { count: broken.length });
  if (verdict.comparison.brokeWithoutDetail) return translate("run.regressedUnnamed");
  const report = verdict.after.report;
  return report.reader === null
    ? translate("run.noRegressionPlain")
    : translate("run.noRegression", { count: report.total ?? 0 });
}

/** The rest of what moved between the two runs, for the detail panel. */
function differences(verdict: GateVerdict): string {
  return [
    ...verdict.comparison.broken.map((name) => `${translate("run.nowBroken")}: ${name}`),
    ...verdict.comparison.alreadyBroken.map((name) => `${translate("run.wasAlreadyRed")}: ${name}`),
    ...verdict.comparison.repaired.map((name) => `${translate("run.nowFixed")}: ${name}`),
  ].join("\n");
}

/** What the agent is told about the damage, with the evidence attached. */
function repairPrompt(verdict: GateVerdict): string {
  const named = verdict.comparison.broken;
  return [
    REPAIR_PROMPT,
    named.length > 0
      ? `These tests passed before your change and fail now:\n${named.map((name) => `- ${name}`).join("\n")}`
      : "The suite passed before your change and fails now.",
    "",
    "The suite said:",
    allOutput(verdict.after.outcome).slice(-SUITE_OUTPUT_LIMIT),
  ].join("\n");
}

/** A reader with a clean context, whose job is to find fault. */
async function reviewPhase(context: Context, set: Setter): Promise<PhaseResult> {
  const diff = await invoke<string>("git_worktree_diff", { root: context.root });
  if (diff.trim() === "") return { state: "skipped", summary: translate("run.nothingChanged") };

  const review = parseReview(
    await aiOneshot(`${REVIEW_PROMPT}\n\n${diff.slice(0, DIFF_LIMIT)}`, context.root),
  );
  set({ review });
  const issues = review.findings.filter((finding) => finding.severity === "issue");
  return {
    state: "passed",
    summary: translate("run.reviewed", { issues: issues.length, total: review.findings.length }),
    detail: [
      ...review.risks.map((risk) => `? ${risk}`),
      ...review.findings.map((finding) => `${finding.file}:${String(finding.line)} — ${finding.message}`),
    ].join("\n"),
  };
}

/** What the reader gets when they come back. */
function report(get: Getter): PhaseResult {
  const { run, brief, plan, review } = get();
  const changed = run?.branch ?? "";
  const lines = [
    brief === null ? "" : `${translate("run.reportGoal")}: ${brief.goal}`,
    plan === null ? "" : translate("run.reportTests", { count: plan.tests.length }),
    review === null
      ? ""
      : translate("run.reportFindings", {
          count: review.findings.filter((finding) => finding.severity === "issue").length,
        }),
  ].filter((line) => line !== "");
  return {
    state: "passed",
    summary: translate("run.reportReady", { branch: changed }),
    detail: lines.join("\n"),
  };
}

// ------------------------------------------------------------------ helpers

/** How many files the locate phase will carry forward. */
const LOCATE_FILE_LIMIT = 40;
/** How much of a diff is worth sending to a reviewer. */
const DIFF_LIMIT = 12_000;
/** How much of a failing suite's output the agent is shown when repairing. */
const SUITE_OUTPUT_LIMIT = 8_000;

/**
 * How many times a phase tries before it admits it cannot.
 *
 * The run's job is to finish the task, so nothing here refuses on its first
 * disappointment: a model that answered with prose is asked again, a plan that
 * missed a criterion is sent back with the criterion it missed, an agent that
 * exited badly is given another go. What the bound buys is the other half -
 * three failures at the same thing is a loop, not bad luck, and a loop left
 * alone overnight is what makes an unattended run frightening rather than
 * useful.
 */
const ATTEMPTS = 3;
const REPAIR_ATTEMPTS = 3;

const REPAIR_PROMPT = `Your change broke something that was working before it.

Fix it, and keep the behaviour you were asked to add: the point is to have both, not to undo your
work. Read the failure first, then the code around it. Do not weaken, skip or delete the failing
test to make it pass - the test is the evidence, not the obstacle.

Run the failing tests when you are done. Do not commit anything.
`;

const LOCATE_PROMPT = `Find the files in this repository this change will need to touch.

Look at the code: search it, open the candidates, follow what calls what. Do not answer from the
wording of the ticket.

Then answer with one repository-relative path per line and nothing else - no prose, no numbering,
no explanation, no backticks.`;

const IMPLEMENT_PROMPT = `Implement this work item in this repository.

Order matters:
1. Write the tests listed below FIRST, and run them. They must fail, and fail for the right reason -
   a test that passes before the code exists is testing nothing.
2. Then write the code until those tests pass.
3. Match the conventions of the files you are editing: read two or three neighbours first and follow
   their naming, error handling and layering rather than your own defaults.
4. Run the tests you touched as you go. Do not run the whole suite; that check comes after you.

Do not commit anything.`;

/** A fresh id per command, so Cancel pulls the right handle. */
function commandId(): string {
  const id = `run-cmd-${String(Date.now())}`;
  inFlight = { kind: "command", id };
  return id;
}

/** Runs a command for a phase, feeding its output into the run's log. */
function runCommand(set: Setter, phase: PhaseId) {
  return async (id: string, command: string, cwd: string, timeoutMs: number) => {
    note(set, phase, translate("run.running", { command }));
    const { execRun } = await import("../lib/exec");
    return execRun(id, command, cwd, timeoutMs);
  };
}

/**
 * Runs the coding agent and waits for it, outside the user's conversation.
 *
 * Answers the exit code, or null when it was cancelled — which the backend
 * reports as an exit with no code at all.
 */
/**
 * Runs the CLI as an agent - with tools, in the project - and waits for it.
 *
 * The permission is the phase's, not the run's: a phase that only has to read
 * the repository is launched read-only, and the two that change it are the only
 * ones ever launched with edits. That is a real constraint at the CLI rather
 * than a sentence in a prompt.
 *
 * Answers the exit code and whatever the agent said, or a null code when it was
 * cancelled - which the backend reports as an exit carrying no code at all.
 */
async function runCli(
  prompt: string,
  cwd: string,
  set: Setter,
  phase: PhaseId,
  permission: "readOnly" | "edits",
): Promise<{ code: number | null; text: string }> {
  /**
   * Listening happens *before* the CLI is started, and what arrives before its
   * id is known is kept.
   *
   * `ai_send_prompt` hands the id back only once the process has been spawned,
   * and a short-lived CLI can be over before that promise settles - measured
   * here with a stand-in CLI that exits in milliseconds, which left the run
   * hanging at this phase forever. A listener registered afterwards is a
   * listener that missed the event.
   */
  let runId: string | null = null;
  const early: { id: string; code: number | null }[] = [];
  // Wired before the listeners below, so reporting is never a maybe: nothing
  // can arrive for a run whose id is not known yet, and the id is only set
  // after the promise exists.
  let report: (code: number | null) => void = () => undefined;
  const finished = new Promise<number | null>((resolve) => {
    report = resolve;
  });

  const ai = useAi.getState();
  const provider = ai.providers.find((candidate) => candidate.id === ai.providerId);
  const parse = createEventParser({
    id: ai.providerId,
    parser: provider?.parser,
    textField: provider?.textField,
  });
  let said = "";

  unlistenAgent.push(
    await listen<{ run_id: string; event: unknown }>("ai:stream", (event) => {
      if (runId !== null && event.payload.run_id !== runId) return;
      for (const one of parse(event.payload.event)) {
        if (one.kind === "message-delta") said += one.text;
        if (one.kind === "done" && one.resultText !== undefined) said = one.resultText;
        if (one.kind === "tool-call") note(set, phase, `${one.name} ${one.detail}`.trim(), "output");
      }
    }),
  );
  unlistenAgent.push(
    await listen<{ run_id: string; code: number | null }>("ai:exit", (event) => {
      if (runId === null) {
        early.push({ id: event.payload.run_id, code: event.payload.code });
        return;
      }
      if (event.payload.run_id === runId) report(event.payload.code);
    }),
  );
  unlistenAgent.push(
    await listen<{ run_id: string; event: string }>("ai:stderr", (event) => {
      if (runId === null || event.payload.run_id === runId) {
        note(set, phase, event.payload.event, "output");
      }
    }),
  );

  try {
    runId = await invoke<string>("ai_send_prompt", {
      providerId: ai.providerId,
      prompt,
      cwd,
      // No session id: this must never join or resume the user's chat.
      sessionId: null,
      options: { model: ai.model || null, effort: ai.effort || null, permission },
    });
  } catch (error: unknown) {
    stopListening();
    throw error;
  }
  inFlight = { kind: "agent", id: runId };

  // Whatever ended while nobody knew which run to listen for.
  const already = early.find((exit) => exit.id === runId);
  if (already !== undefined) report(already.code);

  const code = await finished;
  stopListening();
  inFlight = null;
  return { code, text: said };
}

/** The two phases that change the project. */
async function runAgent(prompt: string, cwd: string, set: Setter, phase: PhaseId = "implement") {
  const { code } = await runCli(prompt, cwd, set, phase, "edits");
  return code;
}

/**
 * A phase that has to look at the repository before it can answer.
 *
 * `ai_oneshot` cannot do this: it runs the CLI with no tools at all, so a
 * question like "which files does this change touch?" would be answered from
 * the shape of the ticket rather than from the code - plausible names, and no
 * way to tell them from real ones. Read-only tools are the difference between
 * analysing a codebase and imagining one.
 */
async function readRepository(prompt: string, cwd: string, set: Setter, phase: PhaseId): Promise<string> {
  const { text } = await runCli(prompt, cwd, set, phase, "readOnly");
  return text;
}

function stopListening(): void {
  for (const off of unlistenAgent) off();
  unlistenAgent = [];
}

/** Holds the run where it is, waiting on the reader rather than ending. */
function hold(set: Setter, get: Getter, phase: PhaseId, question: string): void {
  const run = get().run;
  if (run === null) return;
  set({ run: { ...run, current: null, ended: { kind: "waiting", phase, question } } });
}

function note(set: Setter, phase: PhaseId, text: string, kind: LogLine["kind"] = "note"): void {
  set((state) => ({ log: [...state.log, { phase, text, kind }].slice(-LOG_LIMIT) }));
}

const LOG_LIMIT = 500;

function describeSilence(baseline: Baseline): string {
  if (baseline.taken) return "";
  return baseline.reason === "couldNotRun" ? baseline.detail : translate("run.noSuite");
}

/** A phase's name, as the log says it. Typed so a new phase cannot be forgotten. */
const PHASE_LABELS: Record<PhaseId, TranslationKey> = {
  baseline: "run.phase.baseline",
  understand: "run.phase.understand",
  locate: "run.phase.locate",
  plan: "run.phase.plan",
  implement: "run.phase.implement",
  regression: "run.phase.regression",
  repair: "run.phase.repair",
  review: "run.phase.review",
  report: "run.phase.report",
};

/** Exported for the panel, which shows the phases in this order. */
export { PHASES };
export type { SuiteRun };
