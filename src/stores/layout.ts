import { create } from "zustand";

/**
 * Panel visibility state. Sizes are persisted by react-resizable-panels
 * itself (autoSaveId); this store only tracks visibility so the status bar
 * and keyboard shortcuts can control panels from outside the PanelGroup.
 */
export type SidebarView = "files" | "git";

interface LayoutState {
  /** false = collapsed to a thin rail (never fully hidden) */
  sidebarVisible: boolean;
  sidebarView: SidebarView;
  setSidebarView: (view: SidebarView) => void;
  aiPanelVisible: boolean;
  terminalVisible: boolean;
  /** Latches on first open — the terminal pane mounts lazily but is never unmounted by toggling. */
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
  toggleSidebar: () => void;
  toggleAiPanel: () => void;
  toggleTerminal: () => void;
  setSidebarVisible: (visible: boolean) => void;
  setAiPanelVisible: (visible: boolean) => void;
  setTerminalVisible: (visible: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  toggleHelp: () => void;
}

export const useLayout = create<LayoutState>((set) => ({
  sidebarVisible: true,
  sidebarView: "files",
  setSidebarView: (view) => {
    set({ sidebarView: view, sidebarVisible: true });
  },
  aiPanelVisible: true,
  terminalVisible: false,
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
  toggleSidebar: () => {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }));
  },
  toggleAiPanel: () => {
    set((s) => ({ aiPanelVisible: !s.aiPanelVisible }));
  },
  toggleTerminal: () => {
    set((s) => ({
      terminalVisible: !s.terminalVisible,
      terminalEverOpened: s.terminalEverOpened || !s.terminalVisible,
    }));
  },
  setSidebarVisible: (visible) => {
    set({ sidebarVisible: visible });
  },
  setAiPanelVisible: (visible) => {
    set({ aiPanelVisible: visible });
  },
  setTerminalVisible: (visible) => {
    set((s) => ({
      terminalVisible: visible,
      terminalEverOpened: s.terminalEverOpened || visible,
    }));
  },
  setHelpOpen: (open) => {
    set({ helpOpen: open });
  },
  toggleHelp: () => {
    set((s) => ({ helpOpen: !s.helpOpen }));
  },
}));
