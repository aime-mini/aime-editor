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
/** What the next turn does: answer with text, or fail with an error. */
let next: { text: string } | { error: string } = { text: '{"tasks":[]}' };

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
    return "error" in next ? Promise.reject(new Error(next.error)) : Promise.resolve({ code: 0, ...next });
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
  // The background pass is its own test; everywhere else it stays out of the
  // way, which a CLI that is not installed does.
  useAi.setState({ providerHealth: "missing" });
  useWorkspace.setState({ rootPath: ROOT });
  useTasks.setState({ tasks: [], discovering: null, rejected: [] });
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
    expect(useTasks.getState().rejected.join(" ")).toContain("SomeCli");
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
