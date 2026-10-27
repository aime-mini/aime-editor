/**
 * The `aime` object a plugin sees, and the only thing it can reach.
 *
 * This source is a **string** rather than a module because it runs inside the
 * Worker, next to the plugin's own code, and the Worker is built from a Blob at
 * run time: there is no bundler step for something the user dropped into a
 * folder five seconds ago.
 *
 * What the Worker has: `postMessage`, and this. No DOM, no `window`, no Tauri
 * API, no `fetch` to Aime's own commands — everything goes through the host,
 * which checks the plugin's capabilities before doing anything (`protocol.ts`).
 */
import { MAX_CALLS_PER_SECOND } from "./protocol";

export const WORKER_BOOTSTRAP = `
"use strict";
(function () {
  let nextCall = 0;
  const pending = new Map();
  const commands = new Map();

  /**
   * The plugin's own calls, counted here because here is where they are sent.
   *
   * The host counts them too, but it can only count what already reached it -
   * see MAX_CALLS_PER_SECOND in protocol.ts for what that cost, measured. Two
   * deliberate choices: throwing, because the loop doing this is synchronous and
   * an exception is the only thing that can stop it; and reporting to the host
   * rather than acting, because ending a plugin and telling the user why is
   * Aime's job. Aime's own messages (ready, done, failed, and this report) are
   * not counted - there is at most one of each and they are how it learns what
   * happened.
   */
  const CEILING = ${String(MAX_CALLS_PER_SECOND)};
  let posted = 0;
  let windowStartedAt = Date.now();
  let reported = false;

  function speak(message) {
    const now = Date.now();
    if (now - windowStartedAt > 1000) {
      windowStartedAt = now;
      posted = 0;
    }
    posted += 1;
    if (posted > CEILING) {
      if (!reported) {
        reported = true;
        self.postMessage({ kind: "flooded" });
      }
      throw new Error("Aime stopped listening: more than " + CEILING + " calls in one second");
    }
    self.postMessage(message);
  }

  function call(method, params) {
    const id = ++nextCall;
    // Sent before the promise exists, so hitting the ceiling throws where the
    // plugin called from rather than becoming a rejection nobody handles.
    speak({ kind: "call", id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  const aime = {
    /** The version of this API, so a plugin can adapt instead of breaking. */
    apiVersion: 1,
    commands: {
      /** Adds a command to the palette. The handler may return a promise. */
      register(commandId, title, handler) {
        if (typeof commandId !== "string" || typeof handler !== "function") {
          throw new Error("aime.commands.register(id, title, handler)");
        }
        commands.set(commandId, handler);
        speak({ kind: "register", commandId, title: String(title ?? commandId) });
      },
    },
    editor: {
      /** The text of the file in front of the user. */
      getText: () => call("editor.getText"),
      /** What is selected, or "" when nothing is. */
      getSelection: () => call("editor.getSelection"),
      /** Replaces the whole file, as one undoable edit. */
      setText: (text) => call("editor.setText", { text: String(text) }),
      /** Replaces the selection, or inserts at the cursor. */
      replaceSelection: (text) => call("editor.replaceSelection", { text: String(text) }),
    },
    workspace: {
      /** Reads a file, relative to the project root. */
      readFile: (path) => call("workspace.readFile", { path: String(path) }),
      /** Writes a file, relative to the project root. */
      writeFile: (path, text) => call("workspace.writeFile", { path: String(path), text: String(text) }),
      /** The project's own folder name. */
      name: () => call("workspace.name"),
    },
    ui: {
      /** One line in the plugin's own log, which the user can open. */
      showMessage: (text) => call("ui.showMessage", { text: String(text) }),
    },
    log: (...parts) => {
      speak({ kind: "log", text: parts.map(String).join(" ") });
    },
  };
  self.aime = aime;

  self.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.kind === "answer") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (typeof message.error === "string") waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
      return;
    }

    if (message.kind === "run") {
      const handler = commands.get(message.commandId);
      if (!handler) {
        self.postMessage({ kind: "done", runId: message.runId });
        return;
      }
      // Errors are the plugin's, not Aime's: they are reported and the run ends.
      Promise.resolve()
        .then(() => handler(aime))
        .catch((err) => {
          self.postMessage({ kind: "log", text: "error: " + String(err && err.message ? err.message : err) });
        })
        .then(() => {
          self.postMessage({ kind: "done", runId: message.runId });
        });
    }
  };
})();
`;

/**
 * The whole Worker script: the API, then the plugin, then "ready".
 *
 * The plugin's code runs at the top level - registering commands there is the
 * documented way to be useful - and a syntax error in it is caught here rather
 * than becoming a silent Worker that never answers.
 */
export function workerSource(pluginSource: string): string {
  return [
    WORKER_BOOTSTRAP,
    "try {",
    pluginSource,
    '  self.postMessage({ kind: "ready" });',
    "} catch (err) {",
    '  self.postMessage({ kind: "failed", text: String(err && err.message ? err.message : err) });',
    "}",
  ].join("\n");
}
