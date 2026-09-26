import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  /** Its page is still loading; it takes its place on screen once it has painted. */
  loading: boolean;
}

interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  /**
   * The tab on screen. Only the window on screen draws the strip, so that is
   * always this window's own tab - known here without asking, which keeps a
   * tab just switched to from showing the previous one lit until the backend
   * answers.
   */
  active: string;
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
  active: getCurrentWindow().label,

  refresh: async () => {
    const { tabs } = await invoke<{ tabs: WorkspaceTab[] }>("workspace_tabs");
    set({ tabs });
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

// This tab was put on screen beneath the one showing, to draw its first frames
// unseen (`workspaces.rs`, the stage). Two frames later it has, and it can take
// that one's place.
void listen<string>("workspaces:staged", (event) => {
  if (event.payload !== getCurrentWindow().label) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      invoke("workspace_staged").catch((error: unknown) => {
        console.error("could not take this tab's place on screen:", error);
      });
    });
  });
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
