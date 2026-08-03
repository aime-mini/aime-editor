import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { translate } from "../i18n";
import { readExitCode, stripAnsi } from "../lib/taskOutput";
import { useAi } from "./ai";
import { useLayout } from "./layout";
import { useTerminals } from "./terminals";
import { useWorkspace } from "./workspace";

export type TaskKind = "run" | "build" | "test" | "publish";

/** Mirror of the Rust `TaskDef` (tasks/mod.rs). */
export interface TaskDef {
  id: string;
  label: string;
  kind: TaskKind;
  command: string;
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

interface TasksState {
  tasks: TaskDef[];
  /** Runs keyed by terminal tab, so failed output stays attached to its tab. */
  runs: Record<number, TaskRun | undefined>;
  detect: () => Promise<void>;
  run: (task: TaskDef) => Promise<void>;
  appendOutput: (tabKey: number, chunk: string) => void;
  dismissRun: (tabKey: number) => void;
  /** Hands the failed run's output to the AI panel as a fix request. */
  fixWithAi: (tabKey: number) => void;
}

export const useTasks = create<TasksState>((set, get) => ({
  tasks: [],
  runs: {},

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

  run: async (task) => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath) return;
    // The shell reports the exit code itself: an interactive shell does not
    // exit after a task, so the PTY's own exit event never fires here.
    const commandLine = await invoke<string>("task_command_line", { command: task.command });
    useLayout.getState().showTerminal();
    const tabKey = useTerminals.getState().addTab({ initialCommand: commandLine, title: task.label });
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
});
