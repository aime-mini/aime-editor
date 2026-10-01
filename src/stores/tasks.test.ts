import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnOptions } from "../lib/agentTurn";

/**
 * The AI reading a repository for the tasks Aime could not work out.
 *
 * The brief says "read this repository", so the one thing pinned here is that
 * the model is given a way to: a turn with file tools and nothing else. A
 * one-shot has no tools at all, and measured, it then answers from what it
 * knows about the stack rather than from the files.
 */

const ROOT = "C:\\repo";

/** Every Tauri command called, in order, with its arguments. */
const calls: { command: string; args: Record<string, unknown> }[] = [];
/** How each question was put to the CLI, in order. */
const turns: AgentTurnOptions[] = [];
/** What the next turns do, in order: answer with text, or fail with an error. The last one repeats. */
let replies: ({ text: string } | { error: string })[] = [{ text: '{"tasks":[]}' }];
let next: { text: string } | { error: string } = { text: '{"tasks":[]}' };
/** The exit code each command line gives when it is run for a trial; 0 when not named. */
let exitCodes: Record<string, number> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "detect_tasks":
        return Promise.resolve([]);
      case "task_profile_exists":
        return Promise.resolve(false);
      case "provider_health":
        return Promise.resolve({ installed: true, signedIn: true, loginCommand: null, apiKey: false });
      case "exec_run": {
        const code = exitCodes[args.command as string] ?? 0;
        return Promise.resolve({
          code,
          stdout: code === 0 ? "ok" : "1 test failed",
          stderr: "",
          durationMs: 5,
          timedOut: false,
          cancelled: false,
          clipped: false,
        });
      }
      case "check_task_commands":
        return Promise.resolve(
          (args.commands as string[]).map(() => ({ program: "mvn", programFound: true, folderFound: true })),
        );
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("../lib/agentTurn", () => ({
  agentTurn: (options: AgentTurnOptions) => {
    turns.push(options);
    const reply = replies.length > 0 ? (replies.shift() ?? next) : next;
    return "error" in reply ? Promise.reject(new Error(reply.error)) : Promise.resolve({ code: 0, ...reply });
  },
}));

const { useTasks } = await import("./tasks");
const { useWorkspace } = await import("./workspace");
const { useAi } = await import("./ai");

/** What `save_tasks` was handed, once per call. */
function saved(): unknown[] {
  return calls.filter((call) => call.command === "save_tasks").map((call) => call.args.tasks);
}

beforeEach(() => {
  calls.length = 0;
  turns.length = 0;
  next = { text: '{"tasks":[]}' };
  replies = [];
  exitCodes = {};
  // The background pass is its own test; everywhere else it stays out of the
  // way, which a CLI that is not installed does.
  useAi.setState({ providerHealth: "missing" });
  useWorkspace.setState({ rootPath: ROOT });
  useTasks.setState({ tasks: [], discovering: null, trying: null, notices: [] });
});

describe("reading a repository for its tasks", () => {
  it("is put to a CLI that can read the repository and nothing else", async () => {
    await useTasks.getState().profile("build");

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ cwd: ROOT, permission: "readOnly", tools: "filesOnly" });
  });

  it("stores a command that cites where it came from", async () => {
    next = {
      text: '{"tasks":[{"kind":"build","label":"mvn package","command":"mvn package","dir":".","source":"pom.xml"}]}',
    };
    await useTasks.getState().profile("build");

    expect(saved()).toHaveLength(1);
    expect(JSON.stringify(saved()[0])).toContain("mvn package");
  });

  it("stores nothing, and says why, when the CLI cannot be held to reading files", async () => {
    // Stamping the profile here would make "never read" look like "read and
    // found nothing", and the project would not be asked again.
    next = { error: "TOOLS_UNRESTRICTED::SomeCli" };
    await useTasks.getState().profile("build");

    expect(saved()).toHaveLength(0);
    expect(useTasks.getState().notices.join(" ")).toContain("SomeCli");
    expect(useTasks.getState().discovering).toBeNull();
  });

  it("happens by itself when a project is opened, before the AI panel has probed the CLI", async () => {
    // The order a real window runs in: the project opens first, and the panel
    // that checks the CLI mounts after it - so the pass sees "unknown".
    useWorkspace.setState({ rootPath: null });
    useAi.setState({ providerHealth: "unknown" });
    useWorkspace.setState({ rootPath: ROOT });

    await vi.waitFor(() => {
      expect(turns).toHaveLength(1);
    });
    expect(calls.some((call) => call.command === "provider_health")).toBe(true);
  });
});

/** The command lines run for a trial, in order. */
function trialled(): string[] {
  return calls.filter((call) => call.command === "exec_run").map((call) => call.args.command as string);
}

const answer = (...tasks: { kind: string; command: string }[]) => ({
  text: JSON.stringify({
    tasks: tasks.map((task) => ({ ...task, label: task.command, dir: ".", source: "package.json" })),
  }),
});

describe("trying a proposed command before it is saved", () => {
  it("runs a build, a check and a test, and never a run or a publish", async () => {
    next = answer(
      { kind: "build", command: "npm run build" },
      { kind: "test", command: "npm test" },
      { kind: "run", command: "npm run dev" },
      { kind: "publish", command: "npm publish" },
    );
    await useTasks.getState().profile("build");

    expect(trialled()).toEqual(["npm run build", "npm test"]);
    expect(JSON.stringify(saved()[0])).toContain("npm publish");
  });

  it("asks again about a command that failed, and saves the corrected one once it runs", async () => {
    replies = [
      answer({ kind: "build", command: "npm run bulid" }),
      answer({ kind: "build", command: "npm run build" }),
    ];
    exitCodes = { "npm run bulid": 1 };
    await useTasks.getState().profile("build");

    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toContain("npm run bulid");
    expect(turns[1].prompt).toContain("1 test failed");
    expect(trialled()).toEqual(["npm run bulid", "npm run build"]);
    expect(JSON.stringify(saved()[0])).toContain("npm run build");
    expect(JSON.stringify(saved()[0])).not.toContain("bulid");
  });

  it("keeps a command the AI stands by, and says it fails here", async () => {
    // A red test suite is the project's, not the command's: the Test button stays.
    replies = [answer({ kind: "test", command: "npm test" }), answer({ kind: "test", command: "npm test" })];
    exitCodes = { "npm test": 1 };
    await useTasks.getState().profile("test");

    expect(JSON.stringify(saved()[0])).toContain("npm test");
    expect(useTasks.getState().notices.join(" ")).toContain("1 test failed");
  });

  it("saves nothing for a command that fails again after it was corrected", async () => {
    replies = [answer({ kind: "build", command: "make" }), answer({ kind: "build", command: "make all" })];
    exitCodes = { make: 2, "make all": 2 };
    await useTasks.getState().profile("build");

    expect(saved()).toHaveLength(0);
    expect(useTasks.getState().notices.join(" ")).toContain("`make all` ran here and failed");
  });
});
