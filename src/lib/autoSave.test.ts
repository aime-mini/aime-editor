import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every write the store sends to Rust, in order. */
const writes: { path: string; content: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { path: string; content: string }) => {
    if (command === "write_file") writes.push({ path: args.path, content: args.content });
    if (command === "read_file") return Promise.resolve(`content of ${args.path}`);
    return Promise.resolve(undefined);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

const { useWorkspace } = await import("../stores/workspace");
const { useSettings } = await import("../stores/settings");
const { startAutoSave } = await import("./autoSave");

const A = "C:\\project\\a.ts";
const B = "C:\\project\\b.ts";

/** Long enough for the delay to pass, whatever it is set to. */
const PAST_THE_DELAY = 5_000;

let stop: () => void;

describe("auto save", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writes.length = 0;
    useSettings.setState({ autoSave: true });
    useWorkspace.setState({
      rootPath: "C:\\project",
      openTabs: [],
      buffers: {},
      openFilePath: null,
      fileContent: "",
      savedContent: "",
      dirty: false,
    });
    stop = startAutoSave();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("writes the file after the typing stops, and not before", async () => {
    await useWorkspace.getState().openFile(A);
    useWorkspace.getState().setContent("typed");

    await vi.advanceTimersByTimeAsync(100);
    expect(writes, "a keystroke must not reach the disk on its own").toEqual([]);

    await vi.advanceTimersByTimeAsync(PAST_THE_DELAY);
    expect(writes).toEqual([{ path: A, content: "typed" }]);
    expect(useWorkspace.getState().dirty).toBe(false);
  });

  it("writes once for a run of keystrokes, with the text as it ended up", async () => {
    await useWorkspace.getState().openFile(A);
    for (const text of ["t", "ty", "typ", "type"]) {
      useWorkspace.getState().setContent(text);
      await vi.advanceTimersByTimeAsync(200); // still typing
    }

    await vi.advanceTimersByTimeAsync(PAST_THE_DELAY);
    expect(writes).toEqual([{ path: A, content: "type" }]);
  });

  /**
   * The case that decides whether the timer belongs to the file or to the
   * screen: text typed in one tab, then another tab taken to the front before
   * the save fires. A timer that saved "the current file" would write the wrong
   * buffer and drop the work that armed it.
   */
  it("saves the file that was edited, even after another tab takes over", async () => {
    await useWorkspace.getState().openFile(A);
    useWorkspace.getState().setContent("work in A");
    await useWorkspace.getState().openFile(B);

    await vi.advanceTimersByTimeAsync(PAST_THE_DELAY);
    expect(writes).toEqual([{ path: A, content: "work in A" }]);
    // And the parked tab stops claiming to be unsaved, or its dot never clears.
    expect(useWorkspace.getState().buffers[A]?.savedContent).toBe("work in A");
  });

  it("does nothing at all while it is switched off", async () => {
    useSettings.setState({ autoSave: false });
    await useWorkspace.getState().openFile(A);
    useWorkspace.getState().setContent("typed");

    await vi.advanceTimersByTimeAsync(PAST_THE_DELAY);
    expect(writes).toEqual([]);
    expect(useWorkspace.getState().dirty).toBe(true);
  });

  it("drops a save that was armed before it was switched off", async () => {
    await useWorkspace.getState().openFile(A);
    useWorkspace.getState().setContent("typed");
    useSettings.setState({ autoSave: false });

    await vi.advanceTimersByTimeAsync(PAST_THE_DELAY);
    expect(writes).toEqual([]);
  });
});
