import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useWorkspace } from "./workspace";

/**
 * The workspace tabs of this window (`src-tauri/src/workspaces.rs`).
 *
 * Each tab is a window of its own and keeps running while hidden; this store
 * only mirrors which tabs this window's group has, names this window's own tab
 * after the folder it holds, and asks the backend to switch, open, detach and
 * close.
 */

/** One tab: its window, and the folder it has open (none on the welcome screen). */
export interface WorkspaceTab {
  label: string;
  folder: string | null;
}

interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  /** The tab on screen - this window's own. */
  active: string | null;
  refresh: () => Promise<void>;
  /** Opens a folder - or the welcome screen - as a new tab and shows it. */
  open: (folder: string | null) => Promise<void>;
  switchTo: (label: string) => Promise<void>;
  /** Takes a tab out into a window of its own. */
  detach: (label: string) => Promise<void>;
  close: (label: string) => Promise<void>;
}

export const useWorkspaceTabs = create<WorkspaceTabsState>((set) => ({
  tabs: [],
  active: null,

  refresh: async () => {
    const { tabs, active } = await invoke<{ tabs: WorkspaceTab[]; active: string }>("workspace_tabs");
    set({ tabs, active });
  },

  open: (folder) => invoke("workspace_open", { folder }),
  switchTo: (label) => invoke("workspace_switch", { label }),
  detach: (label) => invoke("workspace_detach", { label }),
  close: (label) => invoke("workspace_close", { label }),
}));

/** The name a tab shows: its folder's own name. */
export function tabName(tab: WorkspaceTab): string | null {
  return tab.folder === null
    ? null
    : (tab.folder
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? tab.folder);
}

function register(folder: string | null): void {
  invoke("workspace_register", { folder }).catch((error: unknown) => {
    console.error("could not name this workspace's tab:", error);
  });
}

// This window's tab carries whatever folder it has open, as it changes.
register(useWorkspace.getState().rootPath);
useWorkspace.subscribe((state, previous) => {
  if (state.rootPath !== previous.rootPath) register(state.rootPath);
});

void listen("workspaces:changed", () => {
  useWorkspaceTabs
    .getState()
    .refresh()
    .catch((error: unknown) => {
      console.error("could not read the workspace tabs:", error);
    });
});
void useWorkspaceTabs.getState().refresh();
