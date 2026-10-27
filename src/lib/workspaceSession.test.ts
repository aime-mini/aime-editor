import { describe, expect, it } from "vitest";
import {
  isWorkspaceSnapshot,
  restoreTab,
  SNAPSHOT_VERSION,
  type WorkspaceSnapshot,
} from "./workspaceSession";

const PATH = "C:/Projects/shop/src/cart.ts";

describe("how a tab comes back", () => {
  it("reads a tab with nothing unsaved from the disk, as the disk has it now", () => {
    expect(restoreTab(PATH, undefined, "export const total = 2;\n")).toEqual({
      kind: "clean",
      path: PATH,
      content: "export const total = 2;\n",
    });
  });

  it("drops a tab whose file is gone when there was nothing of ours in it", () => {
    expect(restoreTab(PATH, undefined, null)).toEqual({ kind: "gone", path: PATH });
  });

  it("brings unsaved text back, still unsaved, when the disk is as it was left", () => {
    const unsaved = { content: "half a thought", savedContent: "the file" };
    expect(restoreTab(PATH, unsaved, "the file")).toEqual({
      kind: "unsaved",
      path: PATH,
      content: "half a thought",
      savedContent: "the file",
      disk: "unchanged",
    });
  });

  it("keeps unsaved text when the file changed meanwhile, and measures it against the file as it is now", () => {
    const unsaved = { content: "my edit", savedContent: "before" };
    const restored = restoreTab(PATH, unsaved, "somebody else's edit");
    expect(restored).toEqual({
      kind: "unsaved",
      path: PATH,
      content: "my edit",
      // Against the disk as it is now: the dot is honest, and a save overwrites
      // what is really there rather than what was there yesterday.
      savedContent: "somebody else's edit",
      disk: "changed",
    });
  });

  it("keeps unsaved text when the file can no longer be read", () => {
    expect(restoreTab(PATH, { content: "my edit", savedContent: "before" }, null)).toEqual({
      kind: "unsaved",
      path: PATH,
      content: "my edit",
      savedContent: "",
      disk: "missing",
    });
  });

  it("has nothing unsaved when the disk now holds exactly the unsaved text", () => {
    expect(restoreTab(PATH, { content: "same", savedContent: "before" }, "same")).toEqual({
      kind: "clean",
      path: PATH,
      content: "same",
    });
  });
});

describe("a stored snapshot", () => {
  const snapshot: WorkspaceSnapshot = {
    version: SNAPSHOT_VERSION,
    tabs: [PATH, "aime://cloud"],
    active: PATH,
    cloudOpen: false,
    unsaved: { [PATH]: { content: "a", savedContent: "b" } },
    views: { [PATH]: { cursorState: [] } },
    expanded: ["C:/Projects/shop/src"],
    sidebarView: "files",
  };

  it("is read when it has the shape this version writes", () => {
    expect(isWorkspaceSnapshot(snapshot)).toBe(true);
    // Round-tripped the way the store does it, through JSON.
    expect(isWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
  });

  it("is ignored when nothing was stored, or when it was written by another version", () => {
    expect(isWorkspaceSnapshot(null)).toBe(false);
    expect(isWorkspaceSnapshot({ ...snapshot, version: SNAPSHOT_VERSION + 1 })).toBe(false);
  });

  it("is ignored when any part of it is not what it claims to be", () => {
    expect(isWorkspaceSnapshot({ ...snapshot, tabs: [PATH, 42] })).toBe(false);
    expect(isWorkspaceSnapshot({ ...snapshot, active: 7 })).toBe(false);
    expect(isWorkspaceSnapshot({ ...snapshot, unsaved: { [PATH]: { content: "a" } } })).toBe(false);
    expect(isWorkspaceSnapshot({ ...snapshot, expanded: "src" })).toBe(false);
  });
});
