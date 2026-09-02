import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { translate } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import {
  blockingFindings,
  casesWithoutProof,
  fixableFindings,
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
  type Finding,
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
  type Baseline,
  type GateVerdict,
  type SuiteRun,
} from "../lib/regressionGate";
import { renderReport, collectEvidence } from "../lib/runReport";
import { caseEvidence, deployProof, DEPLOY_PROOF_DIR, EVIDENCE_DIR } from "../lib/evidenceFile";
import { emptyTrash, trashOf, untrackedNow, type TrashItem } from "../lib/runTrash";
import {
  caseOutcomes,
  loadTestCases,
  saveTestCases,
  testsNotWritten,
  TEST_CASES_MD,
  type CaseVerdict,
} from "../lib/testCaseFile";
import { readProjectRules, rulesBlock, type RuleFile } from "../lib/projectRules";
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
  /**
   * The rules this project wrote down, read off disk in the first phase.
   *
   * Kept on the run rather than read again per phase: three phases need them,
   * and a file the reader edits mid-run would otherwise change the rules
   * between deciding the approach and writing the code.
   */
  rules: RuleFile[];
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
  rules: [],
  untrackedBefore: [],
};

/**
 * One run and everything it has produced.
 *
 * A slot, because a developer works two tickets at once and hands both over:
 * every run keeps its own artifacts, its own log and its own place to work,
 * and the panel merely chooses which slot it is showing.
 */
export interface RunSlot extends Artifacts {
  run: Run;
  log: LogLine[];
  /**
   * Where this run works. The first run of a project gets the user's own tree
   * — fast, and every cache is warm. A run started while another is live gets
   * a git worktree of its own, because two runs sharing one checkout would
   * overwrite each other's files and measure each other's damage.
   */
  workRoot: string;
}

interface RunState {
  /** Every live run, keyed by run id. A finished run stays until dismissed. */
  slots: Record<string, RunSlot>;
  /** The slot the panel is showing. */
  shownId: string | null;
  /** A finished run opened read-only from the history; never a live slot. */
  past: RunSlot | null;
  autonomy: Autonomy;
  /** Every run this project kept, newest first. */
  history: SavedRun[];
  /** The files the shown run left behind, once the reader asked to see them. */
  trash: TrashItem[] | null;
  /** What the last sweep did, so the panel can say it. */
  trashResult: { deleted: number; failed: string[] } | null;

  setAutonomy: (autonomy: Autonomy) => void;
  /** Shows one live run. */
  show: (id: string) => void;
  /** Starts a run for this item — beside whatever else is already running. */
  start: (item: WorkItem) => Promise<void>;
  /** Carries the shown run on from the confirmation gate. */
  approvePlan: () => Promise<void>;
  /** Picks the shown run back up where a closed lid or a lost network left it. */
  resume: () => Promise<void>;
  /** Reads back what this project left behind: its history, and any live run. */
  reopen: (root: string) => Promise<void>;
  /** Opens a run from the history: read-only when finished, live when cut off. */
  openPast: (id: string) => Promise<void>;
  /** Removes one run from the project's record, at the reader's request. */
  forget: (id: string) => Promise<void>;
  /** Stops the shown run. */
  cancel: () => Promise<void>;
  /** Closes the shown run's panel, keeping the run in the history. */
  dismiss: () => void;
  /** Lists what the shown run left behind, without deleting anything. */
  previewTrash: () => Promise<void>;
  /** Deletes exactly the ticked paths, then lists what is still there. */
  sweepTrash: (paths: readonly string[]) => Promise<void>;
}

/**
 * One run's live machinery: what Cancel has to pull, and the listeners its CLI
 * streams into. Kept outside the store because none of it is for rendering —
 * and kept per run, because cancelling one of two parallel runs must not pull
 * the other one's process.
 */
interface Engine {
  inFlight: { kind: "command" | "agent"; id: string } | null;
  unlisten: UnlistenFn[];
  /** True from start to the run's resting place; guards dismissal and rivals. */
  driving: boolean;
}

const engines = new Map<string, Engine>();

function engineFor(id: string): Engine {
  const found = engines.get(id);
  if (found !== undefined) return found;
  const fresh: Engine = { inFlight: null, unlisten: [], driving: false };
  engines.set(id, fresh);
  return fresh;
}

/**
 * Pulls whatever one run has in flight.
 *
 * The listeners are deliberately left alone: a cancelled agent still reports
 * its exit through them, and that event is what resolves the promise the
 * driving phase is awaiting. Tearing them down here would leave that await
 * hanging forever — the exact trap the listen-before-spawn rule exists for.
 * `runCli` removes its own listeners the moment its exit arrives.
 */
async function stopEngine(id: string): Promise<void> {
  const engine = engines.get(id);
  if (engine === undefined) return;
  if (engine.inFlight?.kind === "command") await execCancel(engine.inFlight.id);
  if (engine.inFlight?.kind === "agent") await invoke("ai_cancel", { runId: engine.inFlight.id });
  engine.inFlight = null;
  engine.driving = false;
}

export const useRun = create<RunState>((set, get) => ({
  slots: {},
  shownId: null,
  past: null,
  autonomy: "reviewPlan",
  history: [],
  trash: null,
  trashResult: null,

  setAutonomy: (autonomy) => {
    set({ autonomy });
  },

  show: (id) => {
    if (!Object.hasOwn(get().slots, id)) return;
    set({ shownId: id, past: null, trash: null, trashResult: null });
  },

  start: async (item) => {
    const home = useWorkspace.getState().rootPath;
    if (home === null) return;
    // The same item twice is a race, not parallelism: the panel switches to
    // the run that is already on it.
    const already = Object.values(get().slots).find(
      (slot) => slot.run.itemId === item.id && !isOver(slot.run),
    );
    if (already !== undefined) {
      get().show(already.run.id);
      useWorkspace.getState().openRun();
      return;
    }

    const startedAt = Date.now();
    let id = `run-${String(startedAt)}`;
    // Two clicks in the same millisecond are two runs, not one file.
    while (Object.hasOwn(get().slots, id)) id = `${id}-`;
    // Whether the user's tree is spoken for decides where this one works. A
    // run waiting at its approval gate holds the tree as surely as one that is
    // driving: its branch is checked out there and its tests will land there.
    const sharedTreeTaken = Object.values(get().slots).some(
      (slot) => slot.workRoot === home && !isOver(slot.run),
    );
    const engine = engineFor(id);
    engine.driving = true;
    const slot: RunSlot = {
      run: newRun(id, item.id, item.title, startedAt),
      log: [],
      workRoot: home,
      ...NOTHING_YET,
    };
    set((state) => ({
      slots: { ...state.slots, [id]: slot },
      shownId: id,
      past: null,
      trash: null,
      trashResult: null,
    }));
    useWorkspace.getState().openRun();

    const ops = opsFor(id);
    let workRoot = home;
    if (sharedTreeTaken) {
      // Another run holds the user's tree, so this one gets a worktree of its
      // own — the price of parallelism, paid only when it buys something.
      const made = await prepareWorktree(home, id, ops.set);
      if (made === null) {
        engine.driving = false;
        ops.set((current) => ({
          run: {
            ...abandonRest(current.run, "understand", "skipped", ""),
            ended: {
              kind: "failed",
              phase: "understand",
              error: translate("run.worktreeFailed"),
            },
          },
        }));
        return;
      }
      workRoot = made;
      ops.set({ workRoot });
    }
    await drive(id, "understand", { item, home, workRoot, id }, ops.set, ops.get);
  },

  approvePlan: async () => {
    const shown = shownSlot(get());
    const home = useWorkspace.getState().rootPath;
    if (shown === null || home === null) return;
    const id = shown.run.id;
    if (!Object.hasOwn(get().slots, id) || engines.get(id)?.driving === true) return;
    const item = itemOf(shown.run.itemId);
    if (item === null) return;
    engineFor(id).driving = true;
    const ops = opsFor(id);
    // From the first phase allowed to write: everything before it was reading,
    // deciding and asking, and all of it is what the reader just agreed to.
    await drive(id, "implement", { item, home, workRoot: shown.workRoot, id }, ops.set, ops.get);
  },

  cancel: async () => {
    const shown = shownSlot(get());
    if (shown === null) return;
    const id = shown.run.id;
    await stopEngine(id);
    opsFor(id).set((current) => ({
      run: {
        ...abandonRest(current.run, current.run.current ?? "understand", "cancelled", ""),
        ended: { kind: "cancelled" },
      },
    }));
  },

  resume: async () => {
    const shown = shownSlot(get());
    const home = useWorkspace.getState().rootPath;
    if (shown === null || home === null) return;
    const id = shown.run.id;
    if (!Object.hasOwn(get().slots, id) || engines.get(id)?.driving === true) return;
    const item = itemOf(shown.run.itemId);
    if (item === null) return;
    engineFor(id).driving = true;
    useWorkspace.getState().openRun();
    const ops = opsFor(id);
    // From the phase that was in flight: every phase is written to be safe to
    // run twice, which is what makes picking one up again possible at all.
    await drive(
      id,
      shown.run.current ?? "understand",
      { item, home, workRoot: shown.workRoot, id },
      ops.set,
      ops.get,
    );
  },

  reopen: async (root) => {
    const history = await listRuns(root);
    // The one worth putting back on screen is the one that never finished: it
    // is the only one with work left in it. Everything else is history until
    // asked for by name.
    const live = await interruptedRun(root);
    const slots: Record<string, RunSlot> = {};
    if (live !== null) slots[live.run.id] = slotFrom(live, root, true);
    set({
      slots,
      shownId: live?.run.id ?? null,
      past: null,
      history,
      trash: null,
      trashResult: null,
    });
  },

  openPast: async (id) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null) return;
    if (Object.hasOwn(get().slots, id)) {
      get().show(id);
      useWorkspace.getState().openRun();
      return;
    }
    const saved = await loadRun(rootPath, id);
    if (saved === null) return;
    if (wasInterrupted(saved)) {
      // A cut-off run is not a museum piece: it goes back into a slot, where
      // Carry on can reach it.
      set((state) => ({
        slots: { ...state.slots, [id]: slotFrom(saved, rootPath, true) },
        shownId: id,
        past: null,
        trash: null,
        trashResult: null,
      }));
    } else {
      set({ past: slotFrom(saved, rootPath, false), trash: null, trashResult: null });
    }
    useWorkspace.getState().openRun();
  },

  forget: async (id) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null || engines.get(id)?.driving === true) return;
    await forgetRun(rootPath, id);
    const history = await listRuns(rootPath);
    // A reader who deletes the run they are looking at is asking for it to be
    // gone, not for it to stay on screen with nothing behind it.
    set((state) => {
      const slots = withoutSlot(state.slots, id);
      const shownId = state.shownId === id ? (Object.keys(slots)[0] ?? null) : state.shownId;
      const past = state.past?.run.id === id ? null : state.past;
      return { history, slots, shownId, past };
    });
    if (shownSlot(get()) === null) useWorkspace.getState().closeRun();
  },

  dismiss: () => {
    // Nothing is deleted: the run stays in the project's record, and the panel
    // simply stops showing it. A record that vanishes when the reader clicks
    // away is not a record.
    const state = get();
    if (state.past !== null) {
      set({ past: null, trash: null, trashResult: null });
      if (state.shownId === null) useWorkspace.getState().closeRun();
      return;
    }
    const id = state.shownId;
    if (id === null || engines.get(id)?.driving === true) return;
    set((current) => {
      const slots = withoutSlot(current.slots, id);
      return {
        slots,
        shownId: Object.keys(slots)[0] ?? null,
        trash: null,
        trashResult: null,
      };
    });
    if (get().shownId === null) useWorkspace.getState().closeRun();
  },

  previewTrash: async () => {
    const shown = shownSlot(get());
    const home = useWorkspace.getState().rootPath;
    if (shown === null || home === null) return;
    const items = await trashOf(shown.workRoot, shown.untrackedBefore, shown.run.startedAt);
    // A worktree run's own checkout is offered too - its change is already
    // committed on the branch, so the tree is disposable, but the evidence
    // lives inside it, so keeping it stays the default.
    if (shown.workRoot !== home) {
      items.push({ path: shown.workRoot, shown: shown.workRoot, keeper: true });
    }
    set({ trash: items, trashResult: null });
  },

  sweepTrash: async (paths) => {
    const shown = shownSlot(get());
    const home = useWorkspace.getState().rootPath;
    if (shown === null || home === null) return;
    const worktreeTicked = shown.workRoot !== home && paths.includes(shown.workRoot);
    // Files inside a worktree that is itself going die with it; deleting them
    // first would only race the removal.
    const files = worktreeTicked
      ? paths.filter((path) => path !== shown.workRoot && !path.startsWith(shown.workRoot))
      : [...paths];
    const trashResult = await emptyTrash(files);
    if (worktreeTicked) {
      try {
        await invoke("git_worktree_remove", { root: home, path: shown.workRoot });
        trashResult.deleted += 1;
      } catch {
        trashResult.failed.push(shown.workRoot);
      }
    }
    // Listed again from disk rather than subtracted in memory, so what the
    // panel shows afterwards is what is actually still there.
    const gone = worktreeTicked && !trashResult.failed.includes(shown.workRoot);
    set({
      trashResult,
      trash: gone ? [] : await trashOf(shown.workRoot, shown.untrackedBefore, shown.run.startedAt),
    });
  },
}));

/** The same map without one slot — spelled out because `delete` mutates. */
function withoutSlot(slots: Record<string, RunSlot>, id: string): Record<string, RunSlot> {
  return Object.fromEntries(Object.entries(slots).filter(([key]) => key !== id));
}

/**
 * Whether a run has reached a resting place a new run may work beside.
 *
 * Waiting and interrupted are *not* over: a run at its approval gate or one
 * cut off mid-phase still owns its tree — its branch is checked out there and
 * its next phase writes there.
 */
function isOver(run: Run): boolean {
  return run.ended !== null && run.ended.kind !== "waiting" && run.ended.kind !== "interrupted";
}

/** The slot the panel is looking at: the opened past run, or the shown live one. */
function shownSlot(state: RunState): RunSlot | null {
  return state.past ?? (state.shownId === null ? null : (state.slots[state.shownId] ?? null));
}

/**
 * The place a parallel run works: a detached worktree beside the project, made
 * runnable the way the project itself says.
 *
 * The install step is deterministic, not a guess: it is the install verb of
 * the package manager the manifest or lockfile names, and nothing at all for a
 * project that declares none. A failed install is noted and not fatal — the
 * baseline's own suites will say precisely what is missing.
 */
async function prepareWorktree(home: string, id: string, set: Setter): Promise<string | null> {
  const base = home.replace(/[\\/]+$/, "");
  // Named by the run's id, which is unique by construction - a timestamp alone
  // could collide when two runs start in the same millisecond.
  const path = `${base}-${id}`;
  note(set, "understand", translate("run.worktreeCreating", { path }));
  try {
    await invoke("git_worktree_add", { root: home, path });
  } catch (error: unknown) {
    note(set, "understand", String(error), "problem");
    return null;
  }
  try {
    const install = await invoke<string | null>("worktree_setup_command", { rootPath: path });
    if (install !== null) {
      note(set, "understand", translate("run.worktreeInstall", { command: install }));
      const { execRun } = await import("../lib/exec");
      const outcome = await execRun(`${id}-setup`, install, path, SUITE_TIMEOUT_MS);
      if (outcome.code !== 0) {
        note(set, "understand", translate("run.worktreeInstallFailed", { command: install }), "problem");
      }
    }
  } catch (error: unknown) {
    // The worktree exists; a setup that would not run is the suites' story to
    // tell, with their own output as the evidence.
    note(set, "understand", String(error), "problem");
  }
  return path;
}

/** Scoped read and write for one slot, so a phase can only touch its own run. */
function opsFor(id: string): { set: Setter; get: Getter } {
  return {
    set: (partial) => {
      useRun.setState((state) => {
        if (!Object.hasOwn(state.slots, id)) return {};
        const slot = state.slots[id];
        const patch = typeof partial === "function" ? partial(slot) : partial;
        return { slots: { ...state.slots, [id]: { ...slot, ...patch } } };
      });
    },
    get: () => {
      const found = useRun.getState().slots;
      // Dismissal is refused while an engine drives, so a driving phase always
      // finds its slot; the throw is here so a broken invariant fails loudly.
      if (!Object.hasOwn(found, id)) throw new Error(`no slot for ${id}`);
      return found[id];
    },
  };
}

/** A saved run put back into a slot, live or read-only. */
function slotFrom(saved: SavedRun, home: string, interrupted: boolean): RunSlot {
  return {
    run: interrupted
      ? { ...saved.run, ended: { kind: "interrupted", phase: saved.run.current ?? "understand" } }
      : saved.run,
    log: [],
    workRoot: saved.workRoot ?? home,
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
    rules: saved.rules,
    untrackedBefore: saved.untrackedBefore,
  };
}

/**
 * Another project is another set of runs. Whatever was driving is pulled — its
 * journal already marks it interrupted, so it is offered back when its own
 * project opens again — and the next folder's own journal is read in its place.
 */
useWorkspace.subscribe((state, previous) => {
  if (state.rootPath === previous.rootPath) return;
  for (const id of engines.keys()) void stopEngine(id);
  engines.clear();
  useRun.setState({
    slots: {},
    shownId: null,
    past: null,
    history: [],
    trash: null,
    trashResult: null,
  });
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
  /** The project the user has open: journal, history and report live here. */
  home: string;
  /** Where this run works: `home`, or this run's own worktree. */
  workRoot: string;
  /** The run's id, which is also its engine's key. */
  id: string;
}

type Setter = (partial: Partial<RunSlot> | ((slot: RunSlot) => Partial<RunSlot>)) => void;
type Getter = () => RunSlot;

/**
 * Walks the phases from here, stopping at the first gate that says stop.
 *
 * The walk is a plain loop rather than anything clever on purpose: the order of
 * the phases and the reason each one blocks should be readable in one place.
 */
async function drive(id: string, start: PhaseId, context: Context, set: Setter, get: Getter): Promise<void> {
  let phase: PhaseId | null = start;
  // Whatever held the run is over the moment it is driven again - carrying the
  // old hold forward is what made a resumed run stop again the instant its
  // first phase finished.
  update(set, (run) => ({ ...run, ended: null }));

  const rest = () => {
    journal(context, get);
    refreshHistory(context.home);
    const engine = engines.get(id);
    if (engine !== undefined) engine.driving = false;
  };

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
    // The project closed under this run: its slot is gone, its journal already
    // marks it interrupted, and there is nothing left to write to.
    if (!Object.hasOwn(useRun.getState().slots, id)) return;
    result = { ...result, startedAt: started, endedAt: Date.now() };
    update(set, (run) => ({ ...run, results: { ...run.results, [at]: result } }));
    // Written after every phase, so a lid closing here costs this phase and
    // nothing before it.
    journal(context, get);

    // A red gate stops the run only where the phase is a blocking one: a
    // reviewer that found something has found something, not grounds to throw
    // away a change whose tests all pass.
    if (!mayContinue(at, result)) {
      update(set, (run) => ({
        ...abandonRest(run, at, "skipped", ""),
        ended: { kind: "blocked", phase: at, why: result.summary },
      }));
      rest();
      return;
    }
    // A phase may hold the run rather than end it - an unanswered question, or
    // the confirmation gate waiting to be read.
    if (get().run.ended !== null) {
      rest();
      return;
    }
    phase = nextPhase(at);
  }

  update(set, (run) => ({ ...run, current: null, ended: { kind: "done" } }));
  rest();
}

/**
 * Writes the run to the project's `.aime/` folder — the project's, not the
 * worktree's: the history belongs to the repository the user has open.
 *
 * Not awaited: the journal exists so a lost run can be picked up, and making
 * every phase wait on a disk write to serve that would be paying the cost on
 * the path that matters for a benefit on the path that rarely happens.
 */
function journal(context: Context, get: Getter): void {
  const slot = get();
  void saveRun(context.home, {
    run: slot.run,
    ...artifactsOf(slot),
    workRoot: context.workRoot === context.home ? undefined : context.workRoot,
  });
}

/** Just the artifacts out of the slot, which is what the journal is. */
function artifactsOf(slot: RunSlot): Artifacts {
  return {
    brief: slot.brief,
    survey: slot.survey,
    radius: slot.radius,
    solution: slot.solution,
    cases: slot.cases,
    plan: slot.plan,
    review: slot.review,
    baseline: slot.baseline,
    checks: slot.checks,
    verdict: slot.verdict,
    evidence: slot.evidence,
    discovered: slot.discovered,
    rules: slot.rules,
    untrackedBefore: slot.untrackedBefore,
  };
}

/**
 * Re-reads the history after a run reaches a resting place.
 *
 * Not awaited and not on the phase path: the list is what the reader browses
 * later, and making a finishing run wait on a directory listing would be paying
 * for the panel out of the work's own time.
 */
function refreshHistory(root: string): void {
  void listRuns(root).then((history) => {
    useRun.setState({ history });
  });
}

/** Changes the run in place, leaving whatever a phase wrote to it alone. */
function update(set: Setter, change: (run: Run) => Run): void {
  set((slot) => ({ run: change(slot.run) }));
}

async function runPhase(phase: PhaseId, context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  switch (phase) {
    case "understand":
      return understand(context, set);
    case "design":
      return design(context, set, get);
    case "implement":
      return implement(context, set, get);
    case "verify":
      return verify(context, set, get);
    case "review":
      return reviewPhase(context, set, get);
    case "report":
      return report(context, set, get);
  }
}

// ------------------------------------------------------------------ phases

/**
 * Aime's own groundwork, taken before a model is asked anything: a branch of
 * its own, git's untracked list, and every suite and check as they stand.
 *
 * Inside the first phase rather than a phase of its own, because a developer
 * opening a ticket does this without calling it a step. Without the last two,
 * though, every later gate has nothing to compare against, and "your change
 * broke this" and "this was already broken" become the same sentence - which is
 * the sentence that makes a gate untrustworthy.
 */
interface Groundwork {
  /** Set when the run cannot sensibly go on, and what refused. */
  refused: string | null;
  /** A line about what the suites said, for the phase's summary. */
  note: string;
  /** The suites and checks as they stand, for the detail panel. */
  detail: string;
}

async function takeBaseline(context: Context, set: Setter): Promise<Groundwork> {
  // A branch left over from an earlier run is the common case, and it is not a
  // reason to hand the task back: the run takes the next free name instead.
  // Only a git that refuses every name has genuinely stopped anything.
  const wanted = branchNameFor(context.item);
  let branch = wanted;
  let refused: string | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    branch = attempt === 1 ? wanted : `${wanted}-${String(attempt)}`;
    // Straight at git in this run's own tree, not through the git store: the
    // store speaks for the folder the user has open, and a parallel run works
    // somewhere else.
    try {
      await invoke("git_create_branch", { root: context.workRoot, name: branch });
      refused = null;
      break;
    } catch (error: unknown) {
      refused = String(error);
    }
  }
  if (refused !== null) {
    return { refused: translate("run.branchRefused", { detail: refused }), note: "", detail: "" };
  }
  set((slot) => ({ run: { ...slot.run, branch } }));
  // The user's own panel should show the branch the run just took their tree to.
  if (context.workRoot === context.home) void useGit.getState().refresh();

  // Git's untracked list, before anything runs: whatever is untracked later and
  // not in here is what this run created — the only files the cleanup button
  // may ever offer to delete.
  set({ untrackedBefore: await untrackedNow(context.workRoot) });

  const nextId = commandIdFor(context.id);
  const tasks = await tasksOf(context.workRoot);
  const suites = await runSuites(tasks, context.workRoot, nextId, runCommand(set, "understand"));
  set({ baseline: suites });
  const checks = await runChecks(tasks, context.workRoot, nextId, runCommand(set, "understand"));
  set({ checks });

  const declared = testTasksOf(tasks).length;
  if (declared > 0 && measured(suites).length === 0) {
    return {
      refused: translate("run.suiteWontRun", { detail: describeSilence(suites) }),
      note: "",
      detail: "",
    };
  }
  const counts = tally(suites);
  return {
    refused: null,
    // No test command at all does not refuse the run - it may still go on - but
    // the gate that matters most cannot speak, and saying so here beats letting
    // the reader discover it at the end.
    note:
      declared === 0
        ? translate("run.noSuite")
        : translate("run.baselineTaken", { suites: measured(suites).length, failed: counts.failed }),
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
 * Step one: what the ticket asks for, and the ground it lands on.
 *
 * The questions arrive together because they have one answer: what a change is
 * for cannot be settled without reading the code it will live in, and asking
 * twice costs a model call and buys nothing a reader can act on differently. So
 * the criteria come out of the ticket, the files and the conventions come out of
 * the repository - every convention citing the file it was seen in, because one
 * with no evidence is a habit - and the dependants come from
 * `textDocument/references` put to the language server this editor is already
 * running, since asking a model to recall its callers produces a plausible list
 * where the server produces the real one. A file no server could answer for is
 * reported as unknown, never as clear.
 *
 * Two things Aime does itself before any of that: the groundwork above, and
 * reading the rules this project wrote down. The second used to be left to luck
 * - each AI CLI picks up a different set of memory files, and the review phase
 * goes through a one-shot call that picks up none - which meant a repository
 * that had settled its architecture in writing could be ignored by the very run
 * told to follow its architecture.
 */
async function understand(context: Context, set: Setter): Promise<PhaseResult> {
  const ground = await takeBaseline(context, set);
  if (ground.refused !== null) return { state: "blocked", summary: ground.refused };

  const rules = await readProjectRules(context.workRoot);
  set({ rules });

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
    const reply = await readRepository(context, asking, set, "understand");
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
  if (testTasksOf(await tasksOf(context.workRoot)).length === 0 && found.suites.length > 0) {
    const candidates: TaskDef[] = found.suites.slice(0, DISCOVERED_SUITE_LIMIT).map((suite, index) => ({
      id: `ai-suite-${String(index + 1)}`,
      label: suite.command,
      kind: "test",
      command: suite.command,
      ...(suite.dir === "." ? {} : { cwd: suite.dir }),
    }));
    note(set, "understand", translate("run.tryingDiscovered", { count: candidates.length }));
    const pass = await runSuites(
      candidates,
      context.workRoot,
      commandIdFor(context.id),
      runCommand(set, "understand"),
    );
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
  // store is loaded long before an editor exists. The probe is pointed at the
  // project the user has open even for a worktree run: the language servers run
  // there, and at this point in the run the two trees hold the same commit.
  const { languageServerProbe } = await import("../lib/lsp/impact");
  note(set, "understand", translate("run.asking", { count: files.length }));
  const radius = await radiusFrom(files, languageServerProbe(context.home));
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
  const read = radiusIsComplete(radius)
    ? translate("run.understood", counts)
    : translate("run.understoodPartly", { ...counts, unknown: radius.unknown.length });
  return {
    state: "passed",
    // The groundwork's line first: what the suites said before a line was
    // written is the fact every later phase is measured against.
    summary: [ground.note, read].filter(Boolean).join(" · "),
    detail: [
      ...(ground.detail === "" ? [] : [ground.detail, ""]),
      ...(rules.length === 0
        ? []
        : [translate("run.rulesRead", { files: rules.map((one) => one.path).join(", ") }), ""]),
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
    ...rulesBlock(get().rules),
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
    const reply = await readRepository(context, [asking, ...shortfall].join("\n"), set, "design");
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
  await saveTestCases(context.workRoot, answer.cases, brief, context.item.title);

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

  // The autonomy switch is the reader's own setting, so it lives on the store
  // rather than on any one run - and it holds every run it applies to.
  if (useRun.getState().autonomy === "reviewPlan") {
    hold(set, "design", translate("run.planWaiting"));
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
 * Step three: the code, and the tests for it, written together.
 *
 * The order is the one a developer actually works in - write it, then test it -
 * and it replaced a phase that put the tests in first and measured the suites
 * getting worse before any code existed. That measurement was real and it is
 * gone on purpose: it cost a second full pass over every suite and a round trip
 * whenever a test came out green, to prove something the reader had already
 * decided to trust.
 *
 * What it leaves behind is one hole - a test that asserts nothing passes just as
 * well as a test that works - and the hole is covered where it is cheapest to
 * cover: `review` reads the diff, and a test that would pass with the feature
 * deleted is exactly the sort of thing a reader with a clean context sees.
 *
 * The senior bar is in the prompt rather than in a wish: the rules this project
 * wrote down, the conventions read out of its code, the decisions the solution
 * locked in, the files the language server said must not break, and the four
 * things a reviewer will measure it against anyway.
 *
 * Two mechanical gates, because the real ones are the phases after this. The
 * agent finished cleanly and the working tree actually changed - an agent that
 * exits 0 having done nothing is the quietest failure there is, and every gate
 * after it would pass over an empty diff. And every test the plan named exists
 * on disk, asked for again by name when it does not: the plan promised one test
 * per case, so a missing file is a case nobody wrote anything for.
 */
async function implement(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const { brief, plan, solution } = get();
  const cases = await agreedCases(context.workRoot, get, set);
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
    "Write these tests as well, one per case, in the files named:",
    ...plan.tests.map((test) => {
      const one = cases?.cases.find((candidate) => candidate.id === test.case);
      return `- ${test.file} :: ${test.name}${
        one === undefined ? "" : ` — given ${one.given}, when ${one.when}, then ${one.then}`
      }`;
    }),
    ...conventionsOf(get().survey),
    ...rulesBlock(get().rules),
    ...whatDependsOnIt(get().radius),
  ].join("\n");

  const tried: string[] = [];
  // What the next attempt is told it still owes: nothing on the first go, then
  // the exact test files the plan promised and the tree does not have.
  let owed = "";
  let missing: Plan["tests"] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) note(set, "implement", translate("run.tryingAgain", { attempt, of: ATTEMPTS }));
    const code = await runAgent(context, owed === "" ? prompt : `${prompt}\n\n${owed}`, set);
    // A cancel is the one answer not worth repeating.
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
    if (code !== 0) {
      if (attempt === ATTEMPTS) return { state: "blocked", summary: translate("run.agentFailed", { code }) };
      tried.push(translate("run.agentFailed", { code }));
      continue;
    }

    const diff = await invoke<string>("git_worktree_diff", { root: context.workRoot });
    if (diff.trim() === "") return { state: "blocked", summary: translate("run.noChange") };

    missing = testsNotWritten(plan, await existingFiles(context.workRoot));
    if (missing.length === 0) {
      return {
        state: "passed",
        summary: translate("run.implemented", { tests: plan.tests.length }),
        detail: tried.join("\n"),
      };
    }
    if (attempt === ATTEMPTS) break;
    tried.push(
      translate("run.testsMissingAttempt", {
        attempt,
        detail: missing.map((test) => test.file).join(", "),
      }),
    );
    owed = [TESTS_MISSING, ...missing.map((test) => `- ${test.file} :: ${test.name}`)].join("\n");
  }
  // The code is written and the tree changed, so the run goes on - but the
  // cases whose test never appeared cannot earn a PASS in the report, and the
  // summary says so rather than reporting a clean finish.
  return {
    state: "passed",
    summary: translate("run.implementedPartly", { missing: missing.length }),
    detail: [...tried, ...missing.map((test) => `- ${test.file} :: ${test.name}`)].join("\n"),
  };
}

/**
 * Step four: everything measured, what this change broke put right, and the
 * thing built and proved where it runs.
 *
 * One phase because it is one sentence a developer says - "test it until the
 * bugs are out" - and because splitting measuring from mending produced
 * homework: a run that finds a regression and reports it has not finished a
 * task. What is measured is not Aime's opinion of good code but what the
 * project declared - `npm run check`, `cargo clippy`, every test command it has,
 * every build task it has - and it is measured against the baseline taken in
 * step one, so "your change broke this" and "this was already broken" stay
 * different sentences.
 */
async function verify(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const measured = await measureAndMend(context, set, get);
  if (measured.state === "blocked") return measured;
  const proved = await buildAndProve(context, set, get);
  if (proved.state === "blocked") return proved;
  return {
    state: measured.state === "skipped" && proved.state === "skipped" ? "skipped" : "passed",
    summary: [measured.summary, proved.summary].filter((line) => line !== "").join(" · "),
    detail: [measured.detail ?? "", proved.detail ?? ""].filter((line) => line !== "").join("\n"),
  };
}

/**
 * The checks and the suites, against the baseline, until they hold.
 *
 * The cheap gate goes first: the checks are fast, and code that does not
 * compile has nothing to say to a nine-minute browser suite. Whatever this
 * change broke goes back to the agent with the evidence attached and is
 * measured again, up to three rounds - bounded because an agent that has failed
 * three times at the same test is not one attempt from success, it is looping,
 * and looping unattended is how a run spends a night and a fortune.
 *
 * A repair round re-runs only the suites that were failing, and a full pass
 * follows once they are green. The old loop paid for every suite in every round
 * - eight full passes over a project's whole test estate in the worst case,
 * most of it re-running tests nothing had touched. Narrowing is safe because
 * `judge` matches suites by id and simply says nothing about one that did not
 * run, and the full pass at the end is what still catches a fix that broke
 * something elsewhere.
 *
 * What it will not do is weaken a rule to get past it: the prompts say so, and a
 * check that was already failing before the change is reported rather than
 * blamed on it.
 */
async function measureAndMend(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const tasks = await tasksOf(context.workRoot);
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
  // The suites a round re-runs: null until something fails, then exactly the
  // ones that did.
  let focus: Set<string> | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // The checks first: they are the cheap ones, and a tree that does not
    // typecheck has nothing to tell a suite that takes nine minutes.
    let stale: CheckRun[] = [];
    if (hasChecks) {
      const now = await runChecks(
        tasks,
        context.workRoot,
        commandIdFor(context.id),
        runCommand(set, "verify"),
      );
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
          context,
          [FIX_CHECKS_PROMPT, checkEvidence(broke)].join("\n\n"),
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

    const after = await suitesNow(context, set, get, "verify", before, focusSkip(before, focus));
    if (measured(after).length === 0) {
      // The suites that answered before have stopped answering: that is a
      // broken harness, not a verdict, and guessing either way would be worse.
      return {
        state: "blocked",
        summary: translate("run.suiteWontRun", { detail: describeSilence(after) }),
      };
    }
    let verdict = judge(before, after);
    set({ verdict });
    if (!verdict.blocks && focus !== null) {
      // The narrow round is green. Nothing is claimed on that alone: a fix can
      // break a suite that was not in the failing set, so the whole estate
      // answers once before this phase says the change holds.
      note(set, "verify", translate("run.confirming"));
      const all = await suitesNow(context, set, get, "verify", before);
      const full = judge(before, all);
      set({ verdict: full });
      // No need to clear the focus: this round either returns below or the
      // repair path sets it from what the full pass just found.
      verdict = full;
    }
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
    focus = failingSuites(verdict);
    note(set, "verify", translate("run.repairing", { attempt, of: ATTEMPTS }));
    const code = await runAgent(context, repairPrompt(verdict), set, "verify");
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
  }
  // Unreachable: every path out of the loop above returns. Here so that a future
  // edit to the loop cannot fall through into a silent pass.
  return { state: "blocked", summary: translate("run.repairGaveUp", { attempts: ATTEMPTS, detail: "" }) };
}

/**
 * Built, and - when a case needs the running software to be believed - deployed
 * and driven.
 *
 * Aime's half is deterministic: every build task the project declares is run,
 * and a build this change broke goes back to the agent with the output
 * attached, up to the usual three rounds. The agent's half is judgement, so the
 * agent gets it: how this project deploys (its own CI file, Dockerfile or
 * script; locally when it declares nothing), how to smoke-test what came up,
 * and how to drive the running software through every agreed case. What Aime
 * believes is neither the exit banner nor the agent's word but the files: one
 * artifact per case under `.aime/evidence/`, proof of the deployment under its
 * `deploy/` - each checked to exist, to be non-empty and to be newer than the
 * run.
 *
 * The whole second half is skipped when the run's own solution said this change
 * needs no deployment to be proved. That is the one thing that keeps a
 * one-line change from paying a deployment's price: "done means deployed" is
 * right for a change a person will use and absurd for a renamed constant, where
 * it would either block honest work or be satisfied by a token file - and a
 * token file in an evidence folder is worse than an empty one.
 */
async function buildAndProve(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const cases = await agreedCases(context.workRoot, get, set);
  const since = get().run.startedAt;
  const builds = (await tasksOf(context.workRoot)).filter((task) => task.kind === "build");
  const tried: string[] = [];

  // The declared builds first, run by Aime itself: code that does not build has
  // nothing to deploy, and the agent deserves the real output, not a summary.
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const failing: { task: TaskDef; outcome: CommandOutcome }[] = [];
    for (const task of builds) {
      const outcome = await runCommand(set, "verify")(
        commandIdFor(context.id)(),
        task.command,
        folderOf(task, context.workRoot),
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
    note(set, "verify", tried[tried.length - 1]);
    const evidence = failing
      .map((one) => [`$ ${one.task.command}`, allOutput(one.outcome).slice(-SUITE_OUTPUT_LIMIT)].join("\n"))
      .join("\n\n");
    const code = await runAgent(context, [FIX_BUILD_PROMPT, evidence].join("\n\n"), set, "verify");
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };
  }

  if (!needsDeploy(get)) {
    return {
      state: builds.length === 0 ? "skipped" : "passed",
      summary:
        builds.length === 0
          ? translate("run.nothingToDeploy")
          : translate("run.builtOnly", { count: builds.length }),
      detail: tried.join("\n"),
    };
  }

  // Then the agent deploys and proves, and the gate reads the disk. What is
  // still owed is told back verbatim - the missing case ids, the missing
  // deployment proof - because "try again" without the list is a wish.
  const caseIds = (cases?.cases ?? []).map((one) => one.id);
  let missing: TestCase[] = [];
  let proofs: string[] = [];
  let owed = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) note(set, "verify", translate("run.tryingAgain", { attempt, of: ATTEMPTS }));
    const code = await runAgent(
      context,
      [deliverPrompt(cases, get), owed].filter(Boolean).join("\n\n"),
      set,
      "verify",
    );
    if (code === null) return { state: "blocked", summary: translate("run.agentCancelled") };

    const evidence = await caseEvidence(context.workRoot, caseIds, since);
    missing = (cases?.cases ?? []).filter((one) => (evidence.get(one.id) ?? []).length === 0);
    proofs = await deployProof(context.workRoot, since);
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
 * Whether this change has to be deployed and driven to be believed.
 *
 * The run's own answer, decided in step two by the model that wrote the cases.
 * A run with no solution at all - one that skipped the design phase - is
 * treated as needing it: the safe direction for a question about proof is the
 * one that asks for more of it.
 */
function needsDeploy(get: Getter): boolean {
  return get().solution?.needsDeploy ?? true;
}

/**
 * Step five: a reader with a clean context finds fault, and then it is fixed.
 *
 * Two calls, one phase. The reviewer must not be the author - that is the whole
 * value of it, and a one-shot call with none of the writing phase's context is
 * how that is arranged - but a review whose findings nobody acts on is a
 * document, not a gate, and giving the acting-on its own phase bought a
 * heading and nothing else.
 *
 * Only findings that said how they would be proved are worked on, since those
 * are the ones with something to check afterwards. Every fix is followed by the
 * checks and the suites again, because a fix is a change like any other and the
 * last change of a run is the least examined one.
 *
 * What ends a run here is narrow on purpose: an unfixed finding about
 * architecture or security. Those are not matters of taste - a change in the
 * wrong layer does not belong in the repository however well it works - and
 * before this they went into the report while the run reported success, which
 * made the architecture rule advice. Everything else a reviewer thinks is
 * reported for a person to judge, because a reviewer can simply be wrong.
 */
async function reviewPhase(context: Context, set: Setter, get: Getter): Promise<PhaseResult> {
  const diff = await invoke<string>("git_worktree_diff", { root: context.workRoot });
  if (diff.trim() === "") return { state: "skipped", summary: translate("run.nothingChanged") };

  const asking = [
    REVIEW_PROMPT,
    ...conventionsOf(get().survey),
    ...rulesBlock(get().rules),
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
  const review = parseReview(await aiOneshot(asking, context.workRoot));
  set({ review });

  const issues = fixableFindings(review);
  const found = translate("run.reviewed", { issues: issues.length, total: review.findings.length });
  const risks = [
    ...review.risks.map((risk) => `? ${risk}`),
    ...review.findings.map(
      (finding) => `${finding.file}:${String(finding.line)} [${finding.kind}] — ${finding.message}`,
    ),
  ].join("\n");
  if (issues.length === 0) return { state: "passed", summary: found, detail: risks };

  const fixed = await fixFindings(context, set, get, issues);
  const blocking = blockingFindings(review);
  if (!fixed.mended && blocking.length > 0) {
    return {
      state: "blocked",
      summary: translate("run.reviewBlocked", {
        count: blocking.length,
        detail: blocking.map((finding) => finding.kind).join(", "),
      }),
      detail: [risks, "", ...fixed.tried, ...blocking.map((one) => `- ${one.file}: ${one.message}`)].join(
        "\n",
      ),
    };
  }
  return {
    state: "passed",
    summary: [
      found,
      fixed.mended
        ? translate("run.polishFixed", { count: issues.length, attempts: fixed.attempts })
        : translate("run.polishLeft", { count: issues.length, attempts: ATTEMPTS }),
    ].join(" · "),
    detail: [risks, "", ...fixed.tried].join("\n"),
  };
}

/** What the fixing rounds ended up doing, for the phase that reports them. */
interface Mending {
  /** True when the findings were addressed and everything still measures clean. */
  mended: boolean;
  attempts: number;
  tried: string[];
}

/**
 * Fixes what the reviewer found, measuring after every round.
 *
 * Nothing is claimed until it is measured again: the checks first, because they
 * are the cheap ones, then every suite against the baseline. A round that fixed
 * the finding and broke a suite has not fixed anything.
 */
async function fixFindings(
  context: Context,
  set: Setter,
  get: Getter,
  issues: readonly Finding[],
): Promise<Mending> {
  const before = get().baseline;
  const tried: string[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    note(set, "review", translate("run.polishing", { attempt, of: ATTEMPTS, count: issues.length }));
    const code = await runAgent(
      context,
      [
        POLISH_PROMPT,
        ...issues.map(
          (finding) =>
            `- ${finding.file}:${String(finding.line)} [${finding.kind}] — ${finding.message} (check: ${finding.check})`,
        ),
      ].join("\n"),
      set,
      "review",
    );
    if (code === null) return { mended: false, attempts: attempt, tried };

    const tasks = await tasksOf(context.workRoot);
    const checksNow = await runChecks(
      tasks,
      context.workRoot,
      commandIdFor(context.id),
      runCommand(set, "review"),
    );
    const broke = newlyFailing(get().checks ?? { checks: [] }, checksNow);
    let stillGreen = broke.length === 0;
    if (stillGreen && before !== null && measured(before).length > 0) {
      const after = await suitesNow(context, set, get, "review", before);
      const verdict = judge(before, after);
      set({ verdict });
      stillGreen = !verdict.blocks;
    }
    if (stillGreen) return { mended: true, attempts: attempt, tried };
    tried.push(translate("run.polishBroke", { attempt }));
  }
  return { mended: false, attempts: ATTEMPTS, tried };
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
  const evidence = await collectEvidence(context.workRoot, state.run.startedAt);
  set({ evidence });

  // A run in a worktree commits its change onto its own branch: the worktree
  // is a workplace, not a place the user visits, and the branch is how the
  // work reaches them at home. A run in the user's tree commits nothing - the
  // uncommitted diff is theirs to review, exactly as before.
  let committed = "";
  if (context.workRoot !== context.home) {
    try {
      await invoke("git_commit_all", {
        root: context.workRoot,
        message: `${state.run.itemTitle}\n\nBy an Aime task run (${state.run.id}).`,
      });
      committed = translate("run.workCommitted", { branch: state.run.branch ?? "" });
    } catch (error: unknown) {
      committed = translate("run.workCommitFailed", { detail: String(error) });
    }
  }

  const written = await existingFiles(context.workRoot);
  const proof =
    state.cases === null
      ? new Map<string, string[]>()
      : await caseEvidence(
          context.workRoot,
          state.cases.cases.map((one) => one.id),
          state.run.startedAt,
        );
  const evidenceRequired = needsDeploy(get);
  const outcomes =
    state.cases === null
      ? new Map<string, CaseVerdict>()
      : caseOutcomes(state.cases, state.plan, state.verdict, written, proof, evidenceRequired);
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
    evidenceRequired,
  });
  await writeReport(context.home, state.run.id, markdown);

  return {
    state: "passed",
    summary: translate("run.reportReady", { branch: state.run.branch ?? "" }),
    detail: [
      state.brief === null ? "" : `${translate("run.reportGoal")}: ${state.brief.goal}`,
      state.cases === null ? "" : translate("run.reportCases", { proved, total: state.cases.cases.length }),
      state.review === null
        ? ""
        : translate("run.reportFindings", {
            count: state.review.findings.filter((finding) => finding.severity === "issue").length,
          }),
      evidence.length === 0 ? "" : translate("run.reportEvidence", { count: evidence.length }),
      committed,
      translate("run.reportSaved", { file: `${RUNS_DIR}/${state.run.id}.md` }),
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
 * did not already say. `skip` overrides that when a caller wants a narrower
 * pass than the default; `focusSkip` is how a repair round asks for one.
 */
async function suitesNow(
  context: Context,
  set: Setter,
  get: Getter,
  phase: PhaseId,
  before: Baseline | null,
  skip?: ReadonlySet<string>,
): Promise<Baseline> {
  return runSuites(
    await allSuiteTasks(context.workRoot, get),
    context.workRoot,
    commandIdFor(context.id),
    runCommand(set, phase),
    skip ?? (before === null ? new Set<string>() : skipList(before)),
  );
}

/**
 * The skip list that narrows a pass to exactly the suites in `focus`.
 *
 * `undefined` when there is no focus, which is how the caller asks for a full
 * pass without knowing what the default skip list is. The unusable suites stay
 * skipped either way: paying a fifteen-minute timeout again buys nothing the
 * first one did not already say.
 */
function focusSkip(before: Baseline | null, focus: ReadonlySet<string> | null): Set<string> | undefined {
  if (before === null || focus === null) return undefined;
  const skip = skipList(before);
  for (const suite of measured(before)) if (!focus.has(suite.id)) skip.add(suite.id);
  return skip;
}

/** The suites carrying the bad news, by id, for the next round to re-run. */
function failingSuites(verdict: GateVerdict): Set<string> {
  return new Set(verdict.suites.filter((suite) => isFailing(suite)).map((suite) => suite.id));
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

/** Sent back with the test files the plan promised and the tree does not have. */
const TESTS_MISSING = `The plan named a test for every case, and these files are not in the tree. Write
each one, in the file named, asserting the behaviour its case describes - a case with no test cannot be
reported as proved:`;

/** Sent back when nothing on disk shows the deployed software answered. */
const NO_DEPLOY_PROOF = `Nothing under ${DEPLOY_PROOF_DIR}/ shows the deployed software running. Deploy
it, smoke-test it, and save what you saw - the health response, the serving page, the smoke output -
as a non-empty file there.`;

/** Sent back with the cases whose artifact never appeared. */
const EVIDENCE_MISSING = `These cases have no artifact under ${EVIDENCE_DIR}/ - no non-empty file whose
name starts with the case id was written during this run. Prove each one against the running software
and save what you saw:`;

const IMPLEMENT_PROMPT = `Implement this work item in this repository, and write the tests for it.

Order matters:
1. Read the files you are about to change, and two or three of their neighbours.
2. Write the code.
3. Write the tests listed below - one per case, in the file named. Assert the observable result the
   case names: a value, a status, a message, a row. Not that a function was called. A test that would
   still pass with your feature deleted is worse than no test, because it will be read as proof.
4. Run the tests you wrote and the ones around them, and fix what they catch. Do not run the whole
   suite; that pass comes after you.

Write it the way a senior engineer on THIS project would, which means:
- Follow this project's architecture. That is a rule, not advice: the layering, the naming, the error
  handling and the place a thing like this already lives. Nothing here is a green field, and code
  that works while sitting in the wrong layer will be sent back - a reviewer after you can end this
  run over exactly that.
- Where this project wrote its rules down, those rules win. They are quoted below when there are any,
  and they outrank both your defaults and anything you infer from the code.
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

/** A fresh id per command, registered with its own run so Cancel pulls the
 * right handle — and only that run's handle. */
function commandIdFor(runId: string): () => string {
  return () => {
    const id = `${runId}-cmd-${String(Date.now())}`;
    engineFor(runId).inFlight = { kind: "command", id };
    return id;
  };
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
  context: Context,
  prompt: string,
  set: Setter,
  phase: PhaseId,
  permission: "readOnly" | "edits",
): Promise<{ code: number | null; text: string }> {
  const engine = engineFor(context.id);
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

  // Until the spawn answers with this run's id, nothing can be attributed:
  // another run's CLI may be streaming at the same moment, and reading its
  // events here would splice one run's words into another's answer. So events
  // are held back, then replayed for the id that turned out to be ours.
  const held: { run_id: string; event: unknown }[] = [];
  const take = (payload: { run_id: string; event: unknown }) => {
    for (const one of parse(payload.event)) {
      if (one.kind === "message-delta") said += one.text;
      if (one.kind === "done" && one.resultText !== undefined) said = one.resultText;
      if (one.kind === "tool-call") note(set, phase, `${one.name} ${one.detail}`.trim(), "output");
    }
  };
  engine.unlisten.push(
    await listen<{ run_id: string; event: unknown }>("ai:stream", (event) => {
      if (runId === null) held.push(event.payload);
      else if (event.payload.run_id === runId) take(event.payload);
    }),
  );
  engine.unlisten.push(
    await listen<{ run_id: string; code: number | null }>("ai:exit", (event) => {
      if (runId === null) {
        early.push({ id: event.payload.run_id, code: event.payload.code });
        return;
      }
      if (event.payload.run_id === runId) report(event.payload.code);
    }),
  );
  const heldErr: { run_id: string; event: string }[] = [];
  engine.unlisten.push(
    await listen<{ run_id: string; event: string }>("ai:stderr", (event) => {
      if (runId === null) heldErr.push(event.payload);
      else if (event.payload.run_id === runId) note(set, phase, event.payload.event, "output");
    }),
  );

  try {
    runId = await invoke<string>("ai_send_prompt", {
      providerId: ai.providerId,
      prompt,
      cwd: context.workRoot,
      // No session id: this must never join or resume the user's chat.
      sessionId: null,
      options: { model: ai.model || null, effort: ai.effort || null, permission },
    });
  } catch (error: unknown) {
    stopListening(engine);
    throw error;
  }
  engine.inFlight = { kind: "agent", id: runId };

  // Whatever streamed or ended while nobody knew which run to listen for.
  for (const payload of held) {
    if (payload.run_id === runId) take(payload);
  }
  held.length = 0;
  for (const payload of heldErr) {
    if (payload.run_id === runId) note(set, phase, payload.event, "output");
  }
  heldErr.length = 0;
  const already = early.find((exit) => exit.id === runId);
  if (already !== undefined) report(already.code);

  const code = await finished;
  stopListening(engine);
  engine.inFlight = null;
  return { code, text: said };
}

/** The phases that change the project, each in its own run's tree. */
async function runAgent(context: Context, prompt: string, set: Setter, phase: PhaseId = "implement") {
  const { code } = await runCli(context, prompt, set, phase, "edits");
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
async function readRepository(
  context: Context,
  prompt: string,
  set: Setter,
  phase: PhaseId,
): Promise<string> {
  const { text } = await runCli(context, prompt, set, phase, "readOnly");
  return text;
}

function stopListening(engine: Engine): void {
  for (const off of engine.unlisten) off();
  engine.unlisten = [];
}

/** Holds the run where it is, waiting on the reader rather than ending. */
function hold(set: Setter, phase: PhaseId, question: string): void {
  set((slot) => ({ run: { ...slot.run, current: null, ended: { kind: "waiting", phase, question } } }));
}

function note(set: Setter, phase: PhaseId, text: string, kind: LogLine["kind"] = "note"): void {
  set((state) => ({ log: [...state.log, { phase, text, kind }].slice(-LOG_LIMIT) }));
}

const LOG_LIMIT = 500;

/**
 * A phase's name, as the log and the panel both say it. Typed so a new phase
 * cannot be forgotten, and exported so the two surfaces cannot drift into
 * calling the same phase two different things.
 */
export const PHASE_LABELS: Record<PhaseId, TranslationKey> = {
  understand: "run.phase.understand",
  design: "run.phase.design",
  implement: "run.phase.implement",
  verify: "run.phase.verify",
  review: "run.phase.review",
  report: "run.phase.report",
};

/** Exported for the panel, which shows the phases in this order. */
export { PHASES };
export type { SuiteRun };
