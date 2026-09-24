import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isWorkspaceSnapshot,
  restoreTab,
  SNAPSHOT_VERSION,
  type RestoredTab,
  type UnsavedText,
  type WorkspaceSnapshot,
} from "../lib/workspaceSession";
import { isSidebarView, useLayout } from "./layout";
import { CLOUD_TAB, useWorkspace, type ResumedWorkspace } from "./workspace";

/**
 * Keeps each workspace as it was left: written a moment after anything worth
 * keeping changes, read back when the folder is opened again - after a
 * restart, or on coming back from another folder.
 *
 * Imported for its effect (`App.tsx`): it listens to the workspace store the
 * way git, the language servers and the debugger do, so the store itself does
 * not know it is being kept.
 */

type Workspace = ReturnType<typeof useWorkspace.getState>;

/**
 * How long after the last change the snapshot is written.
 *
 * Short, because unsaved text rides in it; a window closed inside this moment
 * is still covered, since the close is held until the snapshot is written
 * (`session/closing.rs`).
 */
const SAVE_DELAY_MS = 400;

/**
 * The workspace whose snapshot has been read, and so may be written.
 *
 * Nothing is written for a folder before its own snapshot has come back:
 * the empty editor a folder opens with would otherwise overwrite the very
 * tabs it is about to restore.
 */
let boundRoot: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** The latest view of every open file - cursor, selection, scroll - as Monaco reports it. */
const views = new Map<string, unknown>();
/** Views read back from the snapshot, waiting for their file to be shown for the first time. */
const unseenViews = new Map<string, unknown>();

function unsavedOf(workspace: Workspace): Record<string, UnsavedText> {
  const unsaved: Record<string, UnsavedText> = {};
  for (const [path, buffer] of Object.entries(workspace.buffers)) {
    if (buffer && buffer.content !== buffer.savedContent) unsaved[path] = buffer;
  }
  if (workspace.openFilePath !== null && workspace.dirty) {
    unsaved[workspace.openFilePath] = {
      content: workspace.fileContent,
      savedContent: workspace.savedContent,
    };
  }
  return unsaved;
}

function snapshotOf(workspace: Workspace): WorkspaceSnapshot {
  const open = new Set(workspace.openTabs);
  return {
    version: SNAPSHOT_VERSION,
    tabs: workspace.openTabs,
    active: workspace.openFilePath,
    cloudOpen: workspace.cloudOpen,
    unsaved: unsavedOf(workspace),
    views: Object.fromEntries([...views].filter(([path]) => open.has(path))),
    expanded: workspace.expandedDirs,
    sidebarView: useLayout.getState().sidebarView,
  };
}

async function write(root: string, snapshot: WorkspaceSnapshot): Promise<void> {
  try {
    await invoke("save_workspace_state", { rootPath: root, state: snapshot });
  } catch (err: unknown) {
    console.error(`could not keep the state of ${root}:`, err);
  }
}

function cancelPendingSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
}

function scheduleSave(): void {
  if (boundRoot === null) return;
  cancelPendingSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushWorkspaceSession();
  }, SAVE_DELAY_MS);
}

/** Writes the open workspace's snapshot now, if it has one to write. */
export async function flushWorkspaceSession(): Promise<void> {
  cancelPendingSave();
  const workspace = useWorkspace.getState();
  if (boundRoot === null || workspace.rootPath !== boundRoot) return;
  await write(boundRoot, snapshotOf(workspace));
}

/** Records where a file is being looked at, so it opens there next time. */
export function rememberView(path: string, view: unknown): void {
  views.set(path, view);
  scheduleSave();
}

/** The view a file was left with, once: after its first showing Monaco keeps its own. */
export function takeUnseenView(path: string): unknown {
  const view = unseenViews.get(path);
  unseenViews.delete(path);
  return view;
}

/** Reads every returning file and decides, per tab, what it comes back as. */
async function resumed(snapshot: WorkspaceSnapshot): Promise<ResumedWorkspace> {
  const files = snapshot.tabs.filter((tab) => tab !== CLOUD_TAB);
  const disk = await Promise.all(
    files.map((path) => invoke<string>("read_file", { path }).catch(() => null)),
  );
  const result: ResumedWorkspace = {
    tabs: [],
    files: {},
    notices: {},
    active: snapshot.active,
    cloudOpen: snapshot.cloudOpen,
    expanded: snapshot.expanded,
  };
  const back = new Map<string, RestoredTab>(
    files.map((path, index) => [path, restoreTab(path, snapshot.unsaved[path], disk[index] ?? null)]),
  );
  for (const tab of snapshot.tabs) {
    if (tab === CLOUD_TAB) {
      result.tabs.push(tab); // the cloud panel: a tab with no file behind it
      continue;
    }
    const restored = back.get(tab);
    if (restored === undefined || restored.kind === "gone") continue;
    result.tabs.push(tab);
    const savedContent = restored.kind === "clean" ? restored.content : restored.savedContent;
    result.files[tab] = { content: restored.content, savedContent };
    if (restored.kind === "unsaved" && restored.disk !== "unchanged") result.notices[tab] = restored.disk;
  }
  return result;
}

async function restore(root: string): Promise<void> {
  let stored: unknown = null;
  try {
    stored = await invoke<unknown>("load_workspace_state", { rootPath: root });
  } catch (err: unknown) {
    console.error(`could not read how ${root} was left:`, err);
  }
  const stillOpen = () => useWorkspace.getState().rootPath === root;
  if (!stillOpen()) return;
  if (isWorkspaceSnapshot(stored)) {
    const workspace = await resumed(stored);
    if (!stillOpen()) return;
    for (const path of workspace.tabs) {
      const view = stored.views[path];
      if (view === undefined) continue;
      views.set(path, view);
      unseenViews.set(path, view);
    }
    useWorkspace.getState().resume(root, workspace);
    if (isSidebarView(stored.sidebarView)) useLayout.setState({ sidebarView: stored.sidebarView });
  }
  boundRoot = root;
}

/** Whether a change is one the snapshot holds. Typing only counts once there is something unsaved. */
function changesSnapshot(state: Workspace, previous: Workspace): boolean {
  return (
    state.openTabs !== previous.openTabs ||
    state.openFilePath !== previous.openFilePath ||
    state.buffers !== previous.buffers ||
    state.cloudOpen !== previous.cloudOpen ||
    state.expandedDirs !== previous.expandedDirs ||
    state.dirty !== previous.dirty ||
    state.savedContent !== previous.savedContent ||
    (state.dirty && state.fileContent !== previous.fileContent)
  );
}

useWorkspace.subscribe((state, previous) => {
  if (state.rootPath === previous.rootPath) {
    if (changesSnapshot(state, previous)) scheduleSave();
    return;
  }
  // Another folder, or none: the one being left is written as it stood, from
  // the state it had, before anything of the next one is read.
  cancelPendingSave();
  if (boundRoot !== null && boundRoot === previous.rootPath) void write(boundRoot, snapshotOf(previous));
  boundRoot = null;
  views.clear();
  unseenViews.clear();
  if (state.rootPath !== null) void restore(state.rootPath);
});

useLayout.subscribe((state, previous) => {
  if (state.sidebarView !== previous.sidebarView) scheduleSave();
});

/**
 * The window is closing: write what is held, then let it go. The close waits
 * for this answer, but only so long (`session/closing.rs`).
 */
async function answerClosing(): Promise<void> {
  try {
    await flushWorkspaceSession();
  } finally {
    await invoke("window_flushed").catch((err: unknown) => {
      console.error("could not tell the window it may close:", err);
    });
  }
}

void listen("window:closing", () => {
  void answerClosing();
});
