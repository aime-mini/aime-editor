import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { translate } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import {
  casesWithoutProof,
  parseBrief,
  parsePlan,
  parseReview,
  parseSolution,
  parseSurvey,
  parseTestCases,
  uncoveredCases,
  uncoveredCriteria,
  DESIGN_PROMPT,
  REVIEW_PROMPT,
  UNDERSTAND_PROMPT,
  type Brief,
  type Criterion,
  type Plan,
  type Review,
  type Solution,
  type Survey,
  type TestCase,
  type TestCases,
} from "../lib/aiRun";
import { aiOneshot } from "../lib/aiOneshot";
import { createEventParser } from "../lib/aiParsers";
import { radiusFrom, radiusIsComplete, type Radius } from "../lib/blastRadius";
import { allOutput, execCancel, type CommandOutcome } from "../lib/exec";
import {
  alreadyFailing,
  checkEvidence,
  checkTasksOf,
  isClean,
  newlyFailing,
  runChecks,
  type CheckPass,
  type CheckRun,
} from "../lib/qualityGate";
import {
  brokenNames,
  gateResolution,
  judge,
  measured,
  runSuites,
  skipList,
  SUITE_TIMEOUT_MS,
  tally,
  testTasksOf,
  unusable,
  wentRed,
  type Baseline,
  type GateVerdict,
  type SuiteRun,
} from "../lib/regressionGate";
import { renderReport, collectEvidence } from "../lib/runReport";
import { caseEvidence, deployProof, DEPLOY_PROOF_DIR, EVIDENCE_DIR } from "../lib/evidenceFile";
import { emptyTrash, trashOf, untrackedNow, type TrashItem } from "../lib/runTrash";
import {
  caseOutcomes,
  casesProvenRed,
  loadTestCases,
  saveTestCases,
  TEST_CASES_MD,
  type CaseVerdict,
} from "../lib/testCaseFile";
import {
  forgetRun,
  interruptedRun,
  listRuns,
  loadRun,
  RUNS_DIR,
  saveRun,
  wasInterrupted,
  type SavedRun,
} from "../lib/runFile";
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
import { folderOf, type TaskDef } from "./tasks";
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
  /**
   * Stops once the approach, the test cases and the plan are on screen. The
   * default: that page costs a minute to read and is the last moment where
   * redirecting the work is free, and a run nobody agreed to is a branch nobody
   * asked for.
   */
  | "reviewPlan"
  /** Runs to the end and reports, for work whose direction is not in doubt. */
  | "autopilot";

/**
 * Everything the phases produce.
 *
 * Kept together because they move together: a run starts with none of them, a
 * reopened run is restored with all of them, and the journal writes exactly
 * this. Spelling them out at each of those places is how one of them gets
 * forgotten in one of them.
 */
interface Artifacts {
  /** What the ticket was understood to ask for. */
  brief: Brief | null;
  /** The files to change and the conventions around them, read from the code. */
  survey: Survey | null;
  /** What the language server said depends on the files about to change. */
  radius: Radius | null;
  /** The approaches weighed, and the one taken. */
  solution: Solution | null;
  /** What proof looks like, agreed before any code exists. */
  cases: TestCases | null;
  plan: Plan | null;
  review: Review | null;
  baseline: Baseline | null;
  /** The project's own linters as they stood before the change. */
  checks: CheckPass | null;
  /** What the last comparison with the baseline found; null until one is made. */
  verdict: GateVerdict | null;
  /** Files the suites left behind - screenshots, traces, reports. */
  evidence: string[];
  /**
   * Test commands the model found for a project whose manifest declares none —
   * kept only after Aime ran each one for real, and run on every later pass.
   */
  discovered: TaskDef[];
  /** The cases whose own test was seen failing before the code existed. */
  redCases: string[];
  /** Git's untracked list at the baseline: the "was already there" side of cleanup. */
  untrackedBefore: string[];
}

const NOTHING_YET: Artifacts = {
  brief: null,
  survey: null,
  radius: null,
  solution: null,
  cases: null,
  plan: null,
  review: null,
  baseline: null,
  checks: null,
  verdict: null,
  evidence: [],
  discovered: [],
  redCases: [],
  untrackedBefore: [],
};

/** The artifacts and the cleanup view together: what a fresh panel shows. */
const NOTHING_SHOWN = { ...NOTHING_YET, trash: null, trashResult: null };

interface RunState extends Artifacts {
  run: Run | null;
  log: LogLine[];
  autonomy: Autonomy;
  /** Every run this project kept, newest first. */
  history: SavedRun[];
  /** True while the panel shows a run out of the history rather than a live one. */
  viewingPast: boolean;
  /** The files the shown run left behind, once the reader asked to see them. */
  trash: TrashItem[] | null;
  /** What the last sweep did, so the panel can say it. */
  trashResult: { deleted: number; failed: string[] } | null;

  setAutonomy: (autonomy: Autonomy) => void;
  /** Starts a run for this item. Refuses if one is already going. */
  start: (item: WorkItem) => Promise<void>;
  /** Carries on from the confirmation gate once the reader has looked. */
  approvePlan: () => Promise<void>;
  /** Picks a run back up where a closed lid or a lost network left it. */
  resume: () => Promise<void>;
  /** Reads back what this project left behind: its history, and any live run. */
  reopen: (root: string) => Promise<void>;
  /** Opens a finished run from the history, read-only. */
  openPast: (id: string) => Promise<void>;
  /** Removes one run from the project's record, at the reader's request. */
  forget: (id: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** Closes the panel, keeping the run in the history. */
  dismiss: () => void;
  /** Lists what the shown run left behind, without deleting anything. */
  previewTrash: () => Promise<void>;
  /** Deletes exactly the ticked paths, then lists what is still there. */
  sweepTrash: (paths: readonly string[]) => Promise<void>;
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
  history: [],
  viewingPast: false,
  ...NOTHING_SHOWN,

  setAutonomy: (autonomy) => {
    set({ autonomy });
  },

  start: async (item) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null || running) return;
    running = true;
    const startedAt = Date.now();
    const run = newRun(`run-${String(startedAt)}`, item.id, item.title, startedAt);
    set({ run, log: [], viewingPast: false, ...NOTHING_SHOWN });
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
    // From the first phase allowed to write: everything before it was reading,
    // deciding and asking, and all of it is what the reader just agreed to.
    await drive("tests", { item, root: rootPath }, set, get);
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
    const history = await listRuns(root);
    // The one worth putting back on screen is the one that never finished: it is
    // the only one with work left in it. Everything else is history until asked
    // for by name.
    const live = await interruptedRun(root);
    if (live === null) {
      set({ run: null, log: [], history, viewingPast: false, ...NOTHING_SHOWN });
      return;
    }
    set({
      ...restore(live),
      history,
      viewingPast: false,
      run: { ...live.run, ended: { kind: "interrupted", phase: live.run.current ?? "baseline" } },
    });
  },

  openPast: async (id) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null || running) return;
    const saved = await loadRun(rootPath, id);
    if (saved === null) return;
    set({ ...restore(saved), run: saved.run, viewingPast: !wasInterrupted(saved) });
    useWorkspace.getState().openRun();
  },

  forget: async (id) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null) return;
    await forgetRun(rootPath, id);
    const history = await listRuns(rootPath);
    // A reader who deletes the run they are looking at is asking for it to be
    // gone, not for it to stay on screen with nothing behind it.
    const showing = get().run;
    set(showing?.id === id ? { history, run: null, log: [], ...NOTHING_SHOWN } : { history });
    if (showing?.id === id) useWorkspace.getState().closeRun();
  },

  dismiss: () => {
    // Nothing is deleted: the run stays in the project's record, and the panel
    // simply stops showing it. A record that vanishes when the reader clicks
    // away is not a record.
    set({ run: null, log: [], viewingPast: false, ...NOTHING_SHOWN });
    useWorkspace.getState().closeRun();
  },

  previewTrash: async () => {
    const { run, untrackedBefore } = get();
    const { rootPath } = useWorkspace.getState();
    if (run === null || rootPath === null) return;
    set({ trash: await trashOf(rootPath, untrackedBefore, run.startedAt), trashResult: null });
  },

  sweepTrash: async (paths) => {
    const { run, untrackedBefore } = get();
    const { rootPath } = useWorkspace.getState();
    if (run === null || rootPath === null) return;
    const trashResult = await emptyTrash(paths);
    // Listed again from disk rather than subtracted in memory, so what the
    // panel shows afterwards is what is actually still there.
    set({ trashResult, trash: await trashOf(rootPath, untrackedBefore, run.startedAt) });
  },
}));

/** A saved run put back into the shape the panel reads. */
function restore(saved: SavedRun): Artifacts & { log: LogLine[]; trash: null; trashResult: null } {
  return {
    log: [],
    trash: null,
    trashResult: null,
    brief: saved.brief,
    survey: saved.survey,
    radius: saved.radius,
    solution: saved.solution,
    cases: saved.cases,
    plan: saved.plan,
    review: saved.review,
    baseline: saved.baseline,
    checks: saved.checks,
    verdict: saved.verdict,
    evidence: saved.evidence,
    discovered: saved.discovered,
    redCases: saved.redCases,
    untrackedBefore: saved.untrackedBefore,
  };
}

/**
 * Another project is another run. What was on screen belongs to the folder that
 * was open, and the next folder's own journal is read in its place.
 */
useWorkspace.subscribe((state, previous) => {
  if (state.rootPath === previous.rootPath) return;
  useRun.setState({ run: null, log: [], history: [], viewingPast: false, ...NOTHING_SHOWN });
  if (state.rootPath !== null) void useRun.getState().reopen(state.rootPath);
});

/**
 * And the project that was already open when this module first loaded.
 *
 * The workbench is imported lazily, so the state change that opened the project
 * happens *before* anything in this file exists to hear it. Without this line a
 * project opened from the welcome screen would never read its own runs back - no
 * offer to carry on an interrupted one, no history - and only switching to a
 * second project would work, which is the kind of bug that looks like
 * forgetfulness rather than like a missing subscription.
 */
const alreadyOpen = useWorkspace.getState().rootPath;
if (alreadyOpen !== null) void useRun.getState().reopen(alreadyOpen);

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
      refreshHistory(context.root, set);
      running = false;
      return;
    }
    // A phase may hold the run rather than end it - an unanswered question, or
    // the confirmation gate waiting to be read.
    if (get().run?.ended != null) {
      journal(context.root, get);
      refreshHistory(context.root, set);
      running = false;
      return;
    }
    phase = nextPhase(at);
  }

  update(set, (run) => ({ ...run, current: null, ended: { kind: "done" } }));
  journal(context.root, get);
  refreshHistory(context.root, set);
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
  const state = get();
  if (state.run === null) return;
  void saveRun(root, { run: state.run, ...artifactsOf(state) });
}

/** Just the artifacts out of the state, which is what the journal is. */
function artifactsOf(state: RunState): Artifacts {
  return {
    brief: state.brief,
    survey: state.survey,
    radius: state.radius,
    solution: state.solution,
    cases: state.cases,
    plan: state.plan,
    review: state.review,
    baseline: state.baseline,
    checks: state.checks,
    verdict: state.verdict,
    evidence: state.evidence,
    discovered: state.discovered,
    redCases: state.redCases,
    untrackedBefore: state.untrackedBefore,
  };
}

/**
 * Re-reads the history after a run reaches a resting place.
 *
 * Not awaited and not on the phase path: the list is what the reader browses
 * later, and making a finishing run wait on a directory listing would be paying
 * for the panel out of the work's own time.
 */
function refreshHistory(root: string, set: Setter): void {
  void listRuns(root).then((history) => {
    set({ history });
  });
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
    case "design":
      return design(context, set, get);
    case "tests":
      return writeTests(context, set, get);
    case "implement":
      return implement(context, set, get);
    case "verify":
      return verify(context, set, get);
    case "review":
      return reviewPhase(context, set, get);
    case "polish":
      return polish(context, set, get);
    case "deliver":
      return deliver(context, set, get);
    case "report":
      return report(context, set, get);
  }
}

// ------------------------------------------------------------------ phases

/**
 * Before anything is touched: a branch of its own, a checkpoint to undo the
 * whole run, every suite as it stands, and every check as it stands.
 *
 * Without these last two the later gates have nothing to compare against, and
 * "your change broke this" and "this was already broken" become the same
 * sentence — which is the sentence that makes a gate untrustworthy.
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

  // Git's untracked list, before anything runs: whatever is untracked later and
  // not in here is what this run created — the only files the cleanup button
  // may ever offer to delete.
  set({ untrackedBefore: await untrackedNow(context.root) });

  const tasks = await tasksOf(context.root);
  const suites = await runSuites(tasks, context.root, commandId, runCommand(set, "baseline"));
  set({ baseline: suites });
  const checks = await runChecks(tasks, context.root, commandId, runCommand(set, "baseline"));
  set({ checks });

  const declared = testTasksOf(tasks).length;
  if (declared === 0) {
    // No test command at all. The run may go on, but the gate that matters most
    // cannot speak, and saying so now beats discovering it at the end.
    return { state: "skipped", summary: translate("run.noSuite"), detail: describeChecks(checks) };
  }
  if (measured(suites).length === 0) {
    return {
      state: "blocked",
      summary: translate("run.suiteWontRun", { detail: describeSilence(suites) }),
    };
  }
  const counts = tally(suites);
  return {
    state: "passed",
    summary: translate("run.baselineTaken", {
      suites: measured(suites).length,
      failed: counts.failed,
    }),
    detail: [
      describeSuites(suites),
      describeChecks(checks),
      // Said now rather than discovered at the end: a team whose runners Aime
      // cannot read closely should know the gates will speak by exit code alone
      // before they walk away from a run.
      gateResolution(suites) === "verdictOnly" ? translate("run.verdictOnly") : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * What the ticket asks for, and the ground it lands on.
 *
 * Two questions in one phase because they have one answer: what a change is for
 * cannot be settled without reading the code it will live in, and asking twice
 * costs a model call and buys nothing a reader can act on differently. So the
 * criteria come out of the ticket, the files and the conventions come out of the
 * repository - every convention citing the file it was seen in, because one with
 * no evidence is a habit - and the dependants come from
 * `textDocument/references` put to the language server this editor is already
 * running, since asking a model to recall its callers produces a plausible list
 * where the server produces the real one. A file no server could answer for is
 * reported as unknown, never as clear.
 */
async function understand(context: Context, set: Setter): Promise<PhaseResult> {
  const description = await useTrackers.getState().detailOf(context.item);
  const asking = [
    UNDERSTAND_PROMPT,
    `# ${context.item.title}`,
    `Type: ${context.item.itemType} · State: ${context.item.state}`,
    description?.description ?? translate("tracker.noDescription"),
  ].join("\n\n");

  // One reply, two readers: each parser takes its own keys out of the same JSON
  // object, so merging the phases costs nothing in parsing.
  const answer = await tryUntil(ATTEMPTS, async () => {
    const reply = await readRepository(asking, context.root, set, "understand");
    const brief = parseBrief(reply);
    const found = parseSurvey(reply);
    return brief === null || found === null ? null : { brief, found };
  });
  if (answer === null) return { state: "blocked", summary: translate("run.briefUnreadable") };

  const { brief, found } = answer;
  const files = found.files.slice(0, SURVEY_FILE_LIMIT);
  set({ brief, survey: { ...found, files } });

  // A project whose manifest declares no test script may still have suites -
  // in a Makefile, a CI file, a build script - and the model was asked to read
  // them out. None of them is believed on its word: Aime runs every one, keeps
  // the ones that actually ran, and they become this run's baseline and join
  // every later pass over the suites.
  const discoveredLines: string[] = [];
  if (testTasksOf(await tasksOf(context.root)).length === 0 && found.suites.length > 0) {
    const candidates: TaskDef[] = found.suites.slice(0, DISCOVERED_SUITE_LIMIT).map((suite, index) => ({
      id: `ai-suite-${String(index + 1)}`,
      label: suite.command,
      kind: "test",
      command: suite.command,
      ...(suite.dir === "." ? {} : { cwd: suite.dir }),
    }));
    note(set, "understand", translate("run.tryingDiscovered", { count: candidates.length }));
    const pass = await runSuites(candidates, context.root, commandId, runCommand(set, "understand"));
    const usable = candidates.filter((candidate) =>
      pass.suites.some((suite) => suite.id === candidate.id && suite.run !== null),
    );
    set({ discovered: usable, baseline: pass });
    discoveredLines.push(
      "",
      translate("run.discoveredSuites", { found: candidates.length, ran: usable.length }),
      ...candidates.map(
        (candidate) =>
          `- ${candidate.command} · ${
            usable.includes(candidate) ? translate("run.suiteRan") : translate("run.suiteSilent")
          }`,
      ),
    );
  }

  // Imported here rather than at the top: the probe speaks to Monaco, and this
  // store is loaded long before an editor exists.
  const { languageServerProbe } = await import("../lib/lsp/impact");
  note(set, "understand", translate("run.asking", { count: files.length }));
  const radius = await radiusFrom(files, languageServerProbe(context.root));
  set({ radius });

  // A question does not stop the run. Waiting for an answer from a desk nobody
  // is sitting at is the one failure that makes handing a task over pointless,
  // so the run takes the sensible default it was told to prefer and writes the
  // assumption down where the reader will meet it in the report - and at the
  // confirmation gate, which is before anything has been written.
  const open = brief.questions.filter((question) => question.blocking);
  const counts = {
    criteria: brief.criteria.length,
    files: radius.changing.length,
    dependents: radius.dependents.length,
  };
  return {
    state: "passed",
    summary: radiusIsComplete(radius)
      ? translate("run.understood", counts)
      : translate("run.understoodPartly", { ...counts, unknown: radius.unknown.length }),
    detail: [
      ...brief.criteria.map((one) => `${one.id}. ${one.text}`),
      ...(open.length > 0 ? ["", translate("run.assumed")] : []),
      ...open.map((question) => `- ${question.text}`),
      "",
      ...radius.changing,
      ...(radius.dependents.length > 0 ? ["", translate("run.dependents")] : []),
      ...radius.dependents,
      ...(found.patterns.length > 0 ? ["", translate("run.conventions")] : []),
      ...found.patterns.map((pattern) => `- ${pattern}`),
      ...(found.testsLiveIn === "" ? [] : ["", `${translate("run.testsLiveIn")}: ${found.testsLiveIn}`]),
      ...discoveredLines,
    ].join("\n"),
  };
}

/**
 * The approach, what proof looks like, and the order it happens in - one page.
 *
 * They arrive together because they are one decision: a plan can be flawless
 * about the wrong approach, and an approach nobody turned into checkable cases
 * is a paragraph. This is also the page the reader is asked to agree to, and
 * three phases producing three pages for one minute of reading was three model
 * calls spent on the same question.
 *
 * Three gates, and none of them guesses. Every criterion must have a case, or
 * the requirement is not covered. Every case must say how it would be proved,
 * because a screen proved by a unit test of the function behind it is not proved
 * at all - what the right check *is* stays the model's call, since it read the
 * project and Aime did not. And every case must be placed in a test: the plan
 * may disagree about *where* a case is proved, never about *whether* it is. What
 * comes back short is asked again with exactly what it missed rather than
 * refused, because an answer one sentence from being right is not a failure.
 *
 * The cases then go into the project as `.aime/test-cases.md` to read and
 * `.aime/test-cases.json` to edit, so the agreed definition of done outlives the
 * run that produced it.
 */
async function design(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const { brief, survey: ground } = get();
  if (brief === null) return { state: "skipped", summary: translate("run.noBrief") };

  const asking = [
    DESIGN_PROMPT,
    `Goal: ${brief.goal}`,
    "Acceptance criteria:",
    ...brief.criteria.map((one) => `${one.id}: ${one.text}`),
    ...conventionsOf(ground),
    ...whatDependsOnIt(get().radius),
  ].join("\n");

  let answer: { solution: Solution; cases: TestCases; plan: Plan } | null = null;
  let missing: Criterion[] = [];
  let unproved: TestCase[] = [];
  let unplaced: TestCase[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const shortfall = [
      ...(missing.length > 0
        ? [
            "",
            "Your last answer left these criteria with no case. Cover every one of them:",
            ...missing.map((one) => `${one.id}: ${one.text}`),
          ]
        : []),
      ...(unproved.length > 0
        ? [
            "",
            'These cases did not say how they would be proved. Fill in "prove" for each one with',
            "the check that would make a tester believe it:",
            ...unproved.map(oneLine),
          ]
        : []),
      ...(unplaced.length > 0
        ? [
            "",
            "These cases had nowhere to be proved. Place every one of them in a test:",
            ...unplaced.map(oneLine),
          ]
        : []),
    ];
    const reply = await readRepository([asking, ...shortfall].join("\n"), context.root, set, "design");
    const solution = parseSolution(reply);
    const cases = parseTestCases(reply);
    const plan = parsePlan(reply);
    if (solution === null || cases === null || plan === null) continue;
    answer = { solution, cases, plan };
    missing = uncoveredCriteria(brief, cases);
    unproved = casesWithoutProof(cases);
    unplaced = uncoveredCases(cases, plan);
    if (missing.length === 0 && unproved.length === 0 && unplaced.length === 0) break;
  }
  if (answer === null) return { state: "blocked", summary: translate("run.designUnreadable") };
  set({ solution: answer.solution, cases: answer.cases, plan: answer.plan });
  await saveTestCases(context.root, answer.cases, brief, context.item.title);

  const missed = [...missing.map((one) => `${one.id}: ${one.text}`), ...unproved.map(oneLine)];
  if (missed.length > 0) {
    return {
      state: "blocked",
      summary: translate("run.casesIncomplete", { count: missed.length }),
      detail: missed.join("\n"),
    };
  }
  if (unplaced.length > 0) {
    return {
      state: "blocked",
      summary: translate("run.planIncomplete", { count: unplaced.length }),
      detail: unplaced.map(oneLine).join("\n"),
    };
  }

  const detail = [
    answer.solution.how,
    "",
    `${translate("run.why")}: ${answer.solution.why}`,
    ...(answer.solution.decisions.length > 0 ? ["", translate("run.decisions")] : []),
    ...answer.solution.decisions.map((decision) => `- ${decision}`),
    "",
    translate("run.casesHeading"),
    ...answer.cases.cases.map((one) => `${one.id} ${one.criterion}: ${one.then} — ${one.prove}`),
    "",
    translate("run.planHeading"),
    ...answer.plan.steps.map((step) => `- ${step.what} (${step.files.join(", ")})`),
    ...answer.plan.tests.map((test) => `${test.case} → ${test.name} [${test.file}]`),
    "",
    translate("run.casesWritten", { file: TEST_CASES_MD }),
  ].join("\n");

  if (get().autonomy === "reviewPlan") {
    hold(set, get, "design", translate("run.planWaiting"));
  }
  return {
    state: "passed",
    summary: translate("run.designReady", {
      cases: answer.cases.cases.length,
      criteria: brief.criteria.length,
      steps: answer.plan.steps.length,
    }),
    detail,
  };
}

/** One case as a line, for the pages and the prompts that quote it. */
function oneLine(one: TestCase): string {
  return `${one.id}: ${one.then}`;
}

/**
 * The tests, written before the code, and proved to fail.
 *
 * "Write the tests first" is worth nothing as an instruction, because a test
 * that passes before its feature exists looks exactly like a test that works.
 * So this phase measures it: the tests go in, the suites run, and the comparison
 * with the baseline must show something that passed now failing. That is the
 * same comparison the regression gate uses, so "worse" means one thing in this
 * pipeline rather than two things that can drift apart.
 *
 * A run of the suites stops at the first one that proves the point: the proof is
 * that a test fails, and a second opinion from a nine-minute browser suite adds
 * nothing to it.
 */
async function writeTests(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const { brief, plan, baseline: before } = get();
  const cases = await agreedCases(context.root, get, set);
  if (brief === null || plan === null || cases === null) {
    return { state: "skipped", summary: translate("run.noPlan") };
  }

  const prompt = [
    WRITE_TESTS_PROMPT,
    `Goal: ${brief.goal}`,
    "Write exactly these tests, one per case:",
    ...plan.tests.map((test) => {
      const one = cases.cases.find((candidate) => candidate.id === test.case);
      return `- ${test.file} :: ${test.name}${
        one === undefined ? "" : ` — given ${one.given}, when ${one.when}, then ${one.then}`
      }`;
    }),
    ...conventionsOf(get().survey),
  ].join("\n");

  const tried: string[] = [];
  // What the next attempt is told it still owes: nothing yet, then either "no
  // test went red at all" or the exact cases whose own test stayed green.
  let owed = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) note(set, "tests", translate("run.tryingAgain", { attempt, of: ATTEMPTS }));
    const code = await runAgent(owed === "" ? prompt : `${prompt}\n\n${owed}`, context.root, set, "tests");
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };

    // Without a baseline there is nothing to be worse than, so the red proof
    // cannot be made either way - and claiming it was made would be the exact
    // lie this phase exists to prevent.
    if (before === null || measured(before).length === 0) {
      return { state: "skipped", summary: translate("run.noBaseline") };
    }
    const after = await suitesNow(context, set, get, "tests", before, (soFar) =>
      wentRed(judge(before, soFar)),
    );
    const verdict = judge(before, after);
    if (!wentRed(verdict)) {
      tried.push(translate("run.testsNotRedAttempt", { attempt }));
      owed = NOT_RED_YET;
      continue;
    }
    set({ verdict });

    // Red per case, not per suite: only a case whose own test is among the
    // named failures may ever be reported as proved. A runner that names no
    // tests can attribute nothing to any case, and asking again cannot change
    // what the runner prints - the suite-level proof is then all there is.
    const broken = brokenNames(verdict);
    const red = casesProvenRed(plan, broken);
    set({ redCases: [...red] });
    const missing = broken.length === 0 ? [] : cases.cases.filter((one) => !red.has(one.id));
    if (missing.length === 0) {
      return {
        state: "passed",
        summary:
          broken.length === 0
            ? translate("run.testsRedUnnamed")
            : translate("run.testsRed", { count: broken.length }),
        detail: [...tried, differences(verdict)].filter(Boolean).join("\n"),
      };
    }
    if (attempt === ATTEMPTS) {
      // Something is red, so the work can go on - but the cases that never
      // showed their own test failing can never earn a PASS in the report.
      return {
        state: "passed",
        summary: translate("run.testsRedPartly", { red: red.size, missing: missing.length }),
        detail: [...tried, ...missing.map(oneLine), differences(verdict)].filter(Boolean).join("\n"),
      };
    }
    tried.push(
      translate("run.casesStillGreen", {
        attempt,
        detail: missing.map((one) => one.id).join(", "),
      }),
    );
    owed = [CASES_NOT_RED, ...missing.map(oneLine)].join("\n");
  }
  return {
    state: "blocked",
    summary: translate("run.testsNotRed", { attempts: ATTEMPTS }),
    detail: tried.join("\n"),
  };
}

/**
 * The code, until the tests that were red are green.
 *
 * The senior bar is in the prompt rather than in a wish: the conventions read
 * out of this repository, the decisions the solution locked in, the files the
 * language server said must not break, and the four things a reviewer will
 * measure it against anyway. The gate is small and mechanical - the agent
 * finished cleanly, and the working tree actually changed - because the real
 * gates on this phase are the three that come after it.
 */
async function implement(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const { brief, plan, solution } = get();
  if (brief === null || plan === null) return { state: "skipped", summary: translate("run.noPlan") };

  const prompt = [
    IMPLEMENT_PROMPT,
    `Goal: ${brief.goal}`,
    "Acceptance criteria:",
    ...brief.criteria.map((one) => `${one.id}: ${one.text}`),
    "",
    "The plan:",
    ...plan.steps.map((step) => `- ${step.what} (${step.files.join(", ")})`),
    ...(solution === null
      ? []
      : [
          "",
          `The approach agreed: ${solution.how} — ${solution.why}`,
          ...(solution.decisions.length > 0 ? ["What it locks in:"] : []),
          ...solution.decisions.map((decision) => `- ${decision}`),
        ]),
    "",
    "The tests are already written and failing. Make them pass:",
    ...plan.tests.map((test) => `- [${test.case}] ${test.name} in ${test.file}`),
    ...conventionsOf(get().survey),
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

  // An agent that exited cleanly having done nothing is the quietest failure
  // there is: every gate after this one would pass, and the run would report a
  // finished job over an empty diff.
  const diff = await invoke<string>("git_worktree_diff", { root: context.root });
  if (diff.trim() === "") return { state: "blocked", summary: translate("run.noChange") };
  return { state: "passed", summary: translate("run.implemented") };
}

/**
 * Everything measured, and what this change broke put right.
 *
 * One phase, because measuring and mending are one job: a run that finds a
 * regression and reports it has produced homework, not a finished task. What is
 * measured is not Aime's opinion of good code but what the project declared -
 * `npm run check`, `cargo clippy`, every test command it has - and it is
 * measured against the baseline taken before a line was written, so "your change
 * broke this" and "this was already broken" stay different sentences.
 *
 * The cheap gate goes first: the checks are fast, and code that does not compile
 * has nothing to say to a nine-minute browser suite. Then every suite. Whatever
 * this change broke goes back to the agent with the evidence attached and is
 * measured again, up to three rounds - bounded because an agent that has failed
 * three times at the same test is not one attempt from success, it is looping,
 * and looping unattended is how a run spends a night and a fortune.
 *
 * What it will not do is weaken a rule to get past it: the prompts say so, and a
 * check that was already failing before the change is reported rather than
 * blamed on it.
 */
async function verify(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const tasks = await tasksOf(context.root);
  const before = get().baseline;
  const checksBefore = get().checks ?? { checks: [] };
  const hasChecks = checkTasksOf(tasks).length > 0;
  const hasSuites = before !== null && measured(before).length > 0;
  if (!hasChecks && !hasSuites) {
    return { state: "skipped", summary: translate("run.nothingToMeasure") };
  }

  const tried: string[] = [];
  // What had to be mended, so the summary can say it rather than only claiming
  // a number of attempts: "fixed in two attempts" tells a reader nothing about
  // what was wrong.
  const mended: string[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // The checks first: they are the cheap ones, and a tree that does not
    // typecheck has nothing to tell a suite that takes nine minutes.
    let stale: CheckRun[] = [];
    if (hasChecks) {
      const now = await runChecks(tasks, context.root, commandId, runCommand(set, "verify"));
      const broke = newlyFailing(checksBefore, now);
      stale = alreadyFailing(checksBefore, now);
      if (broke.length > 0) {
        if (attempt === ATTEMPTS) {
          return {
            state: "blocked",
            summary: translate("run.qualityFailed", {
              count: broke.length,
              detail: broke.map((check) => check.label).join(", "),
            }),
            detail: [...tried, checkEvidence(broke)].join("\n"),
          };
        }
        const labels = broke.map((check) => check.label).join(", ");
        tried.push(translate("run.qualityFixing", { attempt, detail: labels }));
        mended.push(labels);
        note(set, "verify", tried[tried.length - 1]);
        const code = await runAgent(
          [FIX_CHECKS_PROMPT, checkEvidence(broke)].join("\n\n"),
          context.root,
          set,
          "verify",
        );
        if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
        continue;
      }
    }

    if (!hasSuites) {
      return {
        state: "passed",
        summary: translate("run.checksOnly", { count: stale.length }),
        detail: [...tried, ...stale.map((check) => `- ${check.label}`)].join("\n"),
      };
    }

    const after = await suitesNow(context, set, get, "verify", before);
    if (measured(after).length === 0) {
      // The suites that answered before have stopped answering: that is a
      // broken harness, not a verdict, and guessing either way would be worse.
      return {
        state: "blocked",
        summary: translate("run.suiteWontRun", { detail: describeSilence(after) }),
      };
    }
    const verdict = judge(before, after);
    set({ verdict });
    if (!verdict.blocks) {
      return {
        state: "passed",
        summary:
          attempt === 1
            ? summarise(verdict)
            : translate("run.repaired", { attempts: attempt - 1, detail: mended.join("; ") }),
        detail: [...tried, describeChecks({ checks: stale }), differences(verdict)]
          .filter(Boolean)
          .join("\n"),
      };
    }
    if (attempt === ATTEMPTS) {
      return {
        state: "blocked",
        summary: translate("run.repairGaveUp", { attempts: ATTEMPTS, detail: summarise(verdict) }),
        detail: [...tried, differences(verdict)].filter(Boolean).join("\n"),
      };
    }
    tried.push(translate("run.repairAttempt", { attempt, detail: summarise(verdict) }));
    mended.push(brokenNames(verdict).join(", ") || summarise(verdict));
    note(set, "verify", translate("run.repairing", { attempt, of: ATTEMPTS }));
    const code = await runAgent(repairPrompt(verdict), context.root, set, "verify");
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
  }
  // Unreachable: every path out of the loop above returns. Here so that a future
  // edit to the loop cannot fall through into a silent pass.
  return { state: "blocked", summary: translate("run.repairGaveUp", { attempts: ATTEMPTS, detail: "" }) };
}

/** A reader with a clean context, whose job is to find fault. */
async function reviewPhase(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const diff = await invoke<string>("git_worktree_diff", { root: context.root });
  if (diff.trim() === "") return { state: "skipped", summary: translate("run.nothingChanged") };

  const asking = [
    REVIEW_PROMPT,
    ...conventionsOf(get().survey),
    ...(get().solution === null
      ? []
      : [
          "",
          "What the change was supposed to lock in:",
          ...(get().solution?.decisions ?? []).map((d) => `- ${d}`),
        ]),
    "",
    diff.slice(0, DIFF_LIMIT),
  ].join("\n");
  const review = parseReview(await aiOneshot(asking, context.root));
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

/**
 * What the review found, fixed - and then everything measured again.
 *
 * The half that was missing: a review whose findings nobody acts on is a
 * document, not a gate. Only findings that said how they would be proved are
 * worked on, since those are the ones with something to check afterwards. And
 * every fix is followed by the checks and the suites again, because a fix is a
 * change like any other and the last change of a run is the least examined one.
 *
 * This phase never ends the run. A reviewer is the one voice here that can
 * simply be wrong, so what it could not fix is reported for a person to judge.
 */
async function polish(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const review = get().review;
  const issues = review?.findings.filter((finding) => finding.severity === "issue") ?? [];
  if (issues.length === 0) return { state: "skipped", summary: translate("run.polishNothing") };

  const before = get().baseline;
  const tried: string[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    note(set, "polish", translate("run.polishing", { attempt, of: ATTEMPTS, count: issues.length }));
    const code = await runAgent(
      [
        POLISH_PROMPT,
        ...issues.map(
          (finding) =>
            `- ${finding.file}:${String(finding.line)} — ${finding.message} (check: ${finding.check})`,
        ),
      ].join("\n"),
      context.root,
      set,
      "polish",
    );
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };

    // Nothing is claimed until it is measured again: the checks first, because
    // they are the cheap ones, then every suite against the baseline.
    const tasks = await tasksOf(context.root);
    const checksNow = await runChecks(tasks, context.root, commandId, runCommand(set, "polish"));
    const broke = newlyFailing(get().checks ?? { checks: [] }, checksNow);
    let stillGreen = broke.length === 0;
    if (stillGreen && before !== null && measured(before).length > 0) {
      const after = await suitesNow(context, set, get, "polish", before);
      const verdict = judge(before, after);
      set({ verdict });
      stillGreen = !verdict.blocks;
    }
    if (stillGreen) {
      return {
        state: "passed",
        summary: translate("run.polishFixed", { count: issues.length, attempts: attempt }),
        detail: [...tried, ...issues.map((finding) => `- ${finding.message}`)].join("\n"),
      };
    }
    tried.push(translate("run.polishBroke", { attempt }));
  }
  return {
    state: "blocked",
    summary: translate("run.polishLeft", { count: issues.length, attempts: ATTEMPTS }),
    detail: [...tried, ...issues.map((finding) => `- ${finding.file}: ${finding.message}`)].join("\n"),
  };
}

/**
 * Built, deployed, and proved where it runs — because "done" means a thing a
 * person can use, not a green suite on a dev machine.
 *
 * Aime's half is deterministic: every build task the project declares is run,
 * and a build this change broke goes back to the agent with the output attached,
 * up to the usual three rounds. The agent's half is judgement, so the agent gets
 * it: how this project deploys (its own CI file, Dockerfile or script; locally
 * when it declares nothing), how to smoke-test what came up, and how to drive
 * the running software through every agreed case. What Aime believes is neither
 * the exit banner nor the agent's word but the files: one artifact per case
 * under `.aime/evidence/`, proof of the deployment under its `deploy/` — each
 * checked to exist, to be non-empty and to be newer than the run.
 *
 * A case with no artifact does not stop the run — it is reported unproven,
 * which is the honest sentence. No proof that the deployed thing answered at
 * all does stop it: a run that cannot show the software running has not
 * delivered anything, however green its gates.
 */
async function deliver(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const cases = await agreedCases(context.root, get, set);
  const since = get().run?.startedAt ?? 0;

  // The declared builds first, run by Aime itself: code that does not build has
  // nothing to deploy, and the agent deserves the real output, not a summary.
  const builds = (await tasksOf(context.root)).filter((task) => task.kind === "build");
  const tried: string[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const failing: { task: TaskDef; outcome: CommandOutcome }[] = [];
    for (const task of builds) {
      const outcome = await runCommand(set, "deliver")(
        commandId(),
        task.command,
        folderOf(task, context.root),
        SUITE_TIMEOUT_MS,
      );
      if (outcome.timedOut || outcome.code !== 0) failing.push({ task, outcome });
    }
    if (failing.length === 0) break;
    const labels = failing.map((one) => one.task.label).join(", ");
    if (attempt === ATTEMPTS) {
      return {
        state: "blocked",
        summary: translate("run.buildFailed", { detail: labels }),
        detail: tried.join("\n"),
      };
    }
    tried.push(translate("run.buildFixing", { attempt, detail: labels }));
    note(set, "deliver", tried[tried.length - 1]);
    const evidence = failing
      .map((one) => [`$ ${one.task.command}`, allOutput(one.outcome).slice(-SUITE_OUTPUT_LIMIT)].join("\n"))
      .join("\n\n");
    const code = await runAgent([FIX_BUILD_PROMPT, evidence].join("\n\n"), context.root, set, "deliver");
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
  }

  // Then the agent deploys and proves, and the gate reads the disk. What is
  // still owed is told back verbatim - the missing case ids, the missing
  // deployment proof - because "try again" without the list is a wish.
  const caseIds = (cases?.cases ?? []).map((one) => one.id);
  let missing: TestCase[] = [];
  let proofs: string[] = [];
  let owed = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) note(set, "deliver", translate("run.tryingAgain", { attempt, of: ATTEMPTS }));
    const code = await runAgent(
      [deliverPrompt(cases, get), owed].filter(Boolean).join("\n\n"),
      context.root,
      set,
      "deliver",
    );
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };

    const evidence = await caseEvidence(context.root, caseIds, since);
    missing = (cases?.cases ?? []).filter((one) => (evidence.get(one.id) ?? []).length === 0);
    proofs = await deployProof(context.root, since);
    if (proofs.length > 0 && missing.length === 0) break;
    if (attempt === ATTEMPTS) break;
    owed = [
      ...(proofs.length === 0 ? [NO_DEPLOY_PROOF] : []),
      ...(missing.length > 0 ? [EVIDENCE_MISSING, ...missing.map(oneLine)] : []),
    ].join("\n");
    tried.push(
      translate("run.deliverOwedAttempt", {
        attempt,
        detail: [
          proofs.length === 0 ? translate("run.deliverNoProofShort") : "",
          missing.map((one) => one.id).join(", "),
        ]
          .filter(Boolean)
          .join("; "),
      }),
    );
  }
  if (proofs.length === 0) {
    return {
      state: "blocked",
      summary: translate("run.deliverNoProof"),
      detail: tried.join("\n"),
    };
  }
  return {
    state: "passed",
    summary: translate("run.delivered", {
      proved: caseIds.length - missing.length,
      total: caseIds.length,
    }),
    detail: [
      ...tried,
      ...proofs.map((path) => `- ${path}`),
      ...(missing.length > 0 ? ["", translate("run.deliverUnproven")] : []),
      ...missing.map(oneLine),
    ].join("\n"),
  };
}

/**
 * What the reader gets when they come back: the case table, and the evidence.
 *
 * The table is the thing a tester signs: every case, and whether it is proved.
 * "Proved" is deliberately hard to earn - a test citing the case exists in the
 * tree, that test was seen failing before the code, every suite that answered
 * is green, and an artifact from the running software names the case - because
 * a table that says "passed" wherever nothing contradicted it is the most
 * expensive lie a report can tell. An unproven cell names the first missing
 * condition, so the reader never has to reverse-engineer the gate.
 */
async function report(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const state = get();
  const evidence = await collectEvidence(context.root, state.run?.startedAt ?? 0);
  set({ evidence });

  const written = await existingFiles(context.root);
  const proof =
    state.cases === null
      ? new Map<string, string[]>()
      : await caseEvidence(
          context.root,
          state.cases.cases.map((one) => one.id),
          state.run?.startedAt ?? 0,
        );
  const outcomes =
    state.cases === null
      ? new Map<string, CaseVerdict>()
      : caseOutcomes(state.cases, state.plan, state.verdict, written, new Set(state.redCases), proof);
  const proved = [...outcomes.values()].filter((verdict) => verdict.outcome === "passed").length;

  const markdown = renderReport({
    run: state.run,
    brief: state.brief,
    solution: state.solution,
    cases: state.cases,
    plan: state.plan,
    review: state.review,
    verdict: state.verdict,
    outcomes,
    evidence,
  });
  await writeReport(context.root, state.run?.id ?? "run", markdown);

  return {
    state: "passed",
    summary: translate("run.reportReady", { branch: state.run?.branch ?? "" }),
    detail: [
      state.brief === null ? "" : `${translate("run.reportGoal")}: ${state.brief.goal}`,
      state.cases === null ? "" : translate("run.reportCases", { proved, total: state.cases.cases.length }),
      state.review === null
        ? ""
        : translate("run.reportFindings", {
            count: state.review.findings.filter((finding) => finding.severity === "issue").length,
          }),
      evidence.length === 0 ? "" : translate("run.reportEvidence", { count: evidence.length }),
      translate("run.reportSaved", { file: `${RUNS_DIR}/${state.run?.id ?? ""}.md` }),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  };
}

// ------------------------------------------------------------------ helpers

/** How many files the survey will carry forward. */
const SURVEY_FILE_LIMIT = 40;
/**
 * How many model-found test commands are tried. Each one costs a real run of
 * an unknown command with a fifteen-minute ceiling; a project with more than
 * a handful of suites declares them properly.
 */
const DISCOVERED_SUITE_LIMIT = 5;
/** How much of a diff is worth sending to a reviewer. */
const DIFF_LIMIT = 12_000;
/** How much of a failing suite's output the agent is shown when repairing. */
const SUITE_OUTPUT_LIMIT = 8_000;

/**
 * How many times a phase tries before it admits it cannot.
 *
 * The run's job is to finish the task, so nothing here refuses on its first
 * disappointment: a model that answered with prose is asked again, a plan that
 * missed a case is sent back with the case it missed, an agent that exited badly
 * is given another go. What the bound buys is the other half - three failures at
 * the same thing is a loop, not bad luck, and a loop left alone overnight is
 * what makes an unattended run frightening rather than useful.
 */
const ATTEMPTS = 3;

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

/** The tasks this project declares, asked of the backend each time it matters. */
function tasksOf(root: string): Promise<TaskDef[]> {
  return invoke<TaskDef[]>("detect_tasks", { rootPath: root });
}

/**
 * Every suite, now.
 *
 * Suites the baseline could not run are skipped: paying a fifteen-minute timeout
 * again - three times over inside the repair loop - buys nothing the first one
 * did not already say. `enough` lets a caller stop early when its question is
 * already answered.
 */
async function suitesNow(
  context: Context,
  set: Setter,
  get: Getter,
  phase: PhaseId,
  before: Baseline | null,
  enough?: (soFar: Baseline) => boolean,
): Promise<Baseline> {
  return runSuites(
    await allSuiteTasks(context.root, get),
    context.root,
    commandId,
    runCommand(set, phase),
    before === null ? new Set<string>() : skipList(before),
    enough,
  );
}

/**
 * The suites a pass runs: what the project declares, plus what the model found
 * and Aime proved able to run. Read together everywhere so no pass can quietly
 * measure fewer suites than the baseline did.
 */
async function allSuiteTasks(root: string, get: Getter): Promise<TaskDef[]> {
  return [...(await tasksOf(root)), ...get().discovered];
}

/**
 * The test cases as they stand on disk, falling back to what the phase produced.
 *
 * Read at every phase that acts on them, because between the confirmation gate
 * and the first line of code there is a person with an editor - and if they
 * changed what proof looks like, that is the definition the run must work to.
 */
async function agreedCases(root: string, get: Getter, set: Setter): Promise<TestCases | null> {
  const onDisk = await loadTestCases(root);
  if (onDisk === null) return get().cases;
  set({ cases: onDisk });
  return onDisk;
}

/**
 * The conventions read out of this repository, for the phases that write code.
 *
 * Empty when the survey found none: a heading with nothing under it reads as
 * "this project has no conventions", which is never true and never useful.
 */
function conventionsOf(survey: Survey | null): string[] {
  if (survey === null || (survey.patterns.length === 0 && survey.testsLiveIn === "")) return [];
  return [
    "",
    "How this repository does things - follow these rather than your own defaults:",
    ...survey.patterns.map((pattern) => `- ${pattern}`),
    ...(survey.testsLiveIn === "" ? [] : [`- Tests: ${survey.testsLiveIn}`]),
  ];
}

/**
 * What the language server said uses the code about to change, for the phases
 * that write it.
 *
 * Empty when nothing could be asked or nothing came back - a heading with an
 * empty list under it reads as "nothing depends on this", which is the one thing
 * an unanswered radius must never be mistaken for.
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

/** Every file in the project, as a set of repository-relative paths. */
async function existingFiles(root: string): Promise<Set<string>> {
  try {
    return new Set(await invoke<string[]>("list_files", { root }));
  } catch {
    // A project too large to index, or one that moved. The report then says
    // "unknown" for every case rather than claiming any of them was proved.
    return new Set();
  }
}

/** Writes the readable report beside the run's own journal. */
async function writeReport(root: string, id: string, markdown: string): Promise<void> {
  try {
    await invoke("write_file", {
      path: `${root.replace(/[\\/]+$/, "")}/${RUNS_DIR}/${id}.md`,
      content: markdown,
    });
  } catch (error: unknown) {
    console.warn("could not write the run report:", error);
  }
}

/** One line for what the comparison found, however much of it can be named. */
function summarise(verdict: GateVerdict): string {
  const broken = brokenNames(verdict);
  if (broken.length > 0) return translate("run.regressed", { count: broken.length });
  if (verdict.suites.some((suite) => suite.comparison.brokeWithoutDetail)) {
    return translate("run.regressedUnnamed");
  }
  if (verdict.silent.length > 0) {
    return translate("run.suiteWentQuiet", { count: verdict.silent.length });
  }
  const counted = verdict.suites.filter((suite) => suite.after.report.reader !== null);
  return counted.length === 0
    ? translate("run.noRegressionPlain")
    : translate("run.noRegression", {
        count: counted.reduce((sum, suite) => sum + (suite.after.report.total ?? 0), 0),
      });
}

/** The rest of what moved between the two passes, for the detail panel. */
function differences(verdict: GateVerdict): string {
  return verdict.suites
    .flatMap((suite) => [
      ...suite.comparison.broken.map((name) => `${suite.label} · ${translate("run.nowBroken")}: ${name}`),
      ...suite.comparison.alreadyBroken.map(
        (name) => `${suite.label} · ${translate("run.wasAlreadyRed")}: ${name}`,
      ),
      ...suite.comparison.repaired.map((name) => `${suite.label} · ${translate("run.nowFixed")}: ${name}`),
    ])
    .concat(verdict.silent.map((suite) => `${suite.label} · ${translate("run.wentQuiet")}`))
    .join("\n");
}

/** Every suite of a pass, one line each, for the detail panel. */
function describeSuites(pass: Baseline): string {
  return pass.suites
    .map((suite) => {
      if (suite.run === null) return `${suite.label} · ${translate("run.suiteSilent")}`;
      const report = suite.run.report;
      const counted = report.reader === null ? "" : ` (${String(report.total ?? 0)})`;
      return `${suite.label} · ${report.passed ? translate("run.suiteGreen") : translate("run.suiteRed")}${counted}`;
    })
    .join("\n");
}

/** The project's checks as they stood, one line each. */
function describeChecks(pass: CheckPass): string {
  if (pass.checks.length === 0) return "";
  return pass.checks
    .map(
      (check) =>
        `${check.label} · ${isClean(check) ? translate("run.checkClean") : translate("run.checkDirty")}`,
    )
    .join("\n");
}

/** Why a pass had nothing to say, in the words of the suites that failed to run. */
function describeSilence(pass: Baseline): string {
  const quiet = unusable(pass);
  if (quiet.length === 0) return translate("run.noSuite");
  return quiet
    .map((suite) => {
      const why =
        suite.silence?.reason === "didNotFinish"
          ? translate("run.suiteDidNotFinish")
          : (suite.silence?.detail ?? "");
      return `${suite.label}: ${why}`;
    })
    .join("; ");
}

/** What the agent is told about the damage, with the evidence attached. */
function repairPrompt(verdict: GateVerdict): string {
  const named = brokenNames(verdict);
  const output = verdict.suites
    .filter((suite) => isFailing(suite))
    .map((suite) =>
      [`$ ${suite.after.command}`, allOutput(suite.after.outcome).slice(-SUITE_OUTPUT_LIMIT)].join("\n"),
    )
    .join("\n\n");
  return [
    REPAIR_PROMPT,
    named.length > 0
      ? `These tests passed before your change and fail now:\n${named.map((name) => `- ${name}`).join("\n")}`
      : "A suite that passed before your change fails now.",
    "",
    "The suites said:",
    output,
  ].join("\n");
}

/** Whether this suite is the one carrying the bad news. */
function isFailing(suite: GateVerdict["suites"][number]): boolean {
  return suite.comparison.broken.length > 0 || suite.comparison.brokeWithoutDetail;
}

const REPAIR_PROMPT = `Your change broke something that was working before it.

Fix it, and keep the behaviour you were asked to add: the point is to have both, not to undo your
work. Read the failure first, then the code around it. Do not weaken, skip or delete the failing
test to make it pass - the test is the evidence, not the obstacle.

Run the failing tests when you are done. Do not commit anything.
`;

const WRITE_TESTS_PROMPT = `Write the tests for this change. Write NO production code at all.

This is the step that makes the rest of the run mean something: the tests go in before the feature
exists, so that when they pass later, their passing is evidence rather than decoration.

Rules:
- Write exactly the tests listed below, in the files named. One test per case.
- Assert the observable result the case names - a value, a status, a message, a row. Not that a
  function was called.
- Follow the runner and the layout this repository already uses. Read a neighbouring test first.
- Do NOT touch the code under test, do not add stubs to make an import resolve, and do not weaken
  an assertion so the test can pass today. A test that passes now proves nothing.
- Run the tests you wrote. They must FAIL, and fail because the behaviour is missing rather than
  because the file does not parse.
- Do not commit anything.`;

/** Sent back with the same prompt when the tests came out green. */
const NOT_RED_YET = `Your tests passed WITHOUT the feature being implemented, so they prove nothing.
Read what each case actually requires and assert that. If a test passes against today's code, it is
asserting something that is already true - change it to assert the behaviour that is missing.`;

/** Sent back when the suite went red but named none of these cases' own tests. */
const CASES_NOT_RED = `The suite got worse, but the tests for the cases below were not among the named
failures - so nothing proves those cases yet. Each one needs a test that fails BECAUSE its behaviour
is missing, printed by name in the runner's failures:`;

/** Sent back when nothing on disk shows the deployed software answered. */
const NO_DEPLOY_PROOF = `Nothing under ${DEPLOY_PROOF_DIR}/ shows the deployed software running. Deploy
it, smoke-test it, and save what you saw - the health response, the serving page, the smoke output -
as a non-empty file there.`;

/** Sent back with the cases whose artifact never appeared. */
const EVIDENCE_MISSING = `These cases have no artifact under ${EVIDENCE_DIR}/ - no non-empty file whose
name starts with the case id was written during this run. Prove each one against the running software
and save what you saw:`;

const IMPLEMENT_PROMPT = `Implement this work item in this repository. The tests are already
written and failing; your job is to make them pass by adding the behaviour they describe.

Order matters:
1. Read the files you are about to change, and two or three of their neighbours.
2. Write the code until the failing tests pass. Do not touch the tests: if a test looks wrong, say
   so in your final message and leave it alone.
3. Run the tests you are working on as you go. Do not run the whole suite; that check comes after you.

Write it the way a senior engineer on THIS project would, which means:
- Follow this project's architecture. That is a rule, not advice: the layering, the naming, the error
  handling and the place a thing like this already lives. Nothing here is a green field, and code
  that works while sitting in the wrong layer will be sent back.
- If your change touches a user interface, it must look like the rest of the app. Read the components,
  design tokens, theme and spacing this project already has and use them. Do not introduce a colour,
  a font, a spacing scale or a component style of your own.
- Handle the failure paths deliberately. Never swallow an error to make a signature simpler.
- No dead code, no commented-out code, no "for future use" parameters, no TODO you are not doing.
- Performance is part of correctness: no query inside a loop, nothing that turns one request into N,
  no reading a whole collection to answer a question about one row, no SQL that cannot use an index.
  Say what you did if the cheap way was not available.
- Security is part of correctness, measured against the OWASP Top Ten where it applies: no query
  built by string concatenation, authorisation checked on the server for every request, input
  validated at the boundary, secrets out of the source and out of the logs, nothing deserialised
  from a caller you do not control, and no permission widened to get something working.
- Comments explain why, never what. The code says what.

Do not commit anything.`;

const FIX_BUILD_PROMPT = `This project's own build fails on the current tree. Read the output below,
fix the code so the build passes, and run the failing build command again to see it pass.

Do not weaken anything to get there: no skipped compilation steps, no excluded files, no downgraded
settings. If the build was already failing for a reason unrelated to this change, say so in your
final message. Do not commit anything.`;

/**
 * The deliver prompt is assembled rather than constant because the cases go in
 * it: the agent proves exactly what was agreed, not what it remembers.
 */
function deliverPrompt(cases: TestCases | null, get: Getter): string {
  return [
    DELIVER_PROMPT,
    ...(cases === null
      ? []
      : [
          "",
          "The agreed cases, and how each said it would be proved:",
          ...cases.cases.map((one) => `- ${one.id} (${one.prove}): when ${one.when}, then ${one.then}`),
        ]),
    ...conventionsOf(get().survey),
  ].join("\n");
}

const DELIVER_PROMPT = `The change is written and the gates so far agree. Now finish it the way a team
calls finished: build it, deploy it, and prove it works where it runs.

How to deploy is your call, because you read this project: the way it already declares - its CI
pipeline, Dockerfile, compose file or deploy script - is the way to use. When it declares nothing,
build what it produces and deploy that locally: start the built server, install the packaged library
into a scratch consumer, open the built app. Never invent credentials, and never push to a shared
environment the project did not configure.

Then prove it, and leave the proof on disk - Aime believes files, not reports:
- Save proof that the deployed thing answered under ${DEPLOY_PROOF_DIR}/: the health endpoint's
  response, the smoke check's output, a screenshot of it serving.
- Prove every agreed case against the RUNNING software, the way its "prove" line says: drive the
  browser and capture the screen, send the request and keep the response, invoke the CLI and keep
  what it printed. A case proved by a test gets that test run's own output, captured to a file -
  not a sentence you wrote about it.
- One artifact per case under ${EVIDENCE_DIR}/, named after it: TC1.png, TC2-response.json, TC3.txt.
- Install what you need to drive things - a headless browser, a driver - preferring what the project
  already uses. Show progress, do not ask permission.

Every artifact must be non-empty and written now, during this run. An empty file, a stale file or a
missing one reads as "unproven" in the report, never as a pass. Do not commit anything.`;

const FIX_CHECKS_PROMPT = `Your change broke this project's own checks - the linter, the type checker
or the formatter it runs itself.

Fix the code so they pass. Do not weaken the rules to get there: do not edit the linter's
configuration, do not add an ignore or a suppression comment, and do not disable a rule for a file.
If a rule genuinely cannot be satisfied, say so in your final message and leave it failing rather
than silencing it.

Run the failing command again when you are done. Do not commit anything.`;

const POLISH_PROMPT = `A reviewer with no stake in your work read the change and found these. Each one
came with a way to prove it, so each one is checkable.

Fix them. If one of them is wrong, leave the code alone and say why in your final message - a
reviewer can be mistaken, and a change made to please a mistaken reviewer is worse than the finding.
Keep every test passing and do not weaken one to close a finding.

Do not commit anything.

The findings:`;

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

/** A phase's name, as the log says it. Typed so a new phase cannot be forgotten. */
const PHASE_LABELS: Record<PhaseId, TranslationKey> = {
  baseline: "run.phase.baseline",
  understand: "run.phase.understand",
  design: "run.phase.design",
  tests: "run.phase.tests",
  implement: "run.phase.implement",
  verify: "run.phase.verify",
  review: "run.phase.review",
  polish: "run.phase.polish",
  deliver: "run.phase.deliver",
  report: "run.phase.report",
};

/** Exported for the panel, which shows the phases in this order. */
export { PHASES };
export type { SuiteRun };
