import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors the Rust payloads of `lsp:message` / `lsp:exit` (lsp/mod.rs). */
interface MessagePayload {
  serverId: number;
  message: string;
}

interface ExitPayload {
  serverId: number;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A request the server never answers must not leak a pending promise forever. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A minimal JSON-RPC 2.0 client for one language server.
 *
 * Deliberately hand-written rather than `monaco-languageclient`: that library
 * pulls in a VS Code compatibility layer far larger than this whole app, and
 * Aime needs six requests, not the entire protocol (ARCHITECTURE.md §5).
 */
export class LspClient {
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }
  >();
  private readonly unlisteners: UnlistenFn[] = [];
  private stopped = false;

  /**
   * Set by the owning session once it exists; until then a notification has
   * nowhere useful to go, so it is dropped rather than queued.
   */
  onNotification: (method: string, params: unknown) => void = () => undefined;

  private constructor(
    private readonly serverId: number,
    private readonly onExit: () => void,
  ) {}

  /** Spawns the server for a language and wires its event stream. */
  static async start(languageId: string, root: string, onExit: () => void): Promise<LspClient> {
    const serverId = await invoke<number>("lsp_start", { languageId, root });
    const client = new LspClient(serverId, onExit);
    client.unlisteners.push(
      await listen<MessagePayload>("lsp:message", ({ payload }) => {
        if (payload.serverId === serverId) client.receive(payload.message);
      }),
      await listen<ExitPayload>("lsp:exit", ({ payload }) => {
        if (payload.serverId === serverId) client.handleExit();
      }),
    );
    return client;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new Error(`${method}: language server stopped`));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: language server did not answer`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.stopped) this.send({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    this.handleExit();
    await invoke("lsp_stop", { serverId: this.serverId });
  }

  private send(message: unknown): void {
    void invoke("lsp_send", { serverId: this.serverId, message: JSON.stringify(message) }).catch(
      (err: unknown) => {
        console.error("lsp send failed:", err);
      },
    );
  }

  private receive(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return; // a malformed frame must not take the session down
    }

    if (message.id !== undefined && message.method === undefined) {
      this.settle(message);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      // Server-to-client request. Aime registers no dynamic capabilities and
      // holds no settings, but the server blocks until it gets an answer.
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "workspace/configuration" ? [null] : null,
      });
      return;
    }
    if (message.method) this.onNotification(message.method, message.params);
  }

  private settle(message: JsonRpcMessage): void {
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    window.clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  }

  /** Fails everything in flight; a crashed server must not hang the editor. */
  private handleExit(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [, waiting] of this.pending) {
      window.clearTimeout(waiting.timer);
      waiting.reject(new Error("language server stopped"));
    }
    this.pending.clear();
    this.unlisteners.forEach((unlisten) => {
      unlisten();
    });
    this.unlisteners.length = 0;
    this.onExit();
  }
}
