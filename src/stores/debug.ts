import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { languageOf } from "../lib/languages";
import { usable, type AdapterAvailability, type Device } from "../lib/dap/availability";
import {
  resolveTarget,
  type DebugTarget,
  type ResolvedTarget,
  type TargetLaunchOptions,
} from "../lib/dap/targets";
import {
  applyBreakpointAnswer,
  applyBreakpointEvent,
  attachConfig,
  displayLine,
  launchConfig,
  newBreakpoint,
  stripEmpty,
  type AttachTarget,
  type BreakpointRule,
  type EditorBreakpoint,
} from "../lib/dap/launch";
import { appendOutput, type OutputSegment } from "../lib/dap/output";
import { normalizePath, samePath } from "../lib/dap/paths";
import type { ExceptionBreakpointFilter, Scope, StackFrame, Variable } from "../lib/dap/protocol";
import type { DebugSession } from "../lib/dap/session";
import { useLayout } from "./layout";
import { useWorkspace } from "./workspace";

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

/** The program the user picked for this project, kept the same way. */
function targetKey(root: string): string {
  return `aime.debugTarget.${normalizePath(root)}`;
}

/** Which device this project debugs on, per language. */
function deviceKey(root: string): string {
  return `aime.debugDevice.${normalizePath(root)}`;
}

function loadChosenDevices(root: string): Record<string, string | undefined> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(deviceKey(root)) ?? "{}");
    return typeof stored === "object" && stored !== null ? (stored as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Where this project was last attached, so the dialog opens on it again. */
function attachKey(root: string): string {
  return `aime.debugAttach.${normalizePath(root)}`;
}

function loadAttachTarget(root: string): AttachTarget | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(attachKey(root)) ?? "null");
    if (typeof stored !== "object" || stored === null) return null;
    const { host, port } = stored as { host?: unknown; port?: unknown };
    return typeof host === "string" && typeof port === "number" ? { host, port } : null;
  } catch {
    return null;
  }
}

/** The expressions this project watches. */
function watchKey(root: string): string {
  return `aime.debugWatches.${normalizePath(root)}`;
}

function loadWatches(root: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(watchKey(root)) ?? "[]");
    return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Which exceptions to stop on, per language, for this project. */
function exceptionKey(root: string): string {
  return `aime.debugExceptions.${normalizePath(root)}`;
}

function loadEnabledExceptions(root: string): Record<string, string[] | undefined> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(exceptionKey(root)) ?? "{}");
    return typeof stored === "object" && stored !== null ? (stored as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function loadBreakpoints(root: string): Record<string, EditorBreakpoint[]> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(root)) ?? "{}");
    if (typeof stored !== "object" || stored === null) return {};
    // Verification belongs to a run, never to what was stored - the rules do not.
    type Stored = { line?: number } & BreakpointRule;
    return Object.fromEntries(
      Object.entries(stored as Record<string, Stored[]>).map(([path, lines]) => [
        path,
        lines.flatMap((entry) => (typeof entry.line === "number" ? [newBreakpoint(entry.line, entry)] : [])),
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
      .map(([path, list]) => [
        path,
        list.map((breakpoint) => ({ line: breakpoint.line, ...stripEmpty(breakpoint) })),
      ]),
  );
  localStorage.setItem(storageKey(root), JSON.stringify(lines));
}

interface DebugState {
  /** What each language's adapter looks like here; undefined = not probed yet. */
  adapters: Record<string, AdapterAvailability | null | undefined>;
  /** Languages whose adapter is being downloaded right now. */
  downloading: string[];
  /** Programs this project offers, from its own manifests. */
  targets: DebugTarget[];
  /** What each target passes to its program, by target id (`.aime/launch.json`). */
  launchOptions: Record<string, TargetLaunchOptions | undefined>;
  /** Stores arguments and environment for one target; empty forgets them. */
  setLaunchOptions: (targetId: string, options: TargetLaunchOptions) => Promise<void>;
  /** The target whose arguments are being edited, if any. */
  argumentsEditor: string | null;
  openArgumentsEditor: (targetId: string | null) => void;
  /** True once the project has been scanned, so "none" can be told from "not yet". */
  scanned: boolean;
  /** The program the user picked, if they picked one. */
  chosenTargetId: string | null;
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
  /** Expressions kept on screen across stops, in the order they were added. */
  watches: string[];
  /**
   * What each one evaluated to in the frame currently selected. A failed
   * expression keeps its error rather than disappearing: "not defined here" is
   * information, and a row that vanishes looks like a bug.
   */
  watchValues: Record<string, { value?: string; error?: string } | undefined>;
  addWatch: (expression: string) => void;
  removeWatch: (expression: string) => void;
  /** Re-evaluates every watch in the selected frame. */
  refreshWatches: () => Promise<void>;

  /** Asks the backend about a language's adapter; cached unless forced. */
  probeAdapter: (languageId: string, options?: { force?: boolean }) => Promise<void>;
  downloadAdapter: (languageId: string) => Promise<void>;
  /** Reads the project's manifests for programs to debug; cached until forced. */
  scanTargets: (options?: { force?: boolean }) => Promise<void>;
  /** Runs one throwaway session to prove a taught adapter really debugs. */
  verifyAdapter: (languageId: string) => Promise<void>;
  /** The last verification verdict, by language — what the panel shows. */
  verdicts: Record<string, { ok: boolean; detail: string } | undefined>;
  /** Languages being verified right now. */
  verifying: string[];
  /** What the adapter of each language can run on; empty for desktop adapters. */
  devices: Record<string, Device[] | undefined>;
  /** The device chosen per language, remembered for this project. */
  chosenDevice: Record<string, string | undefined>;
  /** Asks the adapter's own command what it can run on. */
  loadDevices: (languageId: string) => Promise<void>;
  chooseDevice: (languageId: string, deviceId: string) => void;
  /**
   * What each language's adapter said it can stop on, remembered from the last
   * run: the list only exists inside a session, and checkboxes that appear only
   * while the program runs would be useless.
   */
  exceptionFilters: Record<string, ExceptionBreakpointFilter[] | undefined>;
  /** Which of them are on, by language. */
  enabledExceptionFilters: Record<string, string[] | undefined>;
  /** Switches one filter, and tells a running session straight away. */
  toggleExceptionFilter: (languageId: string, filter: string) => void;
  /** Remembers what to run for this project; null goes back to deciding. */
  chooseTarget: (targetId: string | null) => void;
  /** What a run would launch right now, and why. */
  resolved: () => ResolvedTarget | null;
  /** Sets or clears a breakpoint, if this is a file Aime can debug at all. */
  toggleBreakpoint: (path: string, line: number) => Promise<void>;
  /** Replaces a file's breakpoints — the editor calls this after an edit moved them. */
  replaceBreakpoints: (path: string, lines: number[]) => void;
  /** Sets what makes one breakpoint fire: a condition, a hit count, a log message. */
  setBreakpointRule: (path: string, line: number, rule: BreakpointRule) => void;
  /** The breakpoint whose rules are being edited, if any. */
  ruleEditor: { path: string; line: number } | null;
  /** Opens the editor for one line, adding the breakpoint first if it has none. */
  editBreakpointRule: (path: string, line: number) => Promise<void>;
  closeRuleEditor: () => void;
  clearBreakpoints: () => void;
  start: () => Promise<void>;
  /** Attaches to a program that is already running and waiting on a port. */
  attach: (target: AttachTarget) => Promise<void>;
  /** The last address attached to, per project, so the dialog remembers it. */
  attachTo: AttachTarget | null;
  /** Whether the attach dialog is open. */
  attachOpen: boolean;
  setAttachOpen: (open: boolean) => void;
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

/** What a run needs, whichever way it was started. */
interface SessionRequest {
  languageId: string;
  /** The folder the adapter runs in - the target's, not the workspace root. */
  cwd: string;
  root: string;
  configuration: Record<string, unknown>;
  request?: "launch" | "attach";
}

/**
 * Starts one run and wires it to the store.
 *
 * Shared by F5 and Attach on purpose: the callbacks are the interesting half of
 * a session, and a second copy of them is how an attached program ends up
 * paused with an empty Variables panel.
 */
async function runSession(
  set: (partial: Partial<DebugState> | ((state: DebugState) => Partial<DebugState>)) => void,
  get: () => DebugState,
  spec: SessionRequest,
): Promise<void> {
  const languageId = spec.languageId;
  try {
    const { DebugSession } = await import("../lib/dap/session");
    session = await DebugSession.launch({
      languageId,
      cwd: spec.cwd,
      root: spec.root,
      request: spec.request,
      configuration: spec.configuration,
      breakpoints: new Map(Object.entries(get().breakpoints)),
      exceptionFilters: get().enabledExceptionFilters[languageId] ?? [],
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
        onExceptionFilters: (filters) => {
          set((s) => ({ exceptionFilters: { ...s.exceptionFilters, [languageId]: filters } }));
          // An adapter's own recommendation is the only sensible default, and
          // it is applied once - after that the user's choice stands.
          if (get().enabledExceptionFilters[languageId] === undefined) {
            const defaults = filters.filter((filter) => filter.default === true).map((f) => f.filter);
            set((s) => ({
              enabledExceptionFilters: { ...s.enabledExceptionFilters, [languageId]: defaults },
            }));
          }
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
}

export const useDebug = create<DebugState>((set, get) => ({
  adapters: {},
  downloading: [],
  targets: [],
  scanned: false,
  chosenTargetId: null,
  launchOptions: {},
  argumentsEditor: null,
  attachTo: null,
  attachOpen: false,
  verdicts: {},
  verifying: [],
  exceptionFilters: {},
  enabledExceptionFilters: {},
  devices: {},
  chosenDevice: {},
  ruleEditor: null,
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
  watches: [],
  watchValues: {},

  addWatch: (expression) => {
    const trimmed = expression.trim();
    if (trimmed === "" || get().watches.includes(trimmed)) return;
    const watches = [...get().watches, trimmed];
    set({ watches });
    const { rootPath } = useWorkspace.getState();
    if (rootPath) localStorage.setItem(watchKey(rootPath), JSON.stringify(watches));
    void get().refreshWatches();
  },

  removeWatch: (expression) => {
    const watches = get().watches.filter((candidate) => candidate !== expression);
    set((s) => ({
      watches,
      watchValues: Object.fromEntries(
        Object.entries(s.watchValues).filter(([candidate]) => candidate !== expression),
      ),
    }));
    const { rootPath } = useWorkspace.getState();
    if (rootPath) localStorage.setItem(watchKey(rootPath), JSON.stringify(watches));
  },

  refreshWatches: async () => {
    const { watches, selectedFrameId, status } = get();
    if (watches.length === 0) return;
    if (status.kind !== "paused") {
      // Nothing to evaluate in: the last values stay on screen, greyed out by
      // the panel, because clearing them would flash the list on every step.
      return;
    }
    const evaluated = await Promise.all(
      watches.map(async (expression) => {
        try {
          return [expression, { value: await session?.evaluate(expression, selectedFrameId, "watch") }];
        } catch (err: unknown) {
          // The adapter's own words: "Cannot find name 'total'" is the answer.
          return [expression, { error: String(err).replace(/^Error:\s*/, "") }];
        }
      }),
    );
    set({ watchValues: Object.fromEntries(evaluated) as DebugState["watchValues"] });
  },

  probeAdapter: async (languageId, { force = false } = {}) => {
    // Forced after something was installed: the cached answer is exactly what
    // would keep reporting the language as unsupported.
    if (!force && languageId in get().adapters) return;
    // The root locates the project's own taught adapters (`.aime/`), which is
    // why it travels with every question about one.
    const availability = await invoke<AdapterAvailability | null>("dap_availability", {
      languageId,
      root: useWorkspace.getState().rootPath,
    });
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

  scanTargets: async ({ force = false } = {}) => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath || (get().scanned && !force)) return;
    // Reading a few manifests, so it is cheap - but it is still a walk of the
    // project, and F5 must not pay for it twice.
    const [targets, launchOptions] = await Promise.all([
      invoke<DebugTarget[]>("dap_targets", { root: rootPath }),
      invoke<Record<string, TargetLaunchOptions>>("dap_launch_options", { root: rootPath }),
    ]);
    set({ targets, launchOptions, scanned: true });
  },

  verifyAdapter: async (languageId) => {
    const { rootPath } = useWorkspace.getState();
    const adapter = get().adapters[languageId];
    if (!rootPath || !adapter?.verifyWith || get().verifying.includes(languageId)) return;

    // The entry names a program relative to the project, because that is the
    // only path an agent can write without knowing where the project lives.
    const program = adapter.verifyWith.program.match(/^([a-zA-Z]:[\\/]|\/)/)
      ? adapter.verifyWith.program
      : `${rootPath}\\${adapter.verifyWith.program}`.replaceAll("/", "\\");

    set((s) => ({ verifying: [...s.verifying, languageId] }));
    // The check runs a program: the console is where a debugger explains itself,
    // so it comes forward for this too.
    useLayout.getState().showDebugConsole();
    try {
      const { verifyAdapter: runCheck } = await import("../lib/dap/verify");
      const verdict = await runCheck({
        adapter,
        target: {
          id: `verify:${languageId}`,
          label: adapter.verifyWith.program,
          languageId,
          program,
          cwd: rootPath,
        },
        line: adapter.verifyWith.line,
        root: rootPath,
      });
      set((s) => ({ verdicts: { ...s.verdicts, [languageId]: verdict } }));
      if (!verdict.ok) return;
      // Aime stamps what Aime saw; the agent never writes this field.
      await invoke("dap_mark_verified", {
        languageId,
        root: rootPath,
        verified: {
          program: adapter.verifyWith.program,
          line: verdict.stoppedAt ?? adapter.verifyWith.line,
          at: new Date().toISOString(),
        },
      });
      await get().probeAdapter(languageId, { force: true });
    } catch (err: unknown) {
      set((s) => ({ verdicts: { ...s.verdicts, [languageId]: { ok: false, detail: String(err) } } }));
    } finally {
      set((s) => ({ verifying: s.verifying.filter((id) => id !== languageId) }));
    }
  },

  setLaunchOptions: async (targetId, options) => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath) return;
    await invoke("dap_set_launch_options", { root: rootPath, targetId, options });
    // Read back rather than assume: the file is the truth, and it may have been
    // edited by hand between one dialog and the next.
    const stored = await invoke<Record<string, TargetLaunchOptions>>("dap_launch_options", {
      root: rootPath,
    });
    set({ launchOptions: stored });
  },

  openArgumentsEditor: (targetId) => {
    set({ argumentsEditor: targetId });
  },

  chooseTarget: (targetId) => {
    set({ chosenTargetId: targetId });
    const { rootPath } = useWorkspace.getState();
    if (!rootPath) return;
    if (targetId === null) localStorage.removeItem(targetKey(rootPath));
    else localStorage.setItem(targetKey(rootPath), targetId);
  },

  resolved: () => {
    const { rootPath, openFilePath } = useWorkspace.getState();
    if (!rootPath) return null;
    return resolveTarget({
      targets: get().targets,
      chosenId: get().chosenTargetId,
      openFilePath,
      openLanguageId: openFilePath === null ? null : languageOf(openFilePath),
      root: rootPath,
    });
  },

  toggleBreakpoint: async (path, line) => {
    // Which files can be debugged is not a guess about file names: it is
    // whether Aime drives an adapter for the language. Without one nothing will
    // ever stop on that line, and a marker in a README - or in package.json,
    // where F9 used to put one just as happily - is a promise the debugger
    // cannot keep. F9 and the context-menu entry are already withdrawn in such
    // a file, so what reaches here is a click in the glyph margin: refused
    // without a noise of its own, and the Run and Debug view holds the reason.
    const languageId = languageOf(path);
    await get().probeAdapter(languageId);
    if (get().adapters[languageId] === null) return;

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

  loadDevices: async (languageId) => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath) return;
    try {
      const devices = await invoke<Device[]>("dap_devices", { languageId, root: rootPath });
      set((s) => ({ devices: { ...s.devices, [languageId]: devices } }));
      // One device is not a choice: an emulator that is the only thing running
      // should not need a click before F5 works.
      const [only] = devices;
      if (devices.length === 1 && get().chosenDevice[languageId] === undefined) {
        get().chooseDevice(languageId, only.id);
      }
    } catch (err: unknown) {
      // The query is the agent's command; when it fails the reason belongs in
      // the console rather than in a silence.
      set((s) => ({
        output: appendOutput(s.output, {
          category: "stderr",
          output: `${String(err)}
`,
        }),
      }));
    }
  },

  chooseDevice: (languageId, deviceId) => {
    set((s) => ({ chosenDevice: { ...s.chosenDevice, [languageId]: deviceId } }));
    const { rootPath } = useWorkspace.getState();
    if (rootPath) {
      localStorage.setItem(deviceKey(rootPath), JSON.stringify(get().chosenDevice));
    }
  },

  toggleExceptionFilter: (languageId, filter) => {
    const enabled = get().enabledExceptionFilters[languageId] ?? [];
    const next = enabled.includes(filter)
      ? enabled.filter((candidate) => candidate !== filter)
      : [...enabled, filter];
    set((s) => ({ enabledExceptionFilters: { ...s.enabledExceptionFilters, [languageId]: next } }));
    const { rootPath } = useWorkspace.getState();
    if (rootPath) {
      localStorage.setItem(exceptionKey(rootPath), JSON.stringify(get().enabledExceptionFilters));
    }
    // Mid-run is exactly when someone turns this on, having just watched a
    // program die somewhere it did not say.
    void session?.syncExceptionFilters(next);
  },

  editBreakpointRule: async (path, line) => {
    // Shift+F9 on a line with no breakpoint means "put a conditional one here",
    // so the breakpoint comes first and the rules follow.
    const here = (get().breakpoints[path] ?? []).some((breakpoint) => displayLine(breakpoint) === line);
    if (!here) await get().toggleBreakpoint(path, line);
    // Still nothing: this is a file Aime does not debug, and the store said so.
    if (!(get().breakpoints[path] ?? []).some((breakpoint) => displayLine(breakpoint) === line)) return;
    set({ ruleEditor: { path, line } });
  },

  closeRuleEditor: () => {
    set({ ruleEditor: null });
  },

  setBreakpointRule: (path, line, rule) => {
    const existing = get().breakpoints[path] ?? [];
    const updated = existing.map((breakpoint) =>
      displayLine(breakpoint) === line ? newBreakpoint(breakpoint.line, rule) : breakpoint,
    );
    const breakpoints = { ...get().breakpoints, [path]: updated };
    set({ breakpoints });
    const { rootPath } = useWorkspace.getState();
    if (rootPath) saveBreakpoints(rootPath, breakpoints);
    // A rule only means something once the adapter knows it, so a running
    // session is told immediately rather than at the next run.
    void session?.syncBreakpoints(path, updated);
  },

  clearBreakpoints: () => {
    set({ breakpoints: {} });
    const { rootPath } = useWorkspace.getState();
    if (rootPath) saveBreakpoints(rootPath, {});
  },

  setAttachOpen: (open) => {
    set({ attachOpen: open });
  },

  attach: async (target) => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath || get().status.kind !== "idle") return;
    set({ attachTo: target, attachOpen: false });
    localStorage.setItem(attachKey(rootPath), JSON.stringify(target));

    // Which adapter to attach with is the same question F5 answers: the language
    // of the program this project debugs.
    await get().scanTargets();
    const resolved = get().resolved();
    if (resolved) await get().probeAdapter(resolved.target.languageId);
    const adapter = resolved === null ? undefined : get().adapters[resolved.target.languageId];
    if (!resolved || !adapter || !usable(adapter)) {
      useLayout.getState().setSidebarView("debug");
      return;
    }

    useLayout.getState().showDebugConsole();
    set({ status: { kind: "starting" }, output: [], exitCode: null, ...CLEARED_STACK });
    await runSession(set, get, {
      languageId: resolved.target.languageId,
      cwd: resolved.target.cwd,
      root: rootPath,
      request: "attach",
      configuration: attachConfig(adapter.configType, target, resolved.target.cwd, adapter.launchExtra),
    });
  },

  start: async () => {
    const { rootPath } = useWorkspace.getState();
    if (!rootPath || get().status.kind !== "idle") return;

    // What runs is the project's program, not the file that happens to be
    // focused: pressing F5 in a helper module used to run the helper module.
    await get().scanTargets();
    const resolved = get().resolved();
    if (resolved) await get().probeAdapter(resolved.target.languageId);
    const adapter = resolved === null ? undefined : get().adapters[resolved.target.languageId];
    // `usable`, not `available`: a taught adapter that has not been watched stop
    // does not get to run a session (lib/dap/availability.ts).
    if (!resolved || !adapter || !usable(adapter)) {
      // F5 answers even when it cannot run: silence reads as a broken key. The
      // Run and Debug view holds the reason - which program it would run, the
      // adapter to download, the one command that installs it, or that this is
      // not a file Aime debugs.
      useLayout.getState().setSidebarView("debug");
      return;
    }

    const { languageId } = resolved.target;
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
        target: resolved.target,
        root: rootPath,
      });

      await runSession(set, get, {
        languageId,
        cwd: resolved.target.cwd,
        root: rootPath,
        configuration: launchConfig(
          adapter.configType,
          program,
          resolved.target.cwd,
          // The device the program runs on is a launch field like any other, and
          // the adapter itself said which one it is called.
          adapter.deviceField === null
            ? adapter.launchExtra
            : {
                ...adapter.launchExtra,
                [adapter.deviceField]: get().chosenDevice[languageId] ?? "",
              },
          get().launchOptions[resolved.target.id] ?? {},
        ),
      });
    } catch (err: unknown) {
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
    // The watches belong to the frame that is selected, so they follow it.
    await get().refreshWatches();
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
    targets: [],
    scanned: false,
    chosenTargetId: state.rootPath ? localStorage.getItem(targetKey(state.rootPath)) : null,
    enabledExceptionFilters: state.rootPath ? loadEnabledExceptions(state.rootPath) : {},
    output: [],
    exitCode: null,
    breakpoints: state.rootPath ? loadBreakpoints(state.rootPath) : {},
    watches: state.rootPath ? loadWatches(state.rootPath) : [],
    attachTo: state.rootPath ? loadAttachTarget(state.rootPath) : null,
    devices: {},
    chosenDevice: state.rootPath ? loadChosenDevices(state.rootPath) : {},
    watchValues: {},
  });
});
