import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { translate } from "../i18n";
import {
  asTaskDef,
  buildDiscoverTasksPrompt,
  parseDiscoveredTasks,
  type DiscoveredTask,
} from "../lib/aiTasks";
import { aiOneshot } from "../lib/aiOneshot";
import { formatProviderError } from "../lib/providerErrors";
import { readExitCode, stripAnsi } from "../lib/taskOutput";
import { useAi } from "./ai";
import { useLayout } from "./layout";
import { useTerminals } from "./terminals";
import { useWorkspace } from "./workspace";

/**
 * Mirror of the Rust `TaskKind`. "check" is the project judging its own code -
 * a linter, a type check, a formatter asked only to report - which a Task Run
 * gates on separately from the tests, because the two fail for different
 * reasons.
 */
export type TaskKind = "run" | "build" | "test" | "check" | "publish";

/** Mirror of the Rust `TaskDef` (tasks/mod.rs). */
export interface TaskDef {
  id: string;
  label: string;
  kind: TaskKind;
  command: string;
  /**
   * Where the command runs, relative to the project root; absent means the root
   * itself. Only carried by the members of a repository that builds nothing of
   * its own - a `frontend` beside an `api`.
   */
  cwd?: string;
}

/** Where a task's command belongs, as an absolute path. */
export function folderOf(task: TaskDef, rootPath: string): string {
  return task.cwd === undefined ? rootPath : `${rootPath}/${task.cwd}`;
}

/** One execution of a task, tied to the terminal tab that shows it. */
export interface TaskRun {
  task: TaskDef;
  output: string;
  /** null while the task is still running. */
  exitCode: number | null;
}

/** Enough context for a fix, without shipping a whole build log to the AI. */
const OUTPUT_LIMIT = 20_000;

function keepTail(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

/**
 * Why one proposed command was not offered, in the user's language.
 *
 * Said rather than dropped: "the AI found nothing" and "the AI found `mvn
 * package` but Maven is not installed" call for completely different next
 * moves, and only the second one is one click away from being solved.
 */
function rejectionOf(task: DiscoveredTask, check: TaskCheck): string {
  return check.programFound
    ? translate("tasks.aiFolderMissing", { command: task.command, folder: task.dir })
    : translate("tasks.aiToolMissing", { command: task.command, program: check.program });
}

/** What Aime could confirm about one command an AI proposed (Rust `TaskCheck`). */
interface TaskCheck {
  program: string;
  programFound: boolean;
  folderFound: boolean;
}

/** The five outcomes, in the order the menu shows them. */
export const TASK_KINDS: TaskKind[] = ["run", "build", "test", "check", "publish"];

interface TasksState {
  tasks: TaskDef[];
  /** Runs keyed by terminal tab, so failed output stays attached to its tab. */
  runs: Record<number, TaskRun | undefined>;
  /** The outcome an AI discovery is working on; null when none is running. */
  discovering: TaskKind | null;
  /** What the last discovery could not offer, and why - shown, never swallowed. */
  rejected: string[];
  detect: () => Promise<void>;
  run: (task: TaskDef) => Promise<void>;
  /**
   * Produces one outcome, whatever it takes: runs the command Aime knows, and
   * when it knows none, has the AI read the project first and then runs what
   * it found. The user asked for a build, not for a decision about detection.
   */
  runKind: (kind: TaskKind) => Promise<void>;
  /**
   * Has the AI read this project for the outcomes Aime could not work out.
   *
   * Runs by itself when a project is opened, because a developer who wanted to
   * build should not be the one who discovers that Aime never looked. Paid for
   * once per repository: the answer is written to `.aime/tasks.json` next to
   * the marker that says the question was asked.
   */
  profile: (wantedFirst?: TaskKind) => Promise<void>;
  appendOutput: (tabKey: number, chunk: string) => void;
  dismissRun: (tabKey: number) => void;
  /** Hands the failed run's output to the AI panel as a fix request. */
  fixWithAi: (tabKey: number) => void;
}

export const useTasks = create<TasksState>((set, get) => ({
  tasks: [],
  runs: {},
  discovering: null,
  rejected: [],

  detect: async () => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath) {
      set({ tasks: [], runs: {} });
      return;
    }
    try {
      set({ tasks: await invoke<TaskDef[]>("detect_tasks", { rootPath }) });
    } catch (err: unknown) {
      console.error("task detection failed:", err);
      set({ tasks: [] });
    }
  },

  runKind: async (kind) => {
    const known = get().tasks.find((task) => task.kind === kind);
    if (known) {
      await get().run(known);
      return;
    }
    // Nothing known yet - either the background pass has not finished or it
    // found nothing. Either way the user asked for a build, so read the
    // project now and then do it.
    await get().profile(kind);
    const learned = get().tasks.find((task) => task.kind === kind);
    if (learned) await get().run(learned);
  },

  profile: async (wantedFirst) => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath || get().discovering !== null) return;
    const kind = wantedFirst ?? "build";
    set({ discovering: kind, rejected: [] });
    try {
      // Only the outcomes Aime came up empty on are named as wanted, but every
      // one the model can support is taken: a project that had to be read to
      // find its build has had its test read at the same time, and asking
      // again later would pay for the same reading twice.
      const missing = TASK_KINDS.filter((candidate) => !get().tasks.some((t) => t.kind === candidate));
      const wanted = missing.includes(kind) ? missing : [kind, ...missing];
      const found = parseDiscoveredTasks(await aiOneshot(buildDiscoverTasksPrompt(wanted), rootPath));
      if (found.length === 0) {
        await invoke("save_tasks", { rootPath, tasks: [] });
        set({ rejected: [translate("tasks.aiFoundNothing")] });
        return;
      }

      // Nothing is offered on the model's word. A command whose tool is not
      // installed, or whose folder is not in this repository, would fail in
      // the user's terminal with a message about neither.
      const checks = await invoke<TaskCheck[]>("check_task_commands", {
        rootPath,
        commands: found.map((task) => task.command),
        folders: found.map((task) => task.dir),
      });
      // Paired once, so a check is never looked up by index again: a rejection
      // has to name the command it is about, and an off-by-one there would
      // blame the wrong one.
      const judged = found.flatMap((task, index) => {
        const check: TaskCheck | undefined = checks.at(index);
        return check ? [{ task, check }] : [];
      });
      const usable = judged.filter(({ check }) => check.programFound && check.folderFound);
      set({
        rejected: judged
          .filter((entry) => !usable.includes(entry))
          .map(({ task, check }) => rejectionOf(task, check)),
      });
      if (usable.length === 0) return;

      // Saved, so the project is only read once: `.aime/tasks.json` is the
      // same channel a person edits by hand, and detection merges it in.
      await invoke("save_tasks", { rootPath, tasks: usable.map(({ task }) => asTaskDef(task)) });
      await get().detect();
    } catch (err: unknown) {
      set({ rejected: [formatProviderError(err)] });
    } finally {
      set({ discovering: null });
    }
  },

  run: async (task) => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath) return;
    // The shell reports the exit code itself: an interactive shell does not
    // exit after a task, so the PTY's own exit event never fires here.
    const commandLine = await invoke<string>("task_command_line", { command: task.command });
    useLayout.getState().showTerminal();
    const tabKey = useTerminals.getState().addTab({
      initialCommand: commandLine,
      title: task.label,
      cwd: folderOf(task, rootPath),
    });
    set((s) => ({ runs: { ...s.runs, [tabKey]: { task, output: "", exitCode: null } } }));
  },

  appendOutput: (tabKey, chunk) => {
    const run = get().runs[tabKey];
    if (!run) return;
    const output = keepTail(run.output + chunk);
    const exitCode = run.exitCode ?? readExitCode(run.output, chunk);
    set((s) => ({ runs: { ...s.runs, [tabKey]: { ...run, output, exitCode } } }));
  },

  dismissRun: (tabKey) => {
    set((s) => ({
      runs: Object.fromEntries(Object.entries(s.runs).filter(([key]) => Number(key) !== tabKey)),
    }));
  },

  fixWithAi: (tabKey) => {
    const run = get().runs[tabKey];
    const { rootPath } = useWorkspace.getState();
    if (!run || !rootPath) return;
    useLayout.getState().setAiPanelVisible(true);
    void useAi.getState().sendPrompt(
      translate("tasks.fixPrompt", {
        command: run.task.command,
        code: String(run.exitCode ?? 0),
        output: stripAnsi(run.output).trim(),
      }),
      rootPath,
    );
  },
}));

// Tasks describe the folder, so they are re-detected whenever it changes
// (opened, closed, or its files changed - a new package.json script counts).
useWorkspace.subscribe((state, prev) => {
  if (state.rootPath !== prev.rootPath || state.treeVersion !== prev.treeVersion) {
    void useTasks.getState().detect();
  }
  // A newly opened project is read for what Aime could not work out, once,
  // before anyone asks. This is the whole point of the editor being AI-first:
  // by the time the developer wants to build a Maven repository, the command
  // is already in the menu and verified, rather than being a thing they have
  // to go and ask for. Only on open - a file change must not re-open the
  // question, and a repository already profiled never asks again.
  if (state.rootPath !== null && state.rootPath !== prev.rootPath) {
    void profileNewProject(state.rootPath);
  }
});

/**
 * The background pass. Silent about everything except a real finding: a
 * developer who opened a project to read code did not ask for a report, and a
 * provider that is not installed is not a task problem.
 */
async function profileNewProject(rootPath: string): Promise<void> {
  if (await invoke<boolean>("task_profile_exists", { rootPath })) return;
  if (useAi.getState().providerHealth !== "ok") return;
  // Let the instant detection land first: it decides which outcomes are still
  // missing, and asking about all five when four are known wastes the call.
  await useTasks.getState().detect();
  if (TASK_KINDS.every((kind) => useTasks.getState().tasks.some((task) => task.kind === kind))) return;
  await useTasks.getState().profile();
}
