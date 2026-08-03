import { create } from "zustand";

/**
 * Panel visibility state. Sizes are persisted by react-resizable-panels
 * itself (autoSaveId); this store only tracks visibility so the status bar
 * and keyboard shortcuts can control panels from outside the PanelGroup.
 */
export type SidebarView = "files" | "git" | "debug";

/** The bottom panel hosts two things; only one is on screen at a time. */
export type BottomView = "terminal" | "debug";

interface LayoutState {
  /** false = collapsed to a thin rail (never fully hidden) */
  sidebarVisible: boolean;
  sidebarView: SidebarView;
  setSidebarView: (view: SidebarView) => void;
  aiPanelVisible: boolean;
  bottomVisible: boolean;
  bottomView: BottomView;
  /**
   * Latches the first time the terminal view is actually shown — the pane
   * mounts lazily but is never unmounted by toggling, or the shell would die.
   * Opening the panel on the Debug Console must not spawn a shell nobody asked
   * for, which is why this is not simply "the panel was opened".
   */
  terminalEverOpened: boolean;
  helpOpen: boolean;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  memoryOpen: boolean;
  setMemoryOpen: (open: boolean) => void;
  mcpOpen: boolean;
  setMcpOpen: (open: boolean) => void;
  /** Tools the installer is working through; empty = no installer open. */
  installerTools: string[];
  setInstallerTools: (toolIds: string[]) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  toggleAiPanel: () => void;
  toggleBottomPanel: () => void;
  setSidebarVisible: (visible: boolean) => void;
  setAiPanelVisible: (visible: boolean) => void;
  setBottomVisible: (visible: boolean) => void;
  setBottomView: (view: BottomView) => void;
  /** Reveals the bottom panel with the terminal in it. */
  showTerminal: () => void;
  /** Reveals the bottom panel with the Debug Console in it. */
  showDebugConsole: () => void;
  setHelpOpen: (open: boolean) => void;
  toggleHelp: () => void;
}

/** The terminal pane must exist before it can be shown, and forever after. */
function withTerminalLatch(state: LayoutState, visible: boolean, view: BottomView) {
  return {
    bottomVisible: visible,
    bottomView: view,
    terminalEverOpened: state.terminalEverOpened || (visible && view === "terminal"),
  };
}

export const useLayout = create<LayoutState>((set) => ({
  sidebarVisible: true,
  sidebarView: "files",
  setSidebarView: (view) => {
    set({ sidebarView: view, sidebarVisible: true });
  },
  aiPanelVisible: true,
  bottomVisible: false,
  bottomView: "terminal",
  terminalEverOpened: false,
  helpOpen: false,
  paletteOpen: false,
  setPaletteOpen: (open) => {
    set({ paletteOpen: open });
  },
  togglePalette: () => {
    set((s) => ({ paletteOpen: !s.paletteOpen }));
  },
  memoryOpen: false,
  setMemoryOpen: (open) => {
    set({ memoryOpen: open });
  },
  mcpOpen: false,
  setMcpOpen: (open) => {
    set({ mcpOpen: open });
  },
  installerTools: [],
  setInstallerTools: (toolIds) => {
    set({ installerTools: toolIds });
  },
  settingsOpen: false,
  setSettingsOpen: (open) => {
    set({ settingsOpen: open });
  },
  toggleSidebar: () => {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }));
  },
  toggleAiPanel: () => {
    set((s) => ({ aiPanelVisible: !s.aiPanelVisible }));
  },
  toggleBottomPanel: () => {
    set((s) => withTerminalLatch(s, !s.bottomVisible, s.bottomView));
  },
  setSidebarVisible: (visible) => {
    set({ sidebarVisible: visible });
  },
  setAiPanelVisible: (visible) => {
    set({ aiPanelVisible: visible });
  },
  setBottomVisible: (visible) => {
    set((s) => withTerminalLatch(s, visible, s.bottomView));
  },
  setBottomView: (view) => {
    set((s) => withTerminalLatch(s, true, view));
  },
  showTerminal: () => {
    set((s) => withTerminalLatch(s, true, "terminal"));
  },
  showDebugConsole: () => {
    set((s) => withTerminalLatch(s, true, "debug"));
  },
  setHelpOpen: (open) => {
    set({ helpOpen: open });
  },
  toggleHelp: () => {
    set((s) => ({ helpOpen: !s.helpOpen }));
  },
}));
