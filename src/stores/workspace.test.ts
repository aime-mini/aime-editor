import { beforeEach, describe, expect, it, vi } from "vitest";

/** The store talks to Tauri; the tab logic under test does not. */
const readFile = vi.fn<(command: string, args: { path: string }) => Promise<string>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { path: string }) =>
    command === "read_file" ? readFile(command, args) : Promise.resolve(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

const { useWorkspace } = await import("./workspace");

const A = "C:\\project\\src\\a.ts";
const B = "C:\\project\\src\\b.ts";
const C = "C:\\project\\docs\\c.md";

/** Each file reads back its own name, so a mixed-up buffer is obvious. */
readFile.mockImplementation((_command, { path }) => Promise.resolve(`content of ${path}`));

async function openAll(...paths: string[]) {
  for (const path of paths) await useWorkspace.getState().openFile(path);
}

describe("editor tabs", () => {
  beforeEach(() => {
    useWorkspace.setState({
      rootPath: "C:\\project",
      openTabs: [],
      buffers: {},
      openFilePath: null,
      fileContent: "",
      savedContent: "",
      dirty: false,
    });
  });

  it("opens each file in its own tab and shows the newest", async () => {
    await openAll(A, B);
    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([A, B]);
    expect(state.openFilePath).toBe(B);
    expect(state.fileContent).toBe(`content of ${B}`);
  });

  it("keeps unsaved text when switching away and back", async () => {
    await openAll(A, B);
    useWorkspace.getState().activateTab(A);
    useWorkspace.getState().setContent("half-written thought");
    expect(useWorkspace.getState().dirty).toBe(true);

    useWorkspace.getState().activateTab(B);
    expect(useWorkspace.getState().fileContent).toBe(`content of ${B}`);
    expect(useWorkspace.getState().dirty).toBe(false);

    useWorkspace.getState().activateTab(A);
    expect(useWorkspace.getState().fileContent).toBe("half-written thought");
    expect(useWorkspace.getState().dirty).toBe(true);
  });

  it("reopening an already open file switches to it instead of re-reading", async () => {
    await openAll(A, B);
    useWorkspace.getState().activateTab(A);
    useWorkspace.getState().setContent("edited");
    readFile.mockClear();

    await useWorkspace.getState().openFile(A);
    expect(readFile).not.toHaveBeenCalled();
    expect(useWorkspace.getState().fileContent).toBe("edited");
    expect(useWorkspace.getState().openTabs).toEqual([A, B]);
  });

  it("closing the active tab shows the one that took its place", async () => {
    await openAll(A, B, C);
    useWorkspace.getState().activateTab(B);
    useWorkspace.getState().closeTab(B);

    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([A, C]);
    expect(state.openFilePath).toBe(C);
    expect(state.fileContent).toBe(`content of ${C}`);
  });

  it("closing an inactive tab leaves the current file alone", async () => {
    await openAll(A, B);
    useWorkspace.getState().setContent("still editing b");
    useWorkspace.getState().closeTab(A);

    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([B]);
    expect(state.openFilePath).toBe(B);
    expect(state.fileContent).toBe("still editing b");
  });

  it("closing the last tab empties the editor", async () => {
    await openAll(A);
    useWorkspace.getState().closeTab(A);

    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([]);
    expect(state.openFilePath).toBeNull();
    expect(state.fileContent).toBe("");
  });

  it("deleting a folder closes every tab inside it", async () => {
    await openAll(A, B, C);
    useWorkspace.getState().handlePathDeleted("C:\\project\\src");

    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([C]);
    expect(state.openFilePath).toBe(C);
  });

  it("renaming a folder follows every tab under it", async () => {
    await openAll(A, C);
    useWorkspace.getState().handlePathRenamed("C:\\project\\src", "C:\\project\\lib");

    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual(["C:\\project\\lib\\a.ts", C]);
    expect(state.openFilePath).toBe(C);
  });

  it("opening a folder starts from a clean editor", async () => {
    await openAll(A, B);
    await useWorkspace.getState().adoptFolder("C:\\other");

    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([]);
    expect(state.buffers).toEqual({});
    expect(state.openFilePath).toBeNull();
  });
});
