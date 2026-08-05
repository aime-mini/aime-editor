/**
 * The slice of the Debug Adapter Protocol Aime speaks.
 *
 * Only the messages the editor actually sends or reads are typed here. Every
 * body field is optional on purpose: these shapes describe what *an* adapter
 * may send, and two adapters never agree on all of it (ARCHITECTURE.md §5).
 */

export interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface DapResponse {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  /** Present when `success` is false — the adapter's own words. */
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  seq: number;
  type: "event";
  event: string;
  body?: unknown;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

/** What the adapter says it can do; Aime only asks about the few it uses. */
export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsStepBack?: boolean;
  supportsRestartRequest?: boolean;
  supportsExceptionFilterOptions?: boolean;
  /** What this adapter can stop on: "uncaught", "raised", "assert"… */
  exceptionBreakpointFilters?: ExceptionBreakpointFilter[];
}

/** One kind of exception an adapter can be asked to stop on. */
export interface ExceptionBreakpointFilter {
  filter: string;
  label: string;
  description?: string;
  /** Whether Aime should start with it on - the adapter's own recommendation. */
  default?: boolean;
}

/** A breakpoint as Aime asks for it. */
export interface SourceBreakpoint {
  line: number;
  /** An expression that has to be true for the adapter to stop. */
  condition?: string;
  /** How many hits before it counts, as the adapter's own expression ("> 5"). */
  hitCondition?: string;
  /** Set to log instead of stopping - a logpoint. */
  logMessage?: string;
}

/** A breakpoint as the adapter answers — the line may not be the one asked for. */
export interface AdapterBreakpoint {
  id?: number;
  verified?: boolean;
  line?: number;
  message?: string;
  /** Present on `breakpoint` events, which say nothing else about which file. */
  source?: { path?: string };
}

/** A `breakpoint` event: the adapter revising an answer it already gave. */
export interface BreakpointEventBody {
  reason?: string;
  breakpoint?: AdapterBreakpoint;
}

export interface Thread {
  id: number;
  name: string;
}

export interface Source {
  name?: string;
  path?: string;
  /** Set for frames with no file on disk (eval'd code, node internals). */
  sourceReference?: number;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
}

export interface Scope {
  name: string;
  variablesReference: number;
  /** True for scopes so large the adapter asks not to expand them eagerly. */
  expensive?: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** Non-zero means the value has children that can be fetched. */
  variablesReference: number;
}

export interface StoppedEventBody {
  reason?: string;
  /** Absent when every thread stopped; ids start at 0, so never test truthiness. */
  threadId?: number;
  description?: string;
  text?: string;
  allThreadsStopped?: boolean;
}

export interface OutputEventBody {
  category?: string;
  output?: string;
}

export interface ExitedEventBody {
  exitCode?: number;
}

/**
 * js-debug's answer to `launch`: it asks the client to open a second DAP
 * session, and that child is where the user's code actually runs.
 */
export interface StartDebuggingBody {
  request?: "launch" | "attach";
  configuration?: Record<string, unknown>;
}
