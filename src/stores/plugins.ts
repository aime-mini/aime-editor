/**
 * Running the plugins the user installed, without letting one of them cost the
 * editor.
 *
 * Every guard here exists because of an ordinary mistake rather than an attack.
 * A plugin is somebody's fifty lines of JavaScript; it will have a `while (true)`
 * in it one day, and a loop that posts a message per iteration the day after.
 *
 * - **A Worker per plugin.** A spin loop burns one core and the window keeps
 *   painting. This is the whole reason the API is message-passing.
 * - **Deadlines.** Activation and each command have one. Past it the plugin is
 *   terminated and named, rather than left to be a mystery.
 * - **A rate limit.** Past `MAX_CALLS_PER_SECOND` the plugin is terminated: a
 *   runaway loop calling into the host would otherwise grow this store forever.
 * - **A bounded log.** `MAX_LOG_LINES`, oldest dropped, so output cannot fill
 *   memory either.
 * - **Nothing implicit.** Capabilities are checked per call on this side
 *   (`protocol.ts`), and a plugin folder is never read from the project.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { translate } from "../i18n";
import { activeEditor } from "../lib/monacoAccess";
import {
  ACTIVATION_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  MAX_CALLS_PER_SECOND,
  MAX_LOG_LINES,
  isFromPlugin,
  refusalFor,
  type FromPlugin,
  type ToPlugin,
} from "../lib/plugins/protocol";
import { workerSource } from "../lib/plugins/worker";
import { useLayout } from "./layout";
import { useWorkspace } from "./workspace";

/** Mirror of the Rust `PluginManifest` (plugins.rs). */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  main: string;
  capabilities: string[];
  apiVersion: number;
}

/** Mirror of the Rust `InstalledPlugin`. */
export interface InstalledPlugin {
  manifest: PluginManifest;
  dir: string;
  /** Why Aime will not run it; null when it is fine. */
  problem: string | null;
}

/** A command a running plugin contributed to the palette. */
export interface PluginCommand {
  pluginId: string;
  commandId: string;
  title: string;
}

/** What a plugin is doing right now. */
export type PluginState =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "running" }
  /** Terminated by Aime, with the reason a user can act on. */
  | { kind: "stopped"; reason: string };

/** One plugin's Worker and the bookkeeping that keeps it honest. */
interface Live {
  worker: Worker;
  /** Calls seen in the current second, for the rate limit. */
  calls: number;
  windowStartedAt: number;
  /** Timers to clear when the plugin goes away. */
  timers: number[];
}

const live = new Map<string, Live>();
/** Command runs waiting for a `done`, so a hung command can be reported. */
const runs = new Map<number, { resolve: () => void; timer: number }>();
let nextRunId = 0;

const ENABLED_KEY = "aime.plugins.enabled";

function loadEnabled(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ENABLED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface PluginsState {
  installed: InstalledPlugin[];
  /** Ids the user switched on. A plugin is never run just for being present. */
  enabled: string[];
  states: Record<string, PluginState | undefined>;
  commands: PluginCommand[];
  /** Output, newest last, capped at `MAX_LOG_LINES`. */
  log: { pluginId: string; text: string }[];

  refresh: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  runCommand: (pluginId: string, commandId: string) => Promise<void>;
  /** Ends a plugin now - the button next to a plugin that is misbehaving. */
  stop: (id: string, reason: string) => void;
  /** Starts a plugin that was stopped, without making the user untick it first. */
  restart: (id: string) => Promise<void>;
  clearLog: () => void;
  openFolder: () => Promise<string>;
}

export const usePlugins = create<PluginsState>((set, get) => {
  const append = (pluginId: string, text: string): void => {
    set((s) => ({ log: [...s.log, { pluginId, text }].slice(-MAX_LOG_LINES) }));
  };

  const stop = (id: string, reason: string): void => {
    const running = live.get(id);
    if (running) {
      running.timers.forEach((timer) => {
        window.clearTimeout(timer);
      });
      // Stop listening before terminating. Whatever the plugin posted before Aime
      // noticed is already queued on this side, and draining a backlog for a
      // plugin that no longer exists is work the window pays for nothing - the
      // Worker's own ceiling keeps that backlog short, this makes it free.
      running.worker.onmessage = null;
      running.worker.onerror = null;
      running.worker.terminate();
      live.delete(id);
    }
    set((s) => ({
      states: { ...s.states, [id]: { kind: "stopped", reason } },
      commands: s.commands.filter((command) => command.pluginId !== id),
    }));
    if (reason !== "") append(id, reason);
  };

  /** Does what a plugin asked for, if it is allowed to ask. */
  const handleCall = async (pluginId: string, method: string, params: unknown): Promise<unknown> => {
    const plugin = get().installed.find((candidate) => candidate.manifest.id === pluginId);
    const refusal = refusalFor(method, plugin?.manifest.capabilities ?? []);
    if (refusal !== null) throw new Error(refusal);

    const { rootPath, fileContent, setContent } = useWorkspace.getState();
    // Read as strings and nothing else: a plugin that sends an object gets an
    // empty string rather than "[object Object]" written into a file.
    const field = (name: "text" | "path"): string => {
      const value = (params as Record<string, unknown> | undefined)?.[name];
      return typeof value === "string" ? value : "";
    };
    const asText = (): string => field("text");
    const asPath = (): string => field("path");

    switch (method) {
      case "editor.getText":
        return fileContent;

      case "editor.getSelection": {
        const editor = activeEditor();
        const selection = editor?.getSelection();
        return selection && editor ? (editor.getModel()?.getValueInRange(selection) ?? "") : "";
      }

      case "editor.setText": {
        const editor = activeEditor();
        const model = editor?.getModel();
        if (editor && model) {
          // Through Monaco, so Ctrl+Z takes it back: a plugin whose work cannot
          // be undone is a plugin nobody dares run.
          editor.executeEdits("plugin", [{ range: model.getFullModelRange(), text: asText() }]);
        } else {
          setContent(asText());
        }
        return null;
      }

      case "editor.replaceSelection": {
        const editor = activeEditor();
        const selection = editor?.getSelection();
        if (!editor || !selection) throw new Error("no editor is open");
        editor.executeEdits("plugin", [{ range: selection, text: asText() }]);
        return null;
      }

      case "workspace.name":
        return rootPath === null ? "" : (rootPath.split(/[\\/]/).pop() ?? "");

      case "workspace.readFile": {
        if (rootPath === null) throw new Error("no project is open");
        return await invoke<string>("read_file", { path: `${rootPath}/${asPath()}` });
      }

      case "workspace.writeFile": {
        if (rootPath === null) throw new Error("no project is open");
        await invoke("write_file", { path: `${rootPath}/${asPath()}`, content: asText() });
        return null;
      }

      case "ui.showMessage":
        append(pluginId, asText());
        // Brought forward the same way a debug run brings its console forward: a
        // message nobody can see is not a message.
        useLayout.getState().showPluginOutput();
        return null;

      default:
        throw new Error(`${method} is not part of the plugin API`);
    }
  };

  const onMessage = (pluginId: string, raw: unknown): void => {
    if (!isFromPlugin(raw)) return;
    const message: FromPlugin = raw;
    const running = live.get(pluginId);
    if (!running) return;

    // The Worker hit the same limit on the side where the calls are sent, which
    // is the side that can see them all. Handled before the count below because
    // this is a report, not a call: what the user reads is Aime's to say.
    if (message.kind === "flooded") {
      stop(pluginId, translate("plugins.runaway", { limit: String(MAX_CALLS_PER_SECOND) }));
      return;
    }

    // The same limit again, on what actually arrived: a Worker whose bootstrap a
    // plugin has overwritten still cannot talk its way past this one.
    const now = Date.now();
    if (now - running.windowStartedAt > 1_000) {
      running.windowStartedAt = now;
      running.calls = 0;
    }
    running.calls += 1;
    if (running.calls > MAX_CALLS_PER_SECOND) {
      stop(pluginId, translate("plugins.runaway", { limit: String(MAX_CALLS_PER_SECOND) }));
      return;
    }

    const post = (message: ToPlugin): void => {
      running.worker.postMessage(message);
    };

    switch (message.kind) {
      case "register":
        set((s) => ({
          commands: [
            ...s.commands.filter(
              (command) => !(command.pluginId === pluginId && command.commandId === message.commandId),
            ),
            { pluginId, commandId: message.commandId, title: message.title },
          ],
        }));
        break;

      case "ready":
        set((s) => ({ states: { ...s.states, [pluginId]: { kind: "running" } } }));
        break;

      case "failed":
        stop(pluginId, message.text);
        break;

      case "log":
        append(pluginId, message.text);
        break;

      case "done": {
        const waiting = runs.get(message.runId);
        if (!waiting) break;
        window.clearTimeout(waiting.timer);
        runs.delete(message.runId);
        waiting.resolve();
        break;
      }

      case "call":
        void handleCall(pluginId, message.method, message.params).then(
          (result) => {
            post({ kind: "answer", id: message.id, result });
          },
          (err: unknown) => {
            post({ kind: "answer", id: message.id, error: err instanceof Error ? err.message : String(err) });
          },
        );
        break;
    }
  };

  const start = async (plugin: InstalledPlugin): Promise<void> => {
    const id = plugin.manifest.id;
    stop(id, "");
    if (plugin.problem !== null) {
      set((s) => ({ states: { ...s.states, [id]: { kind: "stopped", reason: plugin.problem ?? "" } } }));
      return;
    }
    set((s) => ({ states: { ...s.states, [id]: { kind: "starting" } } }));
    try {
      const source = await invoke<string>("plugin_source", { id });
      const blob = new Blob([workerSource(source)], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      // The URL is only needed to construct the Worker; keeping it would leak.
      URL.revokeObjectURL(url);

      const deadline = window.setTimeout(() => {
        if (get().states[id]?.kind === "starting") {
          stop(id, translate("plugins.slowStart", { seconds: String(ACTIVATION_TIMEOUT_MS / 1000) }));
        }
      }, ACTIVATION_TIMEOUT_MS);

      live.set(id, { worker, calls: 0, windowStartedAt: Date.now(), timers: [deadline] });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        onMessage(id, event.data);
      };
      worker.onerror = (event) => {
        stop(id, event.message || "the plugin crashed");
      };
    } catch (err: unknown) {
      set((s) => ({
        states: {
          ...s.states,
          [id]: { kind: "stopped", reason: err instanceof Error ? err.message : String(err) },
        },
      }));
    }
  };

  return {
    installed: [],
    enabled: loadEnabled(),
    states: {},
    commands: [],
    log: [],

    refresh: async () => {
      const installed = await invoke<InstalledPlugin[]>("plugin_list");
      set({ installed });
      // Only what the user switched on runs, and a plugin that vanished stops.
      const enabled = get().enabled;
      for (const id of [...live.keys()]) {
        if (!enabled.includes(id) || !installed.some((plugin) => plugin.manifest.id === id)) {
          stop(id, "");
          set((s) => ({ states: { ...s.states, [id]: { kind: "off" } } }));
        }
      }
      await Promise.all(
        installed
          .filter((plugin) => {
            const id = plugin.manifest.id;
            if (!enabled.includes(id) || live.has(id)) return false;
            // A plugin Aime stopped *and said why* stays stopped until the user
            // asks for it again: restarting a runaway just because Settings was
            // opened would undo the protection and hide the reason.
            const state = get().states[id];
            return !(state?.kind === "stopped" && state.reason !== "");
          })
          .map((plugin) => start(plugin)),
      );
    },

    setEnabled: async (id, enabled) => {
      const ids = enabled
        ? [...new Set([...get().enabled, id])]
        : get().enabled.filter((kept) => kept !== id);
      set({ enabled: ids });
      localStorage.setItem(ENABLED_KEY, JSON.stringify(ids));
      if (!enabled) {
        stop(id, "");
        set((s) => ({ states: { ...s.states, [id]: { kind: "off" } } }));
        return;
      }
      const plugin = get().installed.find((candidate) => candidate.manifest.id === id);
      if (plugin) await start(plugin);
    },

    runCommand: async (pluginId, commandId) => {
      const running = live.get(pluginId);
      if (!running) throw new Error(translate("plugins.notRunning"));
      const runId = ++nextRunId;
      await new Promise<void>((resolve) => {
        // A command that never returns is a plugin to stop, not a spinner to
        // leave on screen for ever. The `done` message settles this promise
        // through the one message handler - wrapping `onmessage` per run would
        // stack a wrapper per command and never unwrap.
        const timer = window.setTimeout(() => {
          runs.delete(runId);
          stop(pluginId, translate("plugins.slowCommand", { seconds: String(COMMAND_TIMEOUT_MS / 1000) }));
          resolve();
        }, COMMAND_TIMEOUT_MS);
        runs.set(runId, { resolve, timer });
        running.worker.postMessage({ kind: "run", runId, commandId } satisfies ToPlugin);
      });
    },

    stop,

    restart: async (id) => {
      const plugin = get().installed.find((candidate) => candidate.manifest.id === id);
      if (plugin) await start(plugin);
    },

    clearLog: () => {
      set({ log: [] });
    },

    openFolder: () => invoke<string>("plugins_folder"),
  };
});
