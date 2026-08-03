import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DapMessage, DapRequest, DapResponse } from "./protocol";

/** Mirrors the Rust payloads of `dap:message` / `dap:closed` (dap/mod.rs). */
interface MessagePayload {
  connectionId: number;
  message: string;
}

interface ConnectionPayload {
  connectionId: number;
}

interface ExitPayload {
  adapterId: number;
}

interface StdoutPayload {
  adapterId: number;
  text: string;
}

/** What `dap_start` hands back. */
export interface StartedAdapter {
  adapterId: number;
  connectionId: number;
  /** False for stdio adapters: `openConnection` would have nothing to dial. */
  supportsChildSessions: boolean;
}

/**
 * An adapter that answers nothing must not leave the UI waiting forever.
 * Generous because the first `launch` also pays for the debuggee's own start-up
 * (a Node program with a cold module graph is not instant).
 */
const REQUEST_TIMEOUT_MS = 30_000;

export interface ConnectionHandlers {
  onEvent: (event: string, body: unknown) => void;
  /**
   * An adapter-initiated request. Resolving to false answers the adapter with
   * `success: false`, which is how it learns the client could not comply — a
   * silent client would leave it waiting.
   */
  onReverseRequest: (command: string, args: unknown) => Promise<boolean>;
  onClosed: () => void;
}

/** Starts the adapter for a language and opens the first session on it. */
export function startAdapter(languageId: string, root: string): Promise<StartedAdapter> {
  return invoke<StartedAdapter>("dap_start", { languageId, root });
}

/** Opens one more session on a running adapter — what `startDebugging` asks for. */
export function openConnection(adapterId: number): Promise<number> {
  return invoke<number>("dap_connect", { adapterId });
}

/** Kills the adapter and every session on it. */
export async function stopAdapter(adapterId: number): Promise<void> {
  await invoke("dap_stop", { adapterId });
}

/** Notifies when the adapter process itself is gone. */
export function onAdapterExit(adapterId: number, handler: () => void): Promise<UnlistenFn> {
  return listen<ExitPayload>("dap:exit", ({ payload }) => {
    if (payload.adapterId === adapterId) handler();
  });
}

/**
 * Lines the adapter process printed on its own stdout.
 *
 * Not a curiosity: measured, delve writes the debugged program's output there
 * instead of sending `output` events, so without this a Go program looks as if
 * it printed nothing at all.
 */
export function onAdapterStdout(adapterId: number, handler: (text: string) => void): Promise<UnlistenFn> {
  return listen<StdoutPayload>("dap:stdout", ({ payload }) => {
    if (payload.adapterId === adapterId) handler(payload.text);
  });
}

/**
 * One DAP conversation: sequence numbers, pending requests, events, and the
 * requests that come the other way.
 *
 * A debug run owns several of these. js-debug answers `launch` by asking for a
 * second session, and it is the child that reports threads and breakpoint hits
 * (ARCHITECTURE.md §5) — so nothing here assumes it is the only connection.
 */
export class DapConnection {
  private nextSeq = 1;
  private readonly pending = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (error: Error) => void; timer: number }
  >();
  private readonly unlisteners: UnlistenFn[] = [];
  private closed = false;

  private constructor(
    readonly connectionId: number,
    private readonly handlers: ConnectionHandlers,
  ) {}

  static async attach(connectionId: number, handlers: ConnectionHandlers): Promise<DapConnection> {
    const connection = new DapConnection(connectionId, handlers);
    connection.unlisteners.push(
      await listen<MessagePayload>("dap:message", ({ payload }) => {
        if (payload.connectionId === connectionId) connection.receive(payload.message);
      }),
      await listen<ConnectionPayload>("dap:closed", ({ payload }) => {
        if (payload.connectionId === connectionId) connection.handleClosed();
      }),
    );
    return connection;
  }

  request<T>(command: string, args?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${command}: the debug session ended`));
    const seq = this.nextSeq++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`${command}: the debug adapter did not answer`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(seq, { resolve: resolve as (body: unknown) => void, reject, timer });
      const request: DapRequest = { seq, type: "request", command, arguments: args };
      this.send(request);
    });
  }

  /** Ends the local side; the adapter is stopped through `stopAdapter`. */
  dispose(): void {
    this.handleClosed();
  }

  private send(message: DapRequest | DapResponse): void {
    void invoke("dap_send", {
      connectionId: this.connectionId,
      message: JSON.stringify(message),
    }).catch((err: unknown) => {
      console.error("dap send failed:", err);
    });
  }

  private receive(raw: string): void {
    let message: DapMessage;
    try {
      message = JSON.parse(raw) as DapMessage;
    } catch {
      return; // a malformed frame must not take the session down
    }

    if (message.type === "response") {
      this.settle(message);
      return;
    }
    if (message.type === "request") {
      void this.answerReverseRequest(message);
      return;
    }
    this.handlers.onEvent(message.event, message.body);
  }

  private async answerReverseRequest(request: DapRequest): Promise<void> {
    let success = false;
    try {
      success = await this.handlers.onReverseRequest(request.command, request.arguments);
    } catch (err: unknown) {
      console.error(`dap ${request.command} failed:`, err);
    }
    this.send({
      seq: this.nextSeq++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success,
    });
  }

  private settle(message: DapResponse): void {
    const waiting = this.pending.get(message.request_seq);
    if (!waiting) return;
    this.pending.delete(message.request_seq);
    window.clearTimeout(waiting.timer);
    if (message.success) waiting.resolve(message.body);
    else waiting.reject(new Error(message.message ?? `${message.command} failed`));
  }

  /** Fails everything in flight: a dead adapter must not hang the editor. */
  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiting] of this.pending) {
      window.clearTimeout(waiting.timer);
      waiting.reject(new Error("the debug session ended"));
    }
    this.pending.clear();
    this.unlisteners.forEach((unlisten) => {
      unlisten();
    });
    this.unlisteners.length = 0;
    this.handlers.onClosed();
  }
}
