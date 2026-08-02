import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { translate } from "../i18n";
import { useAi } from "./ai";
import { useRecent } from "./recent";

interface WorkspaceState {
  rootPath: string | null;
  openFilePath: string | null;
  /** Repo-relative path shown in the diff view; null = normal editor. */
  diffPath: string | null;
  /** Commit whose patch is shown in the commit view; null = normal editor. */
  commitHash: string | null;
  /** Repo-relative path open in the merge-conflict resolver; null = normal editor. */
  conflictPath: string | null;
  /** Repo-relative path open in the full-file blame view; null = normal editor. */
  blamePath: string | null;
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
  openDiff: (relativePath: string) => void;
  closeDiff: () => void;
  openCommit: (hash: string) => void;
  openConflict: (relativePath: string) => void;
  openBlame: (relativePath: string) => void;
  setContent: (content: string) => void;
  saveFile: () => Promise<void>;
  reloadOpenFile: () => Promise<void>;
  refreshTree: () => void;
  /** Keeps the editor consistent after fs operations from the file tree. */
  handlePathDeleted: (path: string) => void;
  handlePathRenamed: (from: string, to: string) => void;
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
    openFilePath: null,
    diffPath: null,
    commitHash: null,
    conflictPath: null,
    blamePath: null,
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
        openFilePath: null,
        fileContent: "",
        savedContent: "",
        dirty: false,
      });
    },

    openFile: async (path: string) => {
      const content = await invoke<string>("read_file", { path });
      set({
        openFilePath: path,
        fileContent: content,
        savedContent: content,
        dirty: false,
        diffPath: null,
        commitHash: null,
        conflictPath: null,
        blamePath: null,
      });
    },

    openDiff: (relativePath: string) => {
      set({ diffPath: relativePath, commitHash: null, conflictPath: null, blamePath: null });
    },

    closeDiff: () => {
      set({ diffPath: null, commitHash: null, conflictPath: null, blamePath: null });
    },

    openCommit: (hash: string) => {
      set({ commitHash: hash, diffPath: null, conflictPath: null, blamePath: null });
    },

    openConflict: (relativePath: string) => {
      set({ conflictPath: relativePath, diffPath: null, commitHash: null, blamePath: null });
    },

    openBlame: (relativePath: string) => {
      set({ blamePath: relativePath, diffPath: null, commitHash: null, conflictPath: null });
    },

    setContent: (content: string) => {
      set({ fileContent: content, dirty: content !== get().savedContent });
    },

    saveFile: async () => {
      const { openFilePath, fileContent } = get();
      if (!openFilePath) return;
      await invoke("write_file", { path: openFilePath, content: fileContent });
      set({ savedContent: fileContent, dirty: false });
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
      const { openFilePath } = get();
      if (
        openFilePath === path ||
        openFilePath?.startsWith(`${path}\\`) ||
        openFilePath?.startsWith(`${path}/`)
      ) {
        set({ openFilePath: null, fileContent: "", savedContent: "", dirty: false });
      }
    },

    handlePathRenamed: (from: string, to: string) => {
      const { openFilePath } = get();
      if (!openFilePath) return;
      if (openFilePath === from) {
        set({ openFilePath: to });
      } else if (openFilePath.startsWith(`${from}\\`) || openFilePath.startsWith(`${from}/`)) {
        set({ openFilePath: to + openFilePath.slice(from.length) });
      }
    },
  };
});
