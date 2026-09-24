import { beforeEach, describe, expect, it, vi } from "vitest";

/** The store talks to Tauri; the tab logic under test does not. */
const readFile = vi.fn<(command: string, args: { path: string }) => Promise<string>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { path: string }) =>
    command === "read_file" ? readFile(command, args) : Promise.resolve(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

const { CLOUD_TAB, useWorkspace } = await import("./workspace");
type ResumedWorkspace = import("./workspace").ResumedWorkspace;

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

describe("the cloud panel as a tab", () => {
  beforeEach(() => {
    useWorkspace.setState({
      rootPath: "C:\\project",
      openTabs: [],
      buffers: {},
      openFilePath: null,
      fileContent: "",
      savedContent: "",
      dirty: false,
      cloudOpen: false,
    });
  });

  it("opens as a tab, once, and stays in the strip when a file opens over it", async () => {
    useWorkspace.getState().openCloud();
    useWorkspace.getState().openCloud();
    expect(useWorkspace.getState().openTabs).toEqual([CLOUD_TAB]);
    expect(useWorkspace.getState().cloudOpen).toBe(true);

    await openAll(A);
    const state = useWorkspace.getState();
    expect(state.cloudOpen).toBe(false);
    expect(state.openFilePath).toBe(A);
    expect(state.openTabs).toEqual([CLOUD_TAB, A]);
  });

  it("comes back when its tab is clicked, keeping the file behind it", async () => {
    useWorkspace.getState().openCloud();
    await openAll(A);
    useWorkspace.getState().activateTab(CLOUD_TAB);

    const state = useWorkspace.getState();
    expect(state.cloudOpen).toBe(true);
    expect(state.openFilePath).toBe(A);
    expect(state.fileContent).toBe(`content of ${A}`);
  });

  it("comes back when the last file beside it is closed", async () => {
    useWorkspace.getState().openCloud();
    await openAll(A);
    useWorkspace.getState().closeTab(A);

    const state = useWorkspace.getState();
    expect(state.cloudOpen).toBe(true);
    expect(state.openFilePath).toBeNull();
    expect(state.openTabs).toEqual([CLOUD_TAB]);
  });

  it("closes only from its own X, and the file behind it shows again", async () => {
    await openAll(A);
    useWorkspace.getState().openCloud();
    useWorkspace.getState().closeTab(CLOUD_TAB);

    const state = useWorkspace.getState();
    expect(state.cloudOpen).toBe(false);
    expect(state.openTabs).toEqual([A]);
    expect(state.openFilePath).toBe(A);
  });
});

describe("special views over the cloud panel", () => {
  beforeEach(() => {
    useWorkspace.setState({
      openTabs: [],
      openFilePath: null,
      cloudOpen: false,
      commitHash: null,
      diffPath: null,
    });
  });

  it("a commit opened while the panel is up shows the commit and keeps the panel's tab", () => {
    useWorkspace.getState().openCloud();
    useWorkspace.getState().openCommit("abc123");

    const state = useWorkspace.getState();
    expect(state.cloudOpen).toBe(false);
    expect(state.commitHash).toBe("abc123");
    expect(state.openTabs).toEqual([CLOUD_TAB]);
  });

  it("every opener puts the panel behind, and the panel's tab brings it back over any of them", () => {
    const store = useWorkspace.getState();
    const openers = [
      () => {
        store.openDiff("a.ts");
      },
      () => {
        store.openCommit("abc123");
      },
      () => {
        store.openConflict("a.ts");
      },
      () => {
        store.openBlame("a.ts");
      },
      () => {
        store.openWorkItem("42");
      },
      () => {
        store.openRun();
      },
    ];
    for (const open of openers) {
      store.openCloud();
      open();
      expect(useWorkspace.getState().cloudOpen).toBe(false);
      store.activateTab(CLOUD_TAB);
      const after = useWorkspace.getState();
      expect(after.cloudOpen).toBe(true);
      expect([
        after.diffPath,
        after.commitHash,
        after.conflictPath,
        after.blamePath,
        after.workItemId,
      ]).toEqual([null, null, null, null, null]);
    }
  });
});

describe("a workspace coming back as it was left", () => {
  const ROOT = "C:\\project";
  const resumed = (overrides: Partial<ResumedWorkspace> = {}): ResumedWorkspace => ({
    tabs: [A, B],
    files: {
      [A]: { content: "a, edited", savedContent: "a on disk" },
      [B]: { content: "b on disk", savedContent: "b on disk" },
    },
    notices: {},
    active: A,
    cloudOpen: false,
    expanded: ["C:\\project\\src"],
    ...overrides,
  });

  beforeEach(() => {
    useWorkspace.setState({
      rootPath: ROOT,
      openTabs: [],
      buffers: {},
      openFilePath: null,
      fileContent: "",
      savedContent: "",
      dirty: false,
      cloudOpen: false,
      expandedDirs: [],
      diskNotices: {},
    });
  });

  it("puts back the tabs, the file in front and its unsaved text", () => {
    useWorkspace.getState().resume(ROOT, resumed());
    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([A, B]);
    expect(state.openFilePath).toBe(A);
    expect([state.fileContent, state.savedContent, state.dirty]).toEqual(["a, edited", "a on disk", true]);
    // The tab behind is parked like any other, ready to switch to.
    useWorkspace.getState().activateTab(B);
    expect(useWorkspace.getState().fileContent).toBe("b on disk");
    expect(useWorkspace.getState().expandedDirs).toEqual(["C:\\project\\src"]);
  });

  it("keeps what was opened while it was being read, and keeps it in front", async () => {
    await openAll(C);
    useWorkspace.getState().setContent("typed while the snapshot was read");
    useWorkspace.getState().resume(ROOT, resumed());
    const state = useWorkspace.getState();
    expect(state.openTabs).toEqual([A, B, C]);
    expect(state.openFilePath).toBe(C);
    expect(state.fileContent).toBe("typed while the snapshot was read");
  });

  it("prefers the open tab's own text over the snapshot's copy of it", async () => {
    await openAll(A);
    useWorkspace.getState().setContent("newer than the snapshot");
    useWorkspace.getState().resume(ROOT, resumed());
    expect(useWorkspace.getState().fileContent).toBe("newer than the snapshot");
  });

  it("does nothing for a folder that is no longer the open one", () => {
    useWorkspace.getState().resume("C:\\another", resumed());
    expect(useWorkspace.getState().openTabs).toEqual([]);
  });

  it("brings the cloud panel back in front when that is how it was left", () => {
    useWorkspace.getState().resume(ROOT, resumed({ tabs: [A, CLOUD_TAB], cloudOpen: true }));
    const state = useWorkspace.getState();
    expect(state.cloudOpen).toBe(true);
    expect(state.openFilePath).toBe(A); // still behind the panel, as it was
  });

  it("gives up unsaved text for the disk's only when asked, and closes a tab whose file is gone", async () => {
    useWorkspace.getState().resume(ROOT, resumed({ notices: { [A]: "changed", [B]: "missing" } }));
    readFile.mockResolvedValueOnce("a as the disk has it now");
    await useWorkspace.getState().takeDiskVersion(A);
    let state = useWorkspace.getState();
    expect([state.fileContent, state.dirty, state.diskNotices[A]]).toEqual([
      "a as the disk has it now",
      false,
      undefined,
    ]);
    await useWorkspace.getState().takeDiskVersion(B);
    state = useWorkspace.getState();
    expect(state.openTabs).toEqual([A]);
    expect(state.diskNotices[B]).toBeUndefined();
  });

  it("keeps the text and the notice when the file on disk cannot be read after all", async () => {
    useWorkspace.getState().resume(ROOT, resumed({ notices: { [A]: "changed" } }));
    readFile.mockRejectedValueOnce(new Error("locked by another process"));
    await expect(useWorkspace.getState().takeDiskVersion(A)).rejects.toThrow("locked");
    const state = useWorkspace.getState();
    expect([state.fileContent, state.diskNotices[A]]).toEqual(["a, edited", "changed"]);
  });

  it("keeps the unsaved text when the notice is dismissed", () => {
    useWorkspace.getState().resume(ROOT, resumed({ notices: { [A]: "changed" } }));
    useWorkspace.getState().dismissDiskNotice(A);
    const state = useWorkspace.getState();
    expect(state.diskNotices[A]).toBeUndefined();
    expect(state.fileContent).toBe("a, edited");
  });

  it("follows open folders and notices through a rename, and forgets folders that are deleted", () => {
    useWorkspace.getState().resume(ROOT, resumed({ notices: { [A]: "changed" } }));
    useWorkspace.getState().setDirExpanded("C:\\project\\src\\nested", true);
    useWorkspace.getState().handlePathRenamed("C:\\project\\src", "C:\\project\\lib");
    let state = useWorkspace.getState();
    expect(state.expandedDirs).toEqual(["C:\\project\\lib", "C:\\project\\lib\\nested"]);
    expect(state.diskNotices["C:\\project\\lib\\a.ts"]).toBe("changed");
    useWorkspace.getState().handlePathDeleted("C:\\project\\lib\\nested");
    state = useWorkspace.getState();
    expect(state.expandedDirs).toEqual(["C:\\project\\lib"]);
  });

  it("opens a folder in the tree once, and closes it once", () => {
    const { setDirExpanded } = useWorkspace.getState();
    setDirExpanded("C:\\project\\src", true);
    setDirExpanded("C:\\project\\src", true);
    expect(useWorkspace.getState().expandedDirs).toEqual(["C:\\project\\src"]);
    setDirExpanded("C:\\project\\src", false);
    expect(useWorkspace.getState().expandedDirs).toEqual([]);
  });
});
