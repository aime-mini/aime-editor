import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  capabilityFor,
  isFromPlugin,
  MAX_CALLS_PER_SECOND,
  MAX_LOG_LINES,
  refusalFor,
  type FromPlugin,
} from "./protocol";
import { workerSource } from "./worker";

/** The half of the API the tests below drive directly. */
interface PluginScope {
  postMessage: (message: FromPlugin) => void;
  onmessage?: unknown;
  aime?: {
    log: (...parts: unknown[]) => void;
    ui: { showMessage: (text: string) => Promise<unknown> };
  };
}

/**
 * Runs the Worker bootstrap in a context of its own, with a `self` we can watch.
 *
 * Its source is a string because it runs next to plugin code inside a Worker
 * built at run time, so the only honest way to test its rules is to execute it.
 * There is no Worker in this process, but the source touches nothing except
 * `self` - which is why the plugin's own code is left out here and the API is
 * reached through `scope.aime` rather than the global a real Worker would have.
 */
function bootWorker(): { posted: FromPlugin[]; scope: PluginScope } {
  const posted: FromPlugin[] = [];
  const scope: PluginScope = {
    postMessage: (message) => {
      posted.push(message);
    },
  };
  runInNewContext(workerSource(""), { self: scope });
  return { posted, scope };
}

describe("capabilities", () => {
  it("maps each area of the API to the capability it needs", () => {
    expect(capabilityFor("editor.setText")).toBe("editor");
    expect(capabilityFor("workspace.readFile")).toBe("files");
    expect(capabilityFor("ui.showMessage")).toBe("ui");
  });

  it("asks nothing for registering a command, which is how a plugin is useful", () => {
    expect(capabilityFor("commands.register")).toBeNull();
    expect(refusalFor("commands.register", [])).toBeNull();
  });

  it("refuses a call the plugin never asked to be allowed to make", () => {
    const refusal = refusalFor("workspace.writeFile", ["editor"]);
    expect(refusal).toContain("files");
    // The refusal names the method, so the plugin's author knows what to declare.
    expect(refusal).toContain("workspace.writeFile");
  });

  it("allows a call the plugin declared", () => {
    expect(refusalFor("workspace.writeFile", ["editor", "files"])).toBeNull();
  });

  it("knows exactly the capabilities the backend knows", () => {
    // `plugins.rs::KNOWN_CAPABILITIES` holds the same three; a mismatch would let
    // a manifest pass validation and then have every call refused.
    expect([...CAPABILITIES]).toEqual(["editor", "files", "ui"]);
  });
});

describe("guards against a plugin that misbehaves by accident", () => {
  it("keeps the limits small enough to matter", () => {
    // A loop calling into the host is a loop; a plugin doing work is not.
    expect(MAX_CALLS_PER_SECOND).toBeLessThanOrEqual(200);
    expect(MAX_LOG_LINES).toBeLessThanOrEqual(1000);
  });

  it("ignores a message shape it does not understand", () => {
    expect(isFromPlugin({ kind: "call", id: 1, method: "editor.getText" })).toBe(true);
    expect(isFromPlugin({ kind: "eval", code: "1" })).toBe(false);
    expect(isFromPlugin(null)).toBe(false);
    expect(isFromPlugin("register")).toBe(false);
  });
});

describe("the limit counted where the calls are sent", () => {
  it("cuts a synchronous flood off at the limit instead of posting all of it", () => {
    const { posted, scope } = bootWorker();
    const aime = scope.aime;
    expect(aime).toBeDefined();
    if (!aime) return;

    // Exactly the shape of the fixture that found this: a `for` loop calling into
    // Aime and never awaiting. The throw is what stops the loop - a synchronous
    // one cannot be stopped from the outside, and a hundred thousand queued
    // messages took the host 23 s to notice.
    expect(() => {
      for (let n = 0; n < 100_000; n += 1) void aime.ui.showMessage(`flood ${String(n)}`);
    }).toThrow(/stopped listening/);

    expect(posted.filter((message) => message.kind === "call")).toHaveLength(MAX_CALLS_PER_SECOND);
    // The host is told, once, and decides what happens - the Worker never names
    // the reason a user will read.
    expect(posted.filter((message) => message.kind === "flooded")).toHaveLength(1);
    // "ready" is Aime's own message, not one of the plugin's calls, so it is not
    // counted: a plugin at its limit must still be able to report what happened.
    expect(posted.some((message) => message.kind === "ready")).toBe(true);
  });

  it("counts log lines against the same limit", () => {
    const { posted, scope } = bootWorker();
    const aime = scope.aime;
    expect(aime).toBeDefined();
    if (!aime) return;

    expect(() => {
      for (let n = 0; n < MAX_CALLS_PER_SECOND + 1; n += 1) aime.log("chatty");
    }).toThrow(/stopped listening/);
    expect(posted.filter((message) => message.kind === "log")).toHaveLength(MAX_CALLS_PER_SECOND);
  });

  it("keeps refusing without reporting the same plugin twice", () => {
    const { posted, scope } = bootWorker();
    const aime = scope.aime;
    expect(aime).toBeDefined();
    if (!aime) return;

    for (let n = 0; n < MAX_CALLS_PER_SECOND; n += 1) aime.log("filling the second");
    expect(() => {
      aime.log("over");
    }).toThrow(/stopped listening/);
    expect(() => {
      aime.log("still over");
    }).toThrow(/stopped listening/);
    // One report: the host stops the plugin on the first, and the rest of a loop
    // must not queue a message per iteration all over again.
    expect(posted.filter((message) => message.kind === "flooded")).toHaveLength(1);
  });
});

describe("workerSource", () => {
  it("gives the plugin the API and nothing else", () => {
    const source = workerSource("aime.log('hi')");
    expect(source).toContain("self.aime = aime");
    expect(source).toContain("aime.log('hi')");
    // A syntax error in the plugin must be reported, not turn into a Worker that
    // never answers.
    expect(source).toContain('kind: "failed"');
    expect(source).toContain('kind: "ready"');
  });
});
