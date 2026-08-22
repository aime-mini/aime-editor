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
  type Plan,
  type Review,
} from "../lib/aiRun";
import { aiOneshot } from "../lib/aiOneshot";
import { impactOf, radiusIsComplete, radiusOf } from "../lib/blastRadius";
import { execCancel } from "../lib/exec";
import { judge, runSuite, type Baseline, type SuiteRun } from "../lib/regressionGate";
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
  /** Stops after the plan for a look. The default, and the cheap place to catch a wrong direction. */
  | "reviewPlan"
  /** Runs to the end and reports. */
  | "autopilot";

interface RunState {
  run: Run | null;
  log: LogLine[];
  autonomy: Autonomy;
  /** What each phase produced, for the report and for the panel's detail. */
  brief: Brief | null;
  plan: Plan | null;
  review: Review | null;
  baseline: Baseline | null;

  setAutonomy: (autonomy: Autonomy) => void;
  /** Starts a run for this item. Refuses if one is already going. */
  start: (item: WorkItem) => Promise<void>;
  /** Carries on from the plan gate once the reader has looked. */
  approvePlan: () => Promise<void>;
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
  autonomy: "reviewPlan",
  brief: null,
  plan: null,
  review: null,
  baseline: null,

  setAutonomy: (autonomy) => {
    set({ autonomy });
  },

  start: async (item) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null || running) return;
    running = true;
    const run = newRun(`run-${String(Date.now())}`, item.id, item.title, Date.now());
    set({ run, log: [], brief: null, plan: null, review: null, baseline: null });
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

  dismiss: () => {
    set({ run: null, log: [] });
    useWorkspace.getState().closeRun();
  },
}));

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

    // A red gate stops the run only where the phase is a blocking one: a
    // reviewer that found something has found something, not grounds to throw
    // away a change whose tests all pass.
    if (!mayContinue(at, result)) {
      update(set, (run) => ({
        ...abandonRest(run, at, "skipped", ""),
        ended: { kind: "blocked", phase: at, why: result.summary },
      }));
      running = false;
      return;
    }
    // A phase may hold the run rather than end it - an unanswered question, or
    // a plan waiting to be looked at.
    if (get().run?.ended != null) {
      running = false;
      return;
    }
    phase = nextPhase(at);
  }

  update(set, (run) => ({ ...run, current: null, ended: { kind: "done" } }));
  running = false;
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
      return understand(context, set, get);
    case "locate":
      return locate(context, get);
    case "plan":
      return planPhase(context, set, get);
    case "implement":
      return implement(context, set, get);
    case "regression":
      return regression(context, set, get);
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
  const branch = branchNameFor(context.item);
  await useGit.getState().createBranch(branch);
  const refused = useGit.getState().lastError;
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
async function understand(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const description = await useTrackers.getState().detailOf(context.item);
  const ticket = [
    `# ${context.item.title}`,
    `Type: ${context.item.itemType} · State: ${context.item.state}`,
    description?.description ?? translate("tracker.noDescription"),
  ].join("\n\n");

  const brief = parseBrief(await aiOneshot(UNDERSTAND_PROMPT + ticket, context.root));
  if (brief === null) return { state: "blocked", summary: translate("run.briefUnreadable") };
  set({ brief });

  const blocking = brief.questions.filter((question) => question.blocking);
  if (blocking.length > 0) {
    hold(set, get, "understand", blocking.map((question) => question.text).join("\n"));
    return {
      state: "passed",
      summary: translate("run.questionsFirst", { count: blocking.length }),
      detail: blocking.map((question) => `- ${question.text}`).join("\n"),
    };
  }
  return {
    state: "passed",
    summary: translate("run.criteria", { count: brief.criteria.length }),
    detail: brief.criteria.map((one) => `${one.id}. ${one.text}`).join("\n"),
  };
}

/**
 * Which files the change touches, and what else depends on them.
 *
 * The dependants are not asked of the model — that answer would be a guess. The
 * radius is reported as incomplete until a language server has been asked,
 * because "nothing else is affected" and "nobody looked" must not read alike.
 */
async function locate(context: Context, get: Getter): Promise<PhaseResult> {
  const brief = get().brief;
  if (brief === null) return { state: "skipped", summary: translate("run.noBrief") };

  const asked = await aiOneshot(
    `${LOCATE_PROMPT}\n\nGoal: ${brief.goal}\n${brief.criteria.map((one) => `- ${one.text}`).join("\n")}`,
    context.root,
  );
  const files = [...new Set(asked.split("\n").map((line) => line.trim().replace(/^[-*]\s*/, "")))]
    .filter((line) => line !== "" && !line.includes(" ") && line.includes("."))
    .slice(0, LOCATE_FILE_LIMIT);
  if (files.length === 0) return { state: "skipped", summary: translate("run.noFiles") };

  const radius = radiusOf(files.map((file) => impactOf(file, [])));
  return {
    state: "passed",
    summary: radiusIsComplete(radius)
      ? translate("run.radius", { files: radius.changing.length, dependents: radius.dependents.length })
      : translate("run.radiusUnknown", { files: radius.changing.length }),
    detail: radius.changing.join("\n"),
  };
}

/** The steps, and one test per criterion. The gate is the mapping. */
async function planPhase(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const brief = get().brief;
  if (brief === null) return { state: "skipped", summary: translate("run.noBrief") };

  const asking = [
    PLAN_PROMPT,
    `Goal: ${brief.goal}`,
    "Acceptance criteria:",
    ...brief.criteria.map((one) => `${one.id}: ${one.text}`),
  ].join("\n");

  const plan = parsePlan(await aiOneshot(asking, context.root));
  if (plan === null) return { state: "blocked", summary: translate("run.planUnreadable") };
  set({ plan });

  const missing = uncoveredCriteria(brief, plan);
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
  ].join("\n");

  const code = await runAgent(prompt, context.root, set);
  if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
  if (code !== 0) return { state: "blocked", summary: translate("run.agentFailed", { code }) };
  return { state: "passed", summary: translate("run.implemented") };
}

/** The suite again, against the baseline. The gate the whole run exists for. */
async function regression(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const before = get().baseline;
  if (before === null || !before.taken) return { state: "skipped", summary: translate("run.noBaseline") };

  const tasks = await invoke<TaskDef[]>("detect_tasks", { rootPath: context.root });
  const after = await runSuite(tasks, context.root, commandId(), runCommand(set, "regression"));
  if (!after.taken) {
    return { state: "blocked", summary: translate("run.suiteWontRun", { detail: describeSilence(after) }) };
  }
  const verdict = judge(before.run, after.run);
  if (verdict.blocks) {
    // Naming the tests is only possible where a reader understood the output.
    // Otherwise the honest summary is that the suite turned: "0 tests are
    // failing" on a run that just blocked reads as a bug in the gate.
    const named = verdict.comparison.broken;
    return {
      state: "blocked",
      summary:
        named.length > 0
          ? translate("run.regressed", { count: named.length })
          : translate("run.regressedUnnamed"),
      detail: named.join("\n"),
    };
  }
  return {
    state: "passed",
    summary:
      after.run.report.reader === null
        ? translate("run.noRegressionPlain")
        : translate("run.noRegression", { count: after.run.report.total ?? 0 }),
    detail: [
      ...verdict.comparison.alreadyBroken.map((name) => `${translate("run.wasAlreadyRed")}: ${name}`),
      ...verdict.comparison.repaired.map((name) => `${translate("run.nowFixed")}: ${name}`),
    ].join("\n"),
  };
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

const LOCATE_PROMPT = `List the files in this repository this change will need to touch.
Answer with one path per line, nothing else - no prose, no numbering, no explanation.
Look at the repository rather than guessing from the names.`;

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
async function runAgent(prompt: string, cwd: string, set: Setter): Promise<number | null> {
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
        note(set, "implement", event.payload.event, "output");
      }
    }),
  );

  const ai = useAi.getState();
  try {
    runId = await invoke<string>("ai_send_prompt", {
      providerId: ai.providerId,
      prompt,
      cwd,
      // No session id: this must never join or resume the user's chat.
      sessionId: null,
      // Edits, never full: the agent may change files and run its own tests,
      // and the gates after it are what decide whether that was any good.
      options: { model: ai.model || null, effort: ai.effort || null, permission: "edits" },
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
  return code;
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
  review: "run.phase.review",
  report: "run.phase.report",
};

/** Exported for the panel, which shows the phases in this order. */
export { PHASES };
export type { SuiteRun };
