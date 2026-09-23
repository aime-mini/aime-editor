import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnOptions } from "../lib/agentTurn";
import type { AdapterAvailability } from "../lib/dap/availability";
import type { DebugTarget, TargetLaunchOptions } from "../lib/dap/targets";

/**
 * How a project builds the program F5 is about to run.
 *
 * Aime's built-in step per language is a rule about the ordinary shape of a
 * project, and a repository whose build unit is something else - a solution
 * that also builds the plugins copied next to the program - would otherwise
 * debug yesterday's code in silence. So the first run of each program reads the
 * repository, and these tests pin what that is allowed to cost and to believe.
 */

const ROOT = "C:\\repo";

const TARGET: DebugTarget = {
  id: "csharp:src/Web/Web.csproj",
  label: "src/Web/Web.csproj",
  languageId: "csharp",
  program: "C:\\repo\\src\\Web\\Web.csproj",
  cwd: "C:\\repo\\src\\Web",
};

const ADAPTER: AdapterAvailability = {
  adapterId: "netcoredbg",
  languageId: "csharp",
  configType: "coreclr",
  available: true,
  downloadable: true,
  buildsFirst: true,
  installHint: "",
  learned: false,
  verified: true,
  launchExtra: {},
  verifyWith: null,
  deviceField: null,
};

/** Every Tauri command called, in order, with its arguments. */
const calls: { command: string; args: Record<string, unknown> }[] = [];
/** What each one-shot AI question was, in order. */
const asked: string[] = [];
/** How each question was put to the CLI, in order. */
const turns: AgentTurnOptions[] = [];
/** The AI's replies, consumed one per question. */
let replies: string[] = [];
/** What `check_task_commands` says about the command it is handed. */
let programFound = true;
/** What `.aime/launch.json` holds, as the backend would answer. */
let stored: Partial<Record<string, TargetLaunchOptions>> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "dap_targets":
        return Promise.resolve([TARGET]);
      case "dap_launch_options":
        return Promise.resolve(stored);
      case "dap_availability":
        return Promise.resolve(ADAPTER);
      case "dap_set_launch_options":
        stored = { ...stored, [args.targetId as string]: args.options as TargetLaunchOptions };
        return Promise.resolve();
      case "check_task_commands":
        return Promise.resolve([{ program: "dotnet", programFound, folderFound: true }]);
      case "dap_program":
        return Promise.resolve("C:\\repo\\src\\Web\\bin\\Debug\\net9.0\\Web.dll");
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("../lib/agentTurn", () => ({
  agentTurn: (options: AgentTurnOptions) => {
    asked.push(options.prompt);
    turns.push(options);
    const reply = replies.shift();
    if (reply === undefined) return Promise.reject(new Error("the test scripted no reply for this question"));
    return Promise.resolve({ code: 0, text: reply });
  },
}));
// The session itself is another test's subject; here it only has to start.
vi.mock("../lib/dap/session", () => ({
  DebugSession: {
    launch: () => Promise.resolve({ stop: () => Promise.resolve(), setBreakpoints: () => Promise.resolve() }),
  },
}));

const { useDebug } = await import("./debug");
const { useWorkspace } = await import("./workspace");

/**
 * The console as one string, which is what a person reads - once it has
 * arrived: output reaches the store in batches, a moment after it was written.
 */
async function console_(): Promise<string> {
  const read = () =>
    useDebug
      .getState()
      .output.map((segment) => segment.text)
      .join("");
  await vi.waitFor(() => {
    expect(read()).not.toBe("");
  });
  return read();
}

beforeEach(() => {
  calls.length = 0;
  asked.length = 0;
  turns.length = 0;
  replies = [];
  programFound = true;
  stored = {};
  localStorage.clear();
  useWorkspace.setState({ rootPath: ROOT, openFilePath: null });
  useDebug.setState({
    targets: [],
    launchOptions: {},
    adapters: {},
    scanned: false,
    chosenTargetId: null,
    status: { kind: "idle" },
    output: [],
    breakpoints: {},
  });
});

describe("the build a project says it needs", () => {
  it("is read from the repository the first time a program is debugged", async () => {
    replies = ['{"command":"dotnet build src/Whole.sln","source":"src/Whole.sln"}'];
    await useDebug.getState().start();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("src/Web/Web.csproj");
    expect(stored[TARGET.id]?.build).toBe("dotnet build src/Whole.sln");
    // Said out loud: a run that quietly builds something other than what the
    // language usually builds would be worse than one that guessed wrong.
    expect(await console_()).toContain("dotnet build src/Whole.sln");
    expect(await console_()).toContain("src/Whole.sln");
  });

  it("is read once, not once per run", async () => {
    replies = ['{"command":"dotnet build src/Whole.sln","source":"src/Whole.sln"}'];
    await useDebug.getState().start();
    await useDebug.getState().stop();
    await useDebug.getState().start();

    expect(asked).toHaveLength(1);
  });

  it("is not asked for again when the answer was that the usual build fits", async () => {
    // Nothing is stored in that case, so only the marker keeps this from being
    // a question the project pays for on every single run.
    replies = ['{"command":""}'];
    await useDebug.getState().start();
    await useDebug.getState().stop();
    await useDebug.getState().start();

    expect(asked).toHaveLength(1);
    expect(stored[TARGET.id]).toBeUndefined();
  });

  it("is refused when the tool it names is not on this machine", async () => {
    programFound = false;
    replies = ['{"command":"gradle build","source":"build.gradle"}'];
    await useDebug.getState().start();

    expect(stored[TARGET.id]).toBeUndefined();
    expect(await console_()).toContain("gradle build");
  });

  it("is not asked for at all when the program needs no build", async () => {
    useDebug.setState({ adapters: { csharp: { ...ADAPTER, buildsFirst: false } } });
    await useDebug.getState().start();

    expect(asked).toHaveLength(0);
  });

  it("leaves a run alone when the question itself fails", async () => {
    replies = [];
    await useDebug.getState().start();

    // The AI is not a dependency of debugging: Aime's own build still runs.
    expect(calls.some((call) => call.command === "dap_program")).toBe(true);
    expect(stored[TARGET.id]).toBeUndefined();
    // Not marked as asked: a failure is not an answer, so the next run tries again.
    await useDebug.getState().stop();
    await useDebug.getState().start();
    expect(asked).toHaveLength(2);
  });

  it("is put to a CLI that can read the repository and nothing else", async () => {
    // A one-shot has no tools at all, so it answered for a repository it never
    // opened; a full agent could run the build it is only meant to name.
    replies = ['{"command":""}'];
    await useDebug.getState().start();

    expect(turns[0]).toMatchObject({ cwd: ROOT, permission: "readOnly", tools: "filesOnly" });
  });
});
