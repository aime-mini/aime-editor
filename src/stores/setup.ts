/**
 * The agent closing a toolchain gap, in its own channel.
 *
 * Setting a machine up is not a conversation: it is a job with a progress log
 * and a Cancel button. Sending it into the chat panel — which is what Aime did
 * first — spends the user's session on it, buries their own thread, and leaves
 * nothing to press when the run turns out to take a quarter of an hour. Measured
 * on a real C# project: the setup turn installed `csharp-ls` and ran for **over
 * ten minutes**.
 *
 * So this store owns a second, parallel run. It needs no new backend command:
 * `ai_send_prompt` already returns a `run_id` per turn and the `ai:stream` /
 * `ai:exit` events carry it, so filtering on our own id is all it takes for the
 * two runs to ignore each other. `sessionId` is deliberately not passed — a
 * setup run must never resume, or continue, the user's conversation.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { translate } from "../i18n";
import { createEventParser, type EventParser } from "../lib/aiParsers";
import { buildSetupPrompt, type SetupRequest } from "../lib/aiSetup";
import { truncateDetail, type UiAiEvent } from "../lib/types";
import { useAi } from "./ai";
import { useDebug } from "./debug";
import { useLsp } from "./lsp";
import { useWorkspace } from "./workspace";

/** Mirrors the Rust payloads of `ai:stream` / `ai:exit` (providers/mod.rs). */
interface StreamPayload {
  run_id: string;
  event: unknown;
}

interface ExitPayload {
  run_id: string;
  code: number | null;
}

/** One entry in the progress log. */
export interface SetupLine {
  /** `note` is Aime speaking, `text` the agent, `tool` a command it ran. */
  kind: "note" | "text" | "tool" | "error";
  text: string;
}

interface SetupState {
  /** True from the moment the CLI is asked until it exits. */
  running: boolean;
  /** The language this run is for; kept after the run so the log still says so. */
  languageId: string | null;
  lines: SetupLine[];
  /** The CLI's exit code, or null while running and when cancelled. */
  exitCode: number | null;
  cancelled: boolean;
  /** Set when the run could not be started at all. */
  error: string | null;
  /** Whether the progress modal is on screen. */
  open: boolean;

  start: (request: SetupRequest) => Promise<void>;
  cancel: () => Promise<void>;
  close: () => void;
}

/** The run this store is listening for; also what Cancel needs. */
let runId: string | null = null;
/** Parsers can carry per-run state, so each run gets its own (ARCHITECTURE §4). */
let parser: EventParser = () => [];
/** The CLI's last word on stderr — the useful half of a non-zero exit. */
let lastStderrLine = "";
let listenersReady = false;

/**
 * Appends the agent's text to the log.
 *
 * Deltas arrive a few characters at a time, so they extend the trailing text
 * entry instead of each becoming a line of their own — a log of single words is
 * not a log.
 */
function appendText(lines: SetupLine[], text: string): SetupLine[] {
  const last = lines.at(-1);
  if (last?.kind === "text") {
    return [...lines.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...lines, { kind: "text", text }];
}

export const useSetup = create<SetupState>((set, get) => {
  const applyEvent = (event: UiAiEvent): void => {
    switch (event.kind) {
      case "message-delta":
        set((s) => ({ lines: appendText(s.lines, event.text) }));
        break;
      case "tool-call":
        set((s) => ({
          lines: [...s.lines, { kind: "tool", text: `${event.name} ${truncateDetail(event.detail)}`.trim() }],
        }));
        break;
      case "error":
        set((s) => ({ lines: [...s.lines, { kind: "error", text: event.message }] }));
        break;
      // A setup run has no cost line to show and no session to remember: the
      // proof it worked is the chip turning green, which `finish` takes care of.
      case "session-info":
      case "done":
        break;
    }
  };

  /** What the run leaves behind: a verdict, and a re-probe of what was installed. */
  const finish = (code: number | null): void => {
    const { languageId } = get();
    set({ running: false, exitCode: code, cancelled: code === null });
    runId = null;
    if (code !== 0 || languageId === null) {
      if (code !== null && code !== 0 && lastStderrLine) {
        set((s) => ({ lines: [...s.lines, { kind: "error", text: lastStderrLine }] }));
      }
      return;
    }
    // Whatever the agent installed, Aime has already decided this language was
    // unsupported and cached that answer. Both caches are dropped and asked
    // again here, which is what turns the chip green without a restart.
    useLsp.getState().forget(languageId);
    void useLsp.getState().ensure(languageId);
    void useDebug.getState().probeAdapter(languageId, { force: true });
  };

  const ensureListeners = async (): Promise<void> => {
    if (listenersReady) return;
    listenersReady = true;
    await listen<StreamPayload>("ai:stream", ({ payload }) => {
      if (payload.run_id !== runId) return;
      parser(payload.event).forEach(applyEvent);
    });
    await listen<ExitPayload>("ai:exit", ({ payload }) => {
      if (payload.run_id !== runId) return;
      finish(payload.code);
    });
    await listen<StreamPayload>("ai:stderr", ({ payload }) => {
      if (payload.run_id !== runId) return;
      if (typeof payload.event === "string" && payload.event.trim()) {
        lastStderrLine = payload.event.trim();
      }
    });
  };

  return {
    running: false,
    languageId: null,
    lines: [],
    exitCode: null,
    cancelled: false,
    error: null,
    open: false,

    start: async (request) => {
      // One machine, one agent installing on it: a second run would fight the
      // first over package managers and locks. The modal comes forward instead.
      if (get().running) {
        set({ open: true });
        return;
      }
      const { rootPath } = useWorkspace.getState();
      if (!rootPath) return;

      const ai = useAi.getState();
      const provider = ai.providers.find((candidate) => candidate.id === ai.providerId);
      parser = createEventParser({
        id: ai.providerId,
        parser: provider?.parser,
        textField: provider?.textField,
      });
      lastStderrLine = "";
      await ensureListeners();

      set({
        running: true,
        open: true,
        languageId: request.languageId,
        exitCode: null,
        cancelled: false,
        error: null,
        lines: [{ kind: "note", text: translate("setup.working", { language: request.languageId }) }],
      });
      try {
        runId = await invoke<string>("ai_send_prompt", {
          providerId: ai.providerId,
          prompt: buildSetupPrompt(request),
          cwd: rootPath,
          // No session id: this run must not join, resume or end up inside the
          // conversation the user is having.
          sessionId: null,
          options: { model: ai.model || null, effort: ai.effort || null, permission: ai.permission },
        });
      } catch (err: unknown) {
        runId = null;
        set({ running: false, error: String(err) });
      }
    },

    cancel: async () => {
      if (runId === null) return;
      // Cancelling kills the CLI, and the backend answers with `ai:exit` and no
      // exit code - which is exactly how `finish` tells cancelled from failed.
      await invoke("ai_cancel", { runId });
    },

    close: () => {
      set({ open: false });
    },
  };
});
