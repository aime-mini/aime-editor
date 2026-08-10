import { create } from "zustand";

/**
 * Editor preferences the user can change, kept in one place.
 *
 * Deliberately small: every option here is one someone actually asked for by
 * squinting at the screen or fighting a long line. Options that only exist to
 * look configurable are how a settings page becomes unusable.
 */
/** When Aime asks the AI for ghost text at the cursor. */
export type InlineAiMode = "off" | "manual" | "auto";

export const INLINE_AI_MODES: InlineAiMode[] = ["off", "manual", "auto"];

/** Which releases this install is offered. */
export type UpdateChannel = "stable" | "beta";

export const UPDATE_CHANNELS: UpdateChannel[] = ["stable", "beta"];

export interface EditorSettings {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  /** Lines the editor keeps visible above and below the cursor. */
  tabSize: number;
  /**
   * On by default: an AI editor writes to the files the agent is reading, and a
   * buffer only the window knows about is a file the agent cannot see. Losing
   * work to a forgotten Ctrl+S is the other half of the reason.
   */
  autoSave: boolean;
  /**
   * Manual by default: each suggestion spawns a CLI and costs a moment and a
   * fraction of a cent, so asking on every pause is the user's decision to
   * make, not Aime's to assume.
   */
  inlineAi: InlineAiMode;
  /** Stable by default: a pre-release is a favour the user opts into. */
  updateChannel: UpdateChannel;
}

const STORAGE_KEY = "aime.settings";

export const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  tabSize: 2,
  autoSave: true,
  inlineAi: "manual",
  updateChannel: "stable",
};

/** Bounds that keep the editor readable whatever is in storage. */
const FONT_SIZE_RANGE = { min: 9, max: 28 };
const TAB_SIZE_RANGE = { min: 1, max: 8 };

function clamp(value: number, { min, max }: { min: number; max: number }, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** Reads stored settings, repairing anything that is out of range or absent. */
export function sanitize(stored: unknown): EditorSettings {
  if (typeof stored !== "object" || stored === null) return DEFAULT_SETTINGS;
  const raw = stored as Partial<Record<keyof EditorSettings, unknown>>;
  return {
    fontSize: clamp(Number(raw.fontSize), FONT_SIZE_RANGE, DEFAULT_SETTINGS.fontSize),
    wordWrap: typeof raw.wordWrap === "boolean" ? raw.wordWrap : DEFAULT_SETTINGS.wordWrap,
    minimap: typeof raw.minimap === "boolean" ? raw.minimap : DEFAULT_SETTINGS.minimap,
    tabSize: clamp(Number(raw.tabSize), TAB_SIZE_RANGE, DEFAULT_SETTINGS.tabSize),
    autoSave: typeof raw.autoSave === "boolean" ? raw.autoSave : DEFAULT_SETTINGS.autoSave,
    inlineAi: INLINE_AI_MODES.includes(raw.inlineAi as InlineAiMode)
      ? (raw.inlineAi as InlineAiMode)
      : DEFAULT_SETTINGS.inlineAi,
    updateChannel: UPDATE_CHANNELS.includes(raw.updateChannel as UpdateChannel)
      ? (raw.updateChannel as UpdateChannel)
      : DEFAULT_SETTINGS.updateChannel,
  };
}

function load(): EditorSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    // Corrupted storage should cost the user their preferences, not their editor.
    return DEFAULT_SETTINGS;
  }
}

interface SettingsState extends EditorSettings {
  update: (patch: Partial<EditorSettings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),

  update: (patch) => {
    const next = sanitize({ ...get(), ...patch });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    set(next);
  },

  reset: () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
    set(DEFAULT_SETTINGS);
  },
}));
