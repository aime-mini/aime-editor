import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { translate } from "../i18n";
import { useAi } from "./ai";
import { useRecent } from "./recent";

/** The unsaved state of a file that is open but not currently shown. */
interface TabBuffer {
  content: string;
  savedContent: string;
}

interface WorkspaceState {
  rootPath: string | null;
  /**
   * Files open in the editor, in tab order. The active one is `openFilePath`,
   * whose live text is `fileContent`/`savedContent`; the others keep their
   * text in `buffers`. One buffer per file and never two copies of the same
   * one, so a tab cannot drift out of sync with what is being edited.
   */
  openTabs: string[];
  buffers: Record<string, TabBuffer | undefined>;
  openFilePath: string | null;
  /** Repo-relative path shown in the diff view; null = normal editor. */
  diffPath: string | null;
  /** Commit whose patch is shown in the commit view; null = normal editor. */
  commitHash: string | null;
  /** Repo-relative path open in the merge-conflict resolver; null = normal editor. */
  conflictPath: string | null;
  /** Repo-relative path open in the full-file blame view; null = normal editor. */
  blamePath: string | null;
  /**
   * The work item open in the editor area; null = normal editor. It lives here
   * with the other views that take over the middle of the window, because that
   * is what it is: a description worth reading is worth the room, and the
   * sidebar has none.
   */
  workItemId: string | null;
  /** True while a Task Run has the editor area. */
  runOpen: boolean;
  /** True while the cloud panel has the editor area. */
  cloudOpen: boolean;
  fileContent: string;
  /** Content as last loaded/saved — dirty is a comparison against this, so undoing back to it clears the flag. */
  savedContent: string;
  dirty: boolean;
  treeVersion: number; // bump to make FileTree reload

  openFolder: () => Promise<void>;
  /** Makes `path` the workspace root and starts watching it (dialog + CLI entry points). */
  adoptFolder: (path: string) => Promise<void>;
  /** Returns to the welcome screen: flushes the AI session, stops the watcher. */
  closeFolder: () => void;
  openFile: (path: string) => Promise<void>;
  /** Shows an already-open file, parking the current one's unsaved text. */
  activateTab: (path: string) => void;
  /** Closes one tab; the neighbour takes over when the active tab goes. */
  closeTab: (path: string) => void;
  openDiff: (relativePath: string) => void;
  closeDiff: () => void;
  openCommit: (hash: string) => void;
  openConflict: (relativePath: string) => void;
  openBlame: (relativePath: string) => void;
  /** Shows one work item in the editor area (the panel hands over its id). */
  openWorkItem: (id: string) => void;
  /** Gives the editor area to the running Task Run. */
  openRun: () => void;
  closeRun: () => void;
  openCloud: () => void;
  closeCloud: () => void;
  setContent: (content: string) => void;
  saveFile: () => Promise<void>;
  /**
   * Writes one open file, whether its text is the live buffer or parked behind
   * another tab. Auto save needs the parked case: a save armed a second ago is
   * about the file it was armed for, not about whatever is on screen when it
   * finally fires.
   */
  saveBuffer: (path: string) => Promise<void>;
  reloadOpenFile: () => Promise<void>;
  refreshTree: () => void;
  /** Keeps the editor consistent after fs operations from the file tree. */
  handlePathDeleted: (path: string) => void;
  handlePathRenamed: (from: string, to: string) => void;
}

/**
 * Opening a file leaves whatever special view was showing.
 *
 * Every view that can own the editor area belongs here. One that is added to
 * the openers by hand instead gets missed by exactly the paths nobody thought
 * of - `cloudOpen` was, and a file opened while the cloud panel was up simply
 * did not appear.
 */
const CLOSE_SPECIAL_VIEWS = {
  diffPath: null,
  commitHash: null,
  conflictPath: null,
  blamePath: null,
  workItemId: null,
  cloudOpen: false,
} as const;

/**
 * The cloud panel's place in the tab strip.
 *
 * It sits in `openTabs` beside the files, under a name no file can have, so a
 * file opened over it puts it behind rather than closing it, and closing the
 * last file brings it back the way any neighbouring tab comes back. Reported
 * 2026-09-04: the panel vanished the moment a file was opened and had to be
 * reopened from the status bar every time. Only the X on the tab, or on the
 * panel itself, closes it.
 */
export const CLOUD_TAB = "aime://cloud";

/** True for the path itself and for anything inside it, on either separator. */
function isUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}\\`) || path.startsWith(`${ancestor}/`);
}

/** Moves the live buffer into the parked ones, so nothing unsaved is lost. */
function parkActive(state: WorkspaceState): Record<string, TabBuffer | undefined> {
  const buffers = { ...state.buffers };
  if (state.openFilePath) {
    buffers[state.openFilePath] = { content: state.fileContent, savedContent: state.savedContent };
  }
  return buffers;
}

/** Buffers without one entry - a file whose text is about to become live, or gone. */
function without(
  buffers: Record<string, TabBuffer | undefined>,
  path: string,
): Record<string, TabBuffer | undefined> {
  return Object.fromEntries(Object.entries(buffers).filter(([key]) => key !== path));
}

let fsListenerReady = false;

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Reacts to backend `fs:changed` events (debounced, ignored dirs filtered). */
  const ensureFsListener = async () => {
    if (fsListenerReady) return;
    fsListenerReady = true;
    await listen<string[]>("fs:changed", ({ payload: changedPaths }) => {
      get().refreshTree();
      const { openFilePath, dirty } = get();
      if (openFilePath && !dirty && changedPaths.includes(openFilePath)) {
        get()
          .reloadOpenFile()
          .catch((err: unknown) => {
            // Deleted or locked mid-write — keep the buffer; the tree already updated.
            console.warn("reload after fs change failed:", err);
          });
      }
    });
  };

  return {
    rootPath: null,
    openTabs: [],
    buffers: {},
    openFilePath: null,
    diffPath: null,
    commitHash: null,
    conflictPath: null,
    blamePath: null,
    workItemId: null,
    runOpen: false,
    cloudOpen: false,
    fileContent: "",
    savedContent: "",
    dirty: false,
    treeVersion: 0,

    openFolder: async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: translate("dialog.openFolderTitle"),
      });
      if (typeof selected === "string") await get().adoptFolder(selected);
    },

    adoptFolder: async (path: string) => {
      useRecent.getState().remember(path);
      set({
        rootPath: path,
        openTabs: [],
        buffers: {},
        openFilePath: null,
        fileContent: "",
        savedContent: "",
        dirty: false,
        treeVersion: get().treeVersion + 1,
      });
      try {
        await ensureFsListener();
        await invoke("watch_workspace", { path });
      } catch (err: unknown) {
        // The editor still works without live updates — don't block folder opening.
        console.error("failed to start workspace watcher:", err);
      }
    },

    closeFolder: () => {
      useAi.getState().closeProject();
      invoke("unwatch_workspace").catch((err: unknown) => {
        console.error("failed to stop workspace watcher:", err);
      });
      set({
        rootPath: null,
        openTabs: [],
        buffers: {},
        openFilePath: null,
        fileContent: "",
        savedContent: "",
        dirty: false,
      });
    },

    openFile: async (path: string) => {
      // Reopening a file that is already in a tab must not lose its edits.
      if (get().openTabs.includes(path)) {
        get().activateTab(path);
        return;
      }
      const content = await invoke<string>("read_file", { path });
      set((s) => ({
        openTabs: [...s.openTabs, path],
        buffers: parkActive(s),
        openFilePath: path,
        fileContent: content,
        savedContent: content,
        dirty: false,
        ...CLOSE_SPECIAL_VIEWS,
      }));
    },

    activateTab: (path: string) => {
      if (path === CLOUD_TAB) {
        get().openCloud();
        return;
      }
      const state = get();
      if (state.openFilePath === path) {
        set(CLOSE_SPECIAL_VIEWS);
        return;
      }
      const buffer = state.buffers[path];
      if (!buffer) return;
      // Its parked text becomes the live buffer.
      const buffers = without(parkActive(state), path);
      set({
        buffers,
        openFilePath: path,
        fileContent: buffer.content,
        savedContent: buffer.savedContent,
        dirty: buffer.content !== buffer.savedContent,
        ...CLOSE_SPECIAL_VIEWS,
      });
    },

    closeTab: (path: string) => {
      if (path === CLOUD_TAB) {
        get().closeCloud();
        return;
      }
      const state = get();
      const openTabs = state.openTabs.filter((tab) => tab !== path);
      const buffers = without(state.buffers, path);
      if (state.openFilePath !== path) {
        set({ openTabs, buffers });
        return;
      }
      // The active tab went: show the one that took its place, else the last.
      const index = state.openTabs.indexOf(path);
      const next = openTabs[index] ?? openTabs[openTabs.length - 1];
      if (!next || next === CLOUD_TAB) {
        set({
          openTabs,
          buffers,
          openFilePath: null,
          fileContent: "",
          savedContent: "",
          dirty: false,
          cloudOpen: next === CLOUD_TAB,
        });
        return;
      }
      const buffer = buffers[next];
      set({
        openTabs,
        buffers: without(buffers, next),
        openFilePath: next,
        fileContent: buffer?.content ?? "",
        savedContent: buffer?.savedContent ?? "",
        dirty: buffer ? buffer.content !== buffer.savedContent : false,
      });
    },

    // Every opener below starts from CLOSE_SPECIAL_VIEWS and names only its
    // own view. Listing the others by hand is how `openCommit` came to leave
    // `cloudOpen` alone - and a commit clicked while the cloud panel was up did
    // nothing at all (reported 2026-09-04).
    openDiff: (relativePath: string) => {
      set({ ...CLOSE_SPECIAL_VIEWS, diffPath: relativePath });
    },

    closeDiff: () => {
      set(CLOSE_SPECIAL_VIEWS);
    },

    openCommit: (hash: string) => {
      set({ ...CLOSE_SPECIAL_VIEWS, commitHash: hash });
    },

    openConflict: (relativePath: string) => {
      set({ ...CLOSE_SPECIAL_VIEWS, conflictPath: relativePath });
    },

    openBlame: (relativePath: string) => {
      set({ ...CLOSE_SPECIAL_VIEWS, blamePath: relativePath });
    },

    openWorkItem: (id: string) => {
      set({ ...CLOSE_SPECIAL_VIEWS, workItemId: id, runOpen: false });
    },

    openRun: () => {
      set({ ...CLOSE_SPECIAL_VIEWS, runOpen: true });
    },

    closeRun: () => {
      set({ runOpen: false });
    },

    openCloud: () => {
      set((s) => ({
        ...CLOSE_SPECIAL_VIEWS,
        cloudOpen: true,
        runOpen: false,
        openTabs: s.openTabs.includes(CLOUD_TAB) ? s.openTabs : [...s.openTabs, CLOUD_TAB],
      }));
    },

    closeCloud: () => {
      // The file that was behind the panel is still `openFilePath`, so it
      // shows again on its own.
      set((s) => ({ cloudOpen: false, openTabs: s.openTabs.filter((tab) => tab !== CLOUD_TAB) }));
    },

    setContent: (content: string) => {
      set({ fileContent: content, dirty: content !== get().savedContent });
    },

    saveFile: async () => {
      const { openFilePath } = get();
      if (openFilePath) await get().saveBuffer(openFilePath);
    },

    saveBuffer: async (path: string) => {
      const state = get();
      const content = state.openFilePath === path ? state.fileContent : state.buffers[path]?.content;
      if (content === undefined) return; // the tab was closed while the save waited
      await invoke("write_file", { path, content });
      set((s) => {
        // Comparing against the text that reached the disk, not clearing a flag:
        // anything typed while the write was in flight is still unsaved.
        if (s.openFilePath === path) return { savedContent: content, dirty: s.fileContent !== content };
        const buffer = s.buffers[path];
        return buffer ? { buffers: { ...s.buffers, [path]: { ...buffer, savedContent: content } } } : {};
      });
    },

    reloadOpenFile: async () => {
      const { openFilePath, dirty } = get();
      if (!openFilePath || dirty) return;
      const content = await invoke<string>("read_file", { path: openFilePath });
      set({ fileContent: content, savedContent: content });
    },

    refreshTree: () => {
      set((s) => ({ treeVersion: s.treeVersion + 1 }));
    },

    handlePathDeleted: (path: string) => {
      // A deleted folder takes every file under it with it.
      get()
        .openTabs.filter((tab) => isUnder(tab, path))
        .forEach((tab) => {
          get().closeTab(tab);
        });
    },

    handlePathRenamed: (from: string, to: string) => {
      const state = get();
      const rename = (tab: string) => (isUnder(tab, from) ? to + tab.slice(from.length) : tab);
      const buffers: Record<string, TabBuffer | undefined> = {};
      for (const [tab, buffer] of Object.entries(state.buffers)) buffers[rename(tab)] = buffer;
      set({
        openTabs: state.openTabs.map(rename),
        buffers,
        openFilePath: state.openFilePath ? rename(state.openFilePath) : null,
      });
    },
  };
});
