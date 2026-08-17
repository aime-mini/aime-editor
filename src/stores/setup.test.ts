import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the store asked the backend for, in order. */
const invoked: { command: string; args: Record<string, unknown> }[] = [];
/** The event handlers the store registered, so a test can play the backend. */
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown>) => {
    invoked.push({ command, args });
    return Promise.resolve(command === "ai_send_prompt" ? RUN_ID : null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => undefined);
  },
}));

const RUN_ID = "run-7";
const ROOT = "C:\\work\\repo";

const { useSetup } = await import("./setup");
const { useWorkspace } = await import("./workspace");
const { useDebug } = await import("./debug");
const { useLsp } = await import("./lsp");

const request = {
  languageId: "ruby",
  relativePath: "app/models/user.rb",
  serverCommand: "solargraph",
  serverInstallHint: "gem install solargraph",
  failedServer: null,
  missingDebugger: null,
  teachDebugger: false,
};

/** A line of Claude's JSONL, as `ai:stream` delivers it. */
function stream(runId: string, event: unknown): void {
  listeners.get("ai:stream")?.({ payload: { run_id: runId, event } });
}

function delta(text: string): unknown {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function exit(runId: string, code: number | null): void {
  listeners.get("ai:exit")?.({ payload: { run_id: runId, code } });
}

describe("useSetup", () => {
  beforeEach(() => {
    // Spying twice on the same store method hands back the first spy, calls and
    // all - so every case starts from the real functions.
    vi.restoreAllMocks();
    invoked.length = 0;
    useWorkspace.setState({ rootPath: ROOT });
    useSetup.setState({
      running: false,
      languageId: null,
      lines: [],
      exitCode: null,
      cancelled: false,
      error: null,
      open: false,
    });
  });

  it("runs in its own turn and never joins the user's conversation", async () => {
    await useSetup.getState().start(request);

    const sent = invoked.find((call) => call.command === "ai_send_prompt");
    expect(sent).toBeDefined();
    // The whole point of a second channel: no session id, so the CLI cannot
    // resume or continue the thread the user is having in the chat panel.
    expect(sent?.args.sessionId).toBeNull();
    expect(sent?.args.cwd).toBe(ROOT);
    expect(String(sent?.args.prompt)).toContain("solargraph");
    expect(useSetup.getState().running).toBe(true);
    expect(useSetup.getState().open).toBe(true);
  });

  it("ignores the output of every run but its own", async () => {
    await useSetup.getState().start(request);
    const before = useSetup.getState().lines.length;

    // The user's own chat turn, streaming at the same time.
    stream("run-other", delta("this belongs to the chat panel"));

    expect(useSetup.getState().lines).toHaveLength(before);
  });

  it("reads the agent's text as one block and its commands as their own lines", async () => {
    await useSetup.getState().start(request);
    stream(RUN_ID, delta("Installing "));
    stream(RUN_ID, delta("solargraph…"));
    stream(RUN_ID, {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "gem install solargraph" } }],
      },
    });

    const { lines } = useSetup.getState();
    // Deltas arrive a few characters at a time; a log of single words is useless.
    expect(lines.filter((line) => line.kind === "text")).toEqual([
      { kind: "text", text: "Installing solargraph…" },
    ]);
    expect(lines.at(-1)?.kind).toBe("tool");
    expect(lines.at(-1)?.text).toContain("gem install solargraph");
  });

  it("asks Aime to look again for what it was missing once the run succeeds", async () => {
    const forget = vi.spyOn(useLsp.getState(), "forget").mockImplementation(() => undefined);
    const ensure = vi.spyOn(useLsp.getState(), "ensure").mockResolvedValue(undefined);
    const probe = vi.spyOn(useDebug.getState(), "probeAdapter").mockResolvedValue(undefined);

    await useSetup.getState().start(request);
    exit(RUN_ID, 0);

    expect(useSetup.getState().running).toBe(false);
    expect(useSetup.getState().exitCode).toBe(0);
    // Both caches said "unsupported" before the install; keeping them is what
    // would leave the chip yellow until the app restarts.
    expect(forget).toHaveBeenCalledWith("ruby");
    expect(ensure).toHaveBeenCalledWith("ruby");
    expect(probe).toHaveBeenCalledWith("ruby", { force: true });
  });

  it("does not re-probe after a failure, and keeps the CLI's last word", async () => {
    const probe = vi.spyOn(useDebug.getState(), "probeAdapter").mockResolvedValue(undefined);

    await useSetup.getState().start(request);
    listeners.get("ai:stderr")?.({ payload: { run_id: RUN_ID, event: "Please run /login" } });
    exit(RUN_ID, 1);

    expect(probe).not.toHaveBeenCalled();
    expect(useSetup.getState().lines.at(-1)).toEqual({ kind: "error", text: "Please run /login" });
  });

  it("cancels the run it started, and calls that cancelled rather than failed", async () => {
    await useSetup.getState().start(request);
    await useSetup.getState().cancel();

    expect(invoked.at(-1)).toEqual({ command: "ai_cancel", args: { runId: RUN_ID } });
    // The backend answers a kill with no exit code at all, which is how the two
    // are told apart (providers/mod.rs).
    exit(RUN_ID, null);
    expect(useSetup.getState().cancelled).toBe(true);
    expect(useSetup.getState().running).toBe(false);
  });

  it("never starts a second agent on the same machine, and shows the first instead", async () => {
    await useSetup.getState().start(request);
    useSetup.getState().close();
    invoked.length = 0;

    await useSetup.getState().start({ ...request, languageId: "php" });

    expect(invoked).toHaveLength(0);
    expect(useSetup.getState().languageId).toBe("ruby");
    expect(useSetup.getState().open).toBe(true);
  });
});
