import { create } from "zustand";

/**
 * What is being written in the AI panel's prompt box, before it is sent.
 *
 * A store of its own rather than a field of `useAi`: every keystroke lands
 * here, and only the box itself reads it - in `useAi` it would redraw every
 * reader of the conversation on each key. It lives outside the component so
 * that the conversation can hand words back (`prepend`) and so that a draft
 * survives the panel being closed and opened again.
 */
interface ComposerState {
  text: string;
  setText: (next: string | ((current: string) => string)) => void;
  /** Puts `text` in front of whatever is being written, a blank line between. */
  prepend: (text: string) => void;
}

export const useComposer = create<ComposerState>((set) => ({
  text: "",
  setText: (next) => {
    set((s) => ({ text: typeof next === "function" ? next(s.text) : next }));
  },
  prepend: (text) => {
    set((s) => ({ text: s.text.trim() === "" ? text : `${text}\n\n${s.text}` }));
  },
}));
