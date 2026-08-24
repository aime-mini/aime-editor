import { create } from "zustand";
import { useLayout } from "./layout";

export interface TerminalTab {
  /** Monotonic key so React never confuses two tabs' xterm instances. */
  key: number;
  /** Typed into the shell once it is ready — powers one-click actions (e.g. CLI sign-in). */
  initialCommand?: string;
  /** Tab label; task runs name themselves instead of "Terminal n". */
  title?: string;
  /**
   * Where the shell starts, when it is not the project root - a task belonging
   * to one member of a repository that holds several.
   */
  cwd?: string;
}

/** Everything a caller may choose about a new tab; the key is ours. */
export type NewTerminalTab = Omit<TerminalTab, "key">;

/**
 * Terminal tabs of this window. Each tab owns one TerminalPane (and thereby
 * one PTY); closing a tab unmounts the pane, which kills its shell.
 */
interface TerminalsState {
  tabs: TerminalTab[];
  activeTab: number;
  nextKey: number;
  /** Returns the new tab's key, so callers can follow what runs in it. */
  addTab: (tab?: NewTerminalTab) => number;
  closeTab: (key: number) => void;
  setActiveTab: (key: number) => void;
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  tabs: [{ key: 1 }],
  activeTab: 1,
  nextKey: 2,

  addTab: (tab) => {
    const key = get().nextKey;
    set((s) => ({
      tabs: [...s.tabs, { ...tab, key }],
      activeTab: key,
      nextKey: key + 1,
    }));
    return key;
  },

  closeTab: (key) => {
    set((s) => {
      const tabs = s.tabs.filter((tab) => tab.key !== key);
      // The panel always shows at least one terminal — replace the last tab.
      if (tabs.length === 0) {
        return { tabs: [{ key: s.nextKey }], activeTab: s.nextKey, nextKey: s.nextKey + 1 };
      }
      const activeTab = s.activeTab === key ? tabs[tabs.length - 1].key : s.activeTab;
      return { tabs, activeTab };
    });
  },

  setActiveTab: (key) => {
    set({ activeTab: key });
  },
}));

/**
 * Runs a command in a fresh terminal tab, revealing the panel. Interactive CLI
 * flows (sign-in, installers) belong in a real shell the user can see and
 * answer — Aime never proxies their prompts or touches their credentials.
 */
export function runInTerminal(command: string, title?: string): void {
  useLayout.getState().showTerminal();
  useTerminals.getState().addTab({ initialCommand: command, title });
}
