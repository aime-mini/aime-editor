import {
  DapConnection,
  onAdapterExit,
  openConnection,
  startAdapter,
  stopAdapter,
  type ConnectionHandlers,
} from "./client";
import { toSourceBreakpoints, type EditorBreakpoint } from "./launch";
import type {
  AdapterBreakpoint,
  BreakpointEventBody,
  Capabilities,
  ExitedEventBody,
  OutputEventBody,
  Scope,
  StackFrame,
  StartDebuggingBody,
  StoppedEventBody,
  Thread,
  Variable,
} from "./protocol";
import { fileNameOf } from "./paths";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Where execution came to rest, and what the user needs to see about it. */
export interface StoppedContext {
  reason: string;
  threadId: number;
  frames: StackFrame[];
}

export interface SessionCallbacks {
  onOutput: (body: OutputEventBody) => void;
  onStopped: (context: StoppedContext) => void;
  /** The program is moving again — the call stack on screen is stale. */
  onContinued: () => void;
  /** An adapter answered `setBreakpoints`; lines may have moved. */
  onBreakpointsAnswered: (path: string, answered: AdapterBreakpoint[]) => void;
  /** An adapter revised one breakpoint after the fact, identified by its id. */
  onBreakpointChanged: (path: string, changed: AdapterBreakpoint) => void;
  onEnded: (exitCode: number | null) => void;
  onError: (reason: string) => void;
}

export interface LaunchOptions {
  languageId: string;
  root: string;
  /** The launch configuration, already built for this adapter. */
  configuration: Record<string, unknown>;
  /** Breakpoints by absolute file path, as the editor holds them. */
  breakpoints: Map<string, EditorBreakpoint[]>;
  callbacks: SessionCallbacks;
}

/** A promise settled by an event rather than by a response. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ConnectionState {
  connection: DapConnection;
  initialized: ReturnType<typeof deferred>;
}

/** Deep recursion is real; a call stack nobody scrolls to is not worth fetching. */
const MAX_STACK_FRAMES = 200;

/**
 * One debug run, from launch to the program's last line.
 *
 * A run is not one conversation. js-debug answers `launch` with a
 * `startDebugging` reverse request and the user's code executes under that
 * second session, so this class owns a set of connections and keeps track of
 * which one execution is currently paused on (ARCHITECTURE.md §5). debugpy
 * never asks for a second one, and the same code covers it.
 */
export class DebugSession {
  private readonly states = new Map<number, ConnectionState>();
  /** Connections running user code; the run is over when the last one ends. */
  private readonly runners = new Set<number>();
  private stoppedOn: { connectionId: number; threadId: number } | null = null;
  private exitCode: number | null = null;
  private ended = false;
  private unlistenExit: UnlistenFn | null = null;

  private constructor(
    private readonly adapterId: number,
    private readonly options: LaunchOptions,
  ) {}

  static async launch(options: LaunchOptions): Promise<DebugSession> {
    const started = await startAdapter(options.languageId, options.root);
    const session = new DebugSession(started.adapterId, options);
    session.unlistenExit = await onAdapterExit(started.adapterId, () => {
      session.finish();
    });

    try {
      const parent = await session.openSession(started.connectionId);
      await session.configure(parent, options.configuration, "launch");
    } catch (err: unknown) {
      await session.stop();
      throw err;
    }
    return session;
  }

  /** Re-sends one file's breakpoints to every live session. */
  async syncBreakpoints(path: string, breakpoints: EditorBreakpoint[]): Promise<void> {
    await Promise.all(
      [...this.states.values()].map((state) => this.sendBreakpoints(state, path, breakpoints)),
    );
  }

  resume(): Promise<void> {
    return this.step("continue");
  }

  stepOver(): Promise<void> {
    return this.step("next");
  }

  stepInto(): Promise<void> {
    return this.step("stepIn");
  }

  stepOut(): Promise<void> {
    return this.step("stepOut");
  }

  /** Interrupts a running program so its stack can be inspected. */
  async pause(): Promise<void> {
    const connectionId = [...this.runners][0] as number | undefined;
    if (connectionId === undefined) return;
    const connection = this.states.get(connectionId)?.connection;
    if (!connection) return;
    const threadId = await this.firstThreadOf(connection);
    if (threadId === null) return;
    await connection.request("pause", { threadId });
  }

  async scopes(frameId: number): Promise<Scope[]> {
    const connection = this.stoppedConnection();
    if (!connection) return [];
    const body = await connection.request<{ scopes?: Scope[] }>("scopes", { frameId });
    return body.scopes ?? [];
  }

  async variables(variablesReference: number): Promise<Variable[]> {
    const connection = this.stoppedConnection();
    if (!connection) return [];
    const body = await connection.request<{ variables?: Variable[] }>("variables", {
      variablesReference,
    });
    return body.variables ?? [];
  }

  /** Evaluates an expression in the selected frame (the Debug Console's input). */
  async evaluate(expression: string, frameId: number | null): Promise<string> {
    const connection = this.stoppedConnection();
    if (!connection) throw new Error("nothing is paused");
    const body = await connection.request<{ result?: string }>("evaluate", {
      expression,
      frameId: frameId ?? undefined,
      context: "repl",
    });
    return body.result ?? "";
  }

  /** Ends the run and the adapter with it; safe to call more than once. */
  async stop(): Promise<void> {
    const states = [...this.states.values()];
    this.finish();
    await Promise.all(
      states.map((state) =>
        state.connection
          .request("disconnect", { restart: false, terminateDebuggee: true })
          // A disconnecting adapter often dies before it answers; `dap_stop`
          // below is what actually guarantees the process is gone.
          .catch(() => undefined),
      ),
    );
    states.forEach((state) => {
      state.connection.dispose();
    });
    await stopAdapter(this.adapterId);
  }

  private stoppedConnection(): DapConnection | null {
    if (!this.stoppedOn) return null;
    return this.states.get(this.stoppedOn.connectionId)?.connection ?? null;
  }

  private async step(command: "continue" | "next" | "stepIn" | "stepOut"): Promise<void> {
    const target = this.stoppedOn;
    const connection = this.stoppedConnection();
    if (!target || !connection) return;
    // Cleared before the request: the adapter may report the next stop before
    // this promise resolves, and that stop must not be overwritten.
    this.stoppedOn = null;
    this.options.callbacks.onContinued();
    await connection.request(command, { threadId: target.threadId });
  }

  /** Attaches to one connection id and starts routing its traffic. */
  private async openSession(connectionId: number): Promise<ConnectionState> {
    const handlers: ConnectionHandlers = {
      onEvent: (event, body) => {
        this.handleEvent(connectionId, event, body);
      },
      onReverseRequest: (command, args) => this.handleReverseRequest(command, args),
      onClosed: () => {
        this.states.delete(connectionId);
        this.retireRunner(connectionId);
      },
    };
    const connection = await DapConnection.attach(connectionId, handlers);
    const state: ConnectionState = { connection, initialized: deferred() };
    this.states.set(connectionId, state);
    return state;
  }

  /**
   * The handshake, in the order the specification lays down: capabilities
   * first, then the launch request, then — once the adapter says it is ready
   * for configuration — the breakpoints, and only then `configurationDone`.
   *
   * `launch` is deliberately not awaited before the breakpoints go out: an
   * adapter answers it once the program is under way, which is after the
   * moment breakpoints have to be in place.
   */
  private async configure(
    state: ConnectionState,
    configuration: Record<string, unknown>,
    request: "launch" | "attach",
  ): Promise<void> {
    const capabilities = await state.connection.request<Capabilities>("initialize", {
      clientID: "aime",
      clientName: "Aime",
      adapterID: typeof configuration.type === "string" ? configuration.type : this.options.languageId,
      locale: "en",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
    });

    this.runners.add(state.connection.connectionId);
    const running = state.connection.request(request, configuration);

    await state.initialized.promise;
    await Promise.all(
      [...this.options.breakpoints].map(([path, breakpoints]) =>
        this.sendBreakpoints(state, path, breakpoints),
      ),
    );
    if (capabilities.supportsConfigurationDoneRequest === true) {
      await state.connection.request("configurationDone");
    }
    await running;
  }

  private async sendBreakpoints(
    state: ConnectionState,
    path: string,
    breakpoints: EditorBreakpoint[],
  ): Promise<void> {
    try {
      const body = await state.connection.request<{ breakpoints?: AdapterBreakpoint[] }>("setBreakpoints", {
        source: { path, name: fileNameOf(path) },
        breakpoints: toSourceBreakpoints(breakpoints),
      });
      this.options.callbacks.onBreakpointsAnswered(path, body.breakpoints ?? []);
    } catch (err: unknown) {
      // One adapter refusing a file (a source it cannot map) must not abort the
      // run — the other breakpoints are still worth setting.
      console.error("setBreakpoints failed for", path, err);
    }
  }

  private handleEvent(connectionId: number, event: string, body: unknown): void {
    switch (event) {
      case "initialized":
        this.states.get(connectionId)?.initialized.resolve();
        return;
      case "output":
        this.options.callbacks.onOutput(body ?? {});
        return;
      case "breakpoint": {
        // js-debug resolves its provisional breakpoints here, one event each.
        const { breakpoint } = (body ?? {}) as BreakpointEventBody;
        const path = breakpoint?.source?.path;
        if (breakpoint && path !== undefined) this.options.callbacks.onBreakpointChanged(path, breakpoint);
        return;
      }
      case "stopped":
        void this.handleStopped(connectionId, body ?? {});
        return;
      case "continued":
        this.stoppedOn = null;
        this.options.callbacks.onContinued();
        return;
      case "exited":
        this.exitCode = ((body ?? {}) as ExitedEventBody).exitCode ?? null;
        return;
      case "terminated":
        // debugpy sends `exited` then `terminated`; js-debug sends only
        // `terminated`, and only from the session that ran the code.
        this.retireRunner(connectionId);
        return;
      default:
        return;
    }
  }

  private async handleStopped(connectionId: number, body: StoppedEventBody): Promise<void> {
    const connection = this.states.get(connectionId)?.connection;
    if (!connection) return;
    try {
      // A thread id of 0 is legal, so the absent case is tested explicitly.
      const threadId = body.threadId ?? (await this.firstThreadOf(connection));
      if (threadId === null) return;
      this.stoppedOn = { connectionId, threadId };

      const stack = await connection.request<{ stackFrames?: StackFrame[] }>("stackTrace", {
        threadId,
        startFrame: 0,
        levels: MAX_STACK_FRAMES,
      });
      this.options.callbacks.onStopped({
        reason: body.reason ?? "pause",
        threadId,
        frames: stack.stackFrames ?? [],
      });
    } catch (err: unknown) {
      this.options.callbacks.onError(String(err));
    }
  }

  private async firstThreadOf(connection: DapConnection): Promise<number | null> {
    const body = await connection.request<{ threads?: Thread[] }>("threads");
    return body.threads?.[0]?.id ?? null;
  }

  /**
   * js-debug asks for a second session here, and the program runs under it.
   * The child is configured before this answers, which is the order the
   * specification prescribes: the adapter may start the program the moment it
   * sees the response, and by then the breakpoints must already be in place.
   */
  private async handleReverseRequest(command: string, args: unknown): Promise<boolean> {
    if (command !== "startDebugging") return false;
    const body = (args ?? {}) as StartDebuggingBody;
    const childId = await openConnection(this.adapterId);
    const child = await this.openSession(childId);
    await this.configure(child, body.configuration ?? {}, body.request ?? "launch");
    return true;
  }

  /** A session that was running code has ended; the last one ends the run. */
  private retireRunner(connectionId: number): void {
    if (!this.runners.delete(connectionId)) return;
    if (this.runners.size === 0) this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.stoppedOn = null;
    this.unlistenExit?.();
    this.unlistenExit = null;
    this.options.callbacks.onEnded(this.exitCode);
  }
}
