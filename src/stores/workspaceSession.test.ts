import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../lib/workspaceSession";

/** The app data folder, as the Rust store would hold it: one snapshot per root. */
const stored = new Map<string, unknown>();
/** The disk, as `read_file` would see it. */
const disk = new Map<string, string>();
/** Every command the module sent, in order. */
const sent: string[] = [];
/** Held open by a test that needs the read of a snapshot to be slow. */
let loadGate: Promise<void> = Promise.resolve();
const closingHandlers: (() => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    sent.push(command);
    switch (command) {
      case "load_workspace_state":
        await loadGate;
        return stored.get(args.rootPath as string) ?? null;
      case "save_workspace_state":
        stored.set(args.rootPath as string, structuredClone(args.state));
        return null;
      case "read_file": {
        const text = disk.get(args.path as string);
        if (text === undefined) throw new Error(`no such file: ${String(args.path)}`);
        return text;
      }
      default:
        return null;
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: () => void) => {
    if (event === "window:closing") closingHandlers.push(handler);
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

const { useWorkspace } = await import("./workspace");
const { flushWorkspaceSession, rememberView, takeUnseenView } = await import("./workspaceSession");

const ROOT = "C:\\shop";
const OTHER = "C:\\blog";
const CART = "C:\\shop\\cart.ts";
const PRICE = "C:\\shop\\price.ts";

const snapshotOf = (root: string) => stored.get(root) as WorkspaceSnapshot | undefined;

/** Lets every pending promise - reads, writes, the restore itself - run to the end. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

async function openFolder(root: string): Promise<void> {
  await useWorkspace.getState().adoptFolder(root);
  await settle();
}

/** Past the save delay, and everything the save set off. */
async function afterTheSaveDelay(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
  await settle();
}

describe("a workspace reopened the way it was left", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Closed first: leaving the last test's folder writes its snapshot, which
    // is exactly what the module should do and nothing this test should see.
    useWorkspace.getState().closeFolder();
    await settle();
    stored.clear();
    disk.clear();
    sent.length = 0;
    loadGate = Promise.resolve();
    disk.set(CART, "export const cart = [];\n");
    disk.set(PRICE, "export const price = 1;\n");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the tabs, the file in front and the unsaved text a moment after they change", async () => {
    await openFolder(ROOT);
    await useWorkspace.getState().openFile(CART);
    await useWorkspace.getState().openFile(PRICE);
    useWorkspace.getState().setContent("export const price = 2;\n");
    await afterTheSaveDelay();

    const snapshot = snapshotOf(ROOT);
    expect(snapshot?.tabs).toEqual([CART, PRICE]);
    expect(snapshot?.active).toBe(PRICE);
    expect(snapshot?.unsaved).toEqual({
      [PRICE]: { content: "export const price = 2;\n", savedContent: "export const price = 1;\n" },
    });
  });

  it("puts all of it back when the folder is opened again", async () => {
    await openFolder(ROOT);
    await useWorkspace.getState().openFile(CART);
    await useWorkspace.getState().openFile(PRICE);
    useWorkspace.getState().setContent("export const price = 2;\n");
    rememberView(PRICE, { cursorState: [{ position: { lineNumber: 1, column: 20 } }] });
    useWorkspace.getState().closeFolder();
    await settle();

    await openFolder(ROOT);
    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([CART, PRICE]);
    expect(state.openFilePath).toBe(PRICE);
    expect([state.fileContent, state.dirty]).toEqual(["export const price = 2;\n", true]);
    expect(takeUnseenView(PRICE)).toEqual({ cursorState: [{ position: { lineNumber: 1, column: 20 } }] });
    expect(takeUnseenView(PRICE)).toBeUndefined(); // once: after that Monaco keeps its own
  });

  it("writes nothing for a folder until its own snapshot has been read", async () => {
    stored.set(ROOT, {
      version: 1,
      tabs: [CART],
      active: CART,
      cloudOpen: false,
      unsaved: {},
      views: {},
      expanded: [],
      sidebarView: "files",
    } satisfies WorkspaceSnapshot);
    let openGate: () => void = () => undefined;
    loadGate = new Promise((resolve) => {
      openGate = resolve;
    });

    await useWorkspace.getState().adoptFolder(ROOT);
    // The empty editor the folder opens with, left to be saved while the read is slow.
    useWorkspace.getState().setDirExpanded("C:\\shop\\src", true);
    await afterTheSaveDelay();
    expect(sent).not.toContain("save_workspace_state");
    expect(snapshotOf(ROOT)?.tabs).toEqual([CART]);

    openGate();
    await settle();
    expect(useWorkspace.getState().openTabs).toEqual([CART]);
  });

  it("writes the folder being left as it stood, before the next one is read", async () => {
    await openFolder(ROOT);
    await useWorkspace.getState().openFile(CART);
    // No time for the delayed save: the switch itself has to write it.
    await openFolder(OTHER);
    expect(snapshotOf(ROOT)?.tabs).toEqual([CART]);
    expect(useWorkspace.getState().openTabs).toEqual([]);
  });

  it("drops a tab whose file is gone, and keeps the one with unsaved text in it", async () => {
    await openFolder(ROOT);
    await useWorkspace.getState().openFile(CART);
    await useWorkspace.getState().openFile(PRICE);
    useWorkspace.getState().setContent("unsaved price");
    useWorkspace.getState().closeFolder();
    await settle();
    disk.clear();

    await openFolder(ROOT);
    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([PRICE]);
    expect(state.fileContent).toBe("unsaved price");
    expect(state.diskNotices[PRICE]).toBe("missing");
  });

  it("writes what it holds when the window closes, and only then lets it go", async () => {
    await openFolder(ROOT);
    await useWorkspace.getState().openFile(CART);
    useWorkspace.getState().setContent("typed a moment before Alt+F4");
    sent.length = 0;
    for (const handler of closingHandlers) handler();
    await settle();

    expect(sent).toEqual(["save_workspace_state", "window_flushed"]);
    expect(snapshotOf(ROOT)?.unsaved[CART]?.content).toBe("typed a moment before Alt+F4");
  });

  it("has nothing to write for a window with no folder, and still lets it go", async () => {
    sent.length = 0;
    await flushWorkspaceSession();
    for (const handler of closingHandlers) handler();
    await settle();
    expect(sent).toEqual(["window_flushed"]);
  });
});
