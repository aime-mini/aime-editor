import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { languageOf } from "../lib/languages";
import {
  applyBreakpointAnswer,
  applyBreakpointEvent,
  displayLine,
  launchConfig,
  newBreakpoint,
  type EditorBreakpoint,
} from "../lib/dap/launch";
import { appendOutput, type OutputSegment } from "../lib/dap/output";
import { normalizePath, samePath } from "../lib/dap/paths";
import type { Scope, StackFrame, Variable } from "../lib/dap/protocol";
import type { DebugSession } from "../lib/dap/session";
import { useLayout } from "./layout";
import { useWorkspace } from "./workspace";

/** Mirror of the Rust `AdapterAvailability` (dap/catalog.rs). */
export interface AdapterAvailability {
  adapterId: string;
  languageId: string;
  configType: string;
  available: boolean;
  /** True when Aime can fetch the adapter itself, with no user action. */
  downloadable: boolean;
  /** True when a run builds the project before the debugger sees it. */
  buildsFirst: boolean;
  installHint: string;
}

export type DebugStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "paused"; reason: string }
  | { kind: "failed"; reason: string };

/** Where the editor should scroll to and highlight the current line. */
export interface DebugLocation {
  path: string;
  line: number;
}

/**
 * The live session. Not part of the store's state: it is an object with
 * identity and a socket behind it, and putting it in a zustand store would
 * make every component that reads the call stack re-render on every event.
 */
let session: DebugSession | null = null;

/** Breakpoints are per project and outlive a run; the key holds the project. */
function storageKey(root: string): string {
  return `aime.breakpoints.${normalizePath(root)}`;
}

function loadBreakpoints(root: string): Record<string, EditorBreakpoint[]> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(root)) ?? "{}");
    if (typeof stored !== "object" || stored === null) return {};
    // Verification belongs to a run, never to what was stored.
    return Object.fromEntries(
      Object.entries(stored as Record<string, { line?: number }[]>).map(([path, lines]) => [
        path,
        lines.flatMap((entry) => (typeof entry.line === "number" ? [newBreakpoint(entry.line)] : [])),
      ]),
    );
  } catch {
    return {}; // corrupted storage is not worth a broken editor
  }
}

function saveBreakpoints(root: string, breakpoints: Record<string, EditorBreakpoint[]>): void {
  const lines = Object.fromEntries(
    Object.entries(breakpoints)
      .filter(([, list]) => list.length > 0)
      .map(([path, list]) => [path, list.map((breakpoint) => ({ line: breakpoint.line }))]),
  );
  localStorage.setItem(storageKey(root), JSON.stringify(lines));
}

interface DebugState {
  /** What each language's adapter looks like here; undefined = not probed yet. */
  adapters: Record<string, AdapterAvailability | null | undefined>;
  /** Languages whose adapter is being downloaded right now. */
  downloading: string[];
  status: DebugStatus;
  /** Breakpoints by absolute path. */
  breakpoints: Record<string, EditorBreakpoint[]>;
  frames: StackFrame[];
  selectedFrameId: number | null;
  scopes: Scope[];
  /** Children by `variablesReference`, fetched when a row is expanded. */
  variables: Record<number, Variable[]>;
  expanded: number[];
  output: OutputSegment[];
  /** The line the debugger is paused on, for the editor to reveal. */
  location: DebugLocation | null;
  /** Set when the program ended; shown once in the console. */
  exitCode: number | null;

  probeAdapter: (languageId: string) => Promise<void>;
  downloadAdapter: (languageId: string) => Promise<void>;
  toggleBreakpoint: (path: string, line: number) => void;
  /** Replaces a file's breakpoints — the editor calls this after an edit moved them. */
  replaceBreakpoints: (path: string, lines: number[]) => void;
  clearBreakpoints: () => void;
  start: () => Promise<void>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
  resume: () => Promise<void>;
  pause: () => Promise<void>;
  stepOver: () => Promise<void>;
  stepInto: () => Promise<void>;
  stepOut: () => Promise<void>;
  selectFrame: (frameId: number) => Promise<void>;
  toggleVariable: (variablesReference: number) => Promise<void>;
  /** Runs one expression in the selected frame and writes both to the console. */
  evaluate: (expression: string) => Promise<void>;
  clearConsole: () => void;
}

/**
 * Said once in the console before a build, in English on purpose: it lands next
 * to the compiler's own output, which is not translated either.
 */
const BUILDING = "Building…\n";

/** Nothing to show while the program is on the move. */
const CLEARED_STACK = {
  frames: [] as StackFrame[],
  selectedFrameId: null,
  scopes: [] as Scope[],
  variables: {} as Record<number, Variable[]>,
  expanded: [] as number[],
  location: null,
};

export const useDebug = create<DebugState>((set, get) => ({
  adapters: {},
  downloading: [],
  status: { kind: "idle" },
  breakpoints: {},
  frames: [],
  selectedFrameId: null,
  scopes: [],
  variables: {},
  expanded: [],
  output: [],
  location: null,
  exitCode: null,

  probeAdapter: async (languageId) => {
    if (languageId in get().adapters) return;
    const availability = await invoke<AdapterAvailability | null>("dap_availability", { languageId });
    set((s) => ({ adapters: { ...s.adapters, [languageId]: availability } }));
  },

  downloadAdapter: async (languageId) => {
    if (get().downloading.includes(languageId)) return;
    set((s) => ({ downloading: [...s.downloading, languageId] }));
    try {
      await invoke("dap_download", { languageId });
      // Re-probe rather than assume: the archive has to have landed where the
      // launcher looks, and only the backend can answer that.
      const availability = await invoke<AdapterAvailability | null>("dap_availability", { languageId });
      set((s) => ({ adapters: { ...s.adapters, [languageId]: availability } }));
    } catch (err: unknown) {
      set({ status: { kind: "failed", reason: String(err) } });
    } finally {
      set((s) => ({ downloading: s.downloading.filter((id) => id !== languageId) }));
    }
  },

  toggleBreakpoint: (path, line) => {
    const existing = get().breakpoints[path] ?? [];
    const without = existing.filter((breakpoint) => displayLine(breakpoint) !== line);
    const next = without.length === existing.length ? [...existing, newBreakpoint(line)] : without;
    get().replaceBreakpoints(
      path,
      next.map((breakpoint) => breakpoint.line),
    );
  },

  replaceBreakpoints: (path, lines) => {
    const existing = get().breakpoints[path] ?? [];
    // A line that was already there keeps what the adapter said about it.
    const kept = lines
      .map((line) => existing.find((breakpoint) => breakpoint.line === line) ?? newBreakpoint(line))
      .sort((a, b) => a.line - b.line);

    // A file with no breakpoints left leaves the map rather than sitting in it
    // as an empty list - the panel and the storage both read "no entry".
    const others = Object.fromEntries(
      Object.entries(get().breakpoints).filter(([candidate]) => candidate !== path),
    );
    const breakpoints = kept.length === 0 ? others : { ...others, [path]: kept };
    set({ breakpoints });

    const { rootPath } = useWorkspace.getState();
    if (rootPath) saveBreakpoints(rootPath, breakpoints);
    void session?.syncBreakpoints(path, kept);
  },

  clearBreakpoints: () => {
    set({ breakpoints: {} });
    const { rootPath } = useWorkspace.getState();
    if (rootPath) saveBreakpoints(rootPath, {});
  },

  start: async () => {
    const { rootPath, openFilePath } = useWorkspace.getState();
    if (!rootPath || !openFilePath || get().status.kind !== "idle") return;

    const languageId = languageOf(openFilePath);
    await get().probeAdapter(languageId);
    const adapter = get().adapters[languageId];
    if (!adapter?.available) return;

    // Whatever started the run - button, F5, palette - the console is where it
    // reports itself, so it comes forward once, here.
    useLayout.getState().showDebugConsole();
    set({ status: { kind: "starting" }, output: [], exitCode: null, ...CLEARED_STACK });
    try {
      // A CLR debugger attaches to an assembly, not to a source file, so what
      // gets launched is whatever the backend says to launch - for C# that
      // means building first, which takes long enough to be worth announcing.
      if (adapter.buildsFirst) {
        set((s) => ({ output: appendOutput(s.output, { category: "console", output: BUILDING }) }));
      }
      const program = await invoke<string>("dap_program", {
        languageId,
        root: rootPath,
        file: openFilePath,
      });

      const { DebugSession } = await import("../lib/dap/session");
      session = await DebugSession.launch({
        languageId,
        root: rootPath,
        configuration: launchConfig(adapter.configType, program, rootPath),
        breakpoints: new Map(Object.entries(get().breakpoints)),
        callbacks: {
          onOutput: (body) => {
            set((s) => ({ output: appendOutput(s.output, body) }));
          },
          onStopped: (context) => {
            const top = context.frames[0] as StackFrame | undefined;
            const location = top?.source?.path ? { path: top.source.path, line: top.line } : null;
            set({
              status: { kind: "paused", reason: context.reason },
              frames: context.frames,
              selectedFrameId: top?.id ?? null,
              location,
            });
            // Stopping somewhere the user cannot see is the same as not
            // stopping: bring the file forward, then fill the variables in.
            if (location) void useWorkspace.getState().openFile(location.path);
            if (top) void get().selectFrame(top.id);
          },
          onContinued: () => {
            set({ status: { kind: "running" }, ...CLEARED_STACK });
          },
          onBreakpointsAnswered: (path, answered) => {
            const requested = get().breakpoints[path] as EditorBreakpoint[] | undefined;
            if (!requested) return;
            set((s) => ({
              breakpoints: { ...s.breakpoints, [path]: applyBreakpointAnswer(requested, answered) },
            }));
          },
          onBreakpointChanged: (path, changed) => {
            // The event spells the path the adapter's way (js-debug lowercases
            // the drive letter), so the file is found by comparison, not by key.
            const key = Object.keys(get().breakpoints).find((candidate) => samePath(candidate, path));
            if (key === undefined) return;
            const current = get().breakpoints[key] as EditorBreakpoint[] | undefined;
            if (!current) return;
            const updated = applyBreakpointEvent(current, changed);
            if (updated !== current) set((s) => ({ breakpoints: { ...s.breakpoints, [key]: updated } }));
          },
          onEnded: (exitCode) => {
            session = null;
            set({ status: { kind: "idle" }, exitCode, ...CLEARED_STACK });
          },
          onError: (reason) => {
            set({ status: { kind: "failed", reason } });
          },
        },
      });
      // A program with no breakpoints runs to completion before this line, and
      // `onEnded` has already put the store back to idle — do not undo that.
      set((s) => (s.status.kind === "starting" ? { status: { kind: "running" } } : {}));
    } catch (err: unknown) {
      session = null;
      set({ status: { kind: "failed", reason: String(err) } });
    }
  },

  restart: async () => {
    await get().stop();
    await get().start();
  },

  stop: async () => {
    const running = session;
    session = null;
    set({ status: { kind: "idle" }, ...CLEARED_STACK });
    await running?.stop();
  },

  resume: async () => {
    await session?.resume();
  },

  pause: async () => {
    await session?.pause();
  },

  stepOver: async () => {
    await session?.stepOver();
  },

  stepInto: async () => {
    await session?.stepInto();
  },

  stepOut: async () => {
    await session?.stepOut();
  },

  selectFrame: async (frameId) => {
    const frame = get().frames.find((candidate) => candidate.id === frameId);
    set({
      selectedFrameId: frameId,
      scopes: [],
      variables: {},
      expanded: [],
      location: frame?.source?.path ? { path: frame.source.path, line: frame.line } : get().location,
    });
    const scopes = (await session?.scopes(frameId)) ?? [];
    // The frame may have been left behind while the scopes were in flight.
    if (get().selectedFrameId !== frameId) return;
    set({ scopes });

    // The first non-expensive scope is opened for the user: a Variables panel
    // that starts empty makes them click before it says anything.
    const first = scopes.find((scope) => scope.expensive !== true);
    if (first) await get().toggleVariable(first.variablesReference);
  },

  toggleVariable: async (variablesReference) => {
    if (get().expanded.includes(variablesReference)) {
      set((s) => ({ expanded: s.expanded.filter((ref) => ref !== variablesReference) }));
      return;
    }
    set((s) => ({ expanded: [...s.expanded, variablesReference] }));
    // Children are fetched once; collapsing and reopening a row is free.
    if (variablesReference in get().variables) return;
    const children = (await session?.variables(variablesReference)) ?? [];
    set((s) => ({ variables: { ...s.variables, [variablesReference]: children } }));
  },

  evaluate: async (expression) => {
    const trimmed = expression.trim();
    if (trimmed === "" || !session) return;
    const echo = (category: "console" | "stdout" | "stderr", text: string) => {
      set((s) => ({ output: appendOutput(s.output, { category, output: text }) }));
    };
    // The expression is echoed first: without it the answers in the console
    // have nothing to belong to once a few have scrolled past.
    echo("console", `> ${trimmed}\n`);
    try {
      echo("stdout", `${await session.evaluate(trimmed, get().selectedFrameId)}\n`);
    } catch (err: unknown) {
      // The adapter's own words - a typo in an expression is answered here, and
      // it is not a failure of the session.
      echo("stderr", `${String(err)}\n`);
    }
  },

  clearConsole: () => {
    set({ output: [], exitCode: null });
  },
}));

/**
 * Breakpoints belong to a project: switching workspaces stops any run and
 * loads the breakpoints that project was left with.
 */
useWorkspace.subscribe((state, previous) => {
  if (state.rootPath === previous.rootPath) return;
  void useDebug.getState().stop();
  useDebug.setState({
    adapters: {},
    output: [],
    exitCode: null,
    breakpoints: state.rootPath ? loadBreakpoints(state.rootPath) : {},
  });
});
