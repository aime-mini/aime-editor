import { create } from "zustand";

const STORAGE_KEY = "aime.recentFolders";
const MAX_RECENT = 8;

export interface RecentFolder {
  path: string;
  openedAt: number;
}

function isRecentFolder(value: unknown): value is RecentFolder {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { path?: unknown; openedAt?: unknown };
  return typeof candidate.path === "string" && typeof candidate.openedAt === "number";
}

function load(): RecentFolder[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecentFolder) : [];
  } catch {
    // Corrupted storage — starting over beats crashing the welcome screen.
    return [];
  }
}

function save(folders: RecentFolder[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
}

interface RecentState {
  folders: RecentFolder[];
  remember: (path: string) => void;
  /** Removes an entry that no longer exists on disk. */
  forget: (path: string) => void;
}

/** Recently opened workspaces, shared by all windows via localStorage. */
export const useRecent = create<RecentState>((set, get) => ({
  folders: load(),

  remember: (path) => {
    const folders = [{ path, openedAt: Date.now() }, ...get().folders.filter((f) => f.path !== path)].slice(
      0,
      MAX_RECENT,
    );
    save(folders);
    set({ folders });
  },

  forget: (path) => {
    const folders = get().folders.filter((f) => f.path !== path);
    save(folders);
    set({ folders });
  },
}));
