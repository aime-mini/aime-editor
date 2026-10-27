import { create } from "zustand";

/**
 * What the AI is doing about the cursor right now.
 *
 * A CLI takes seconds to answer, so silence would read as "broken". The status
 * bar watches this and says which of the three it is: thinking, nothing to
 * add, or it failed and here is why.
 */
export type InlineAiState =
  { kind: "idle" } | { kind: "thinking" } | { kind: "empty" } | { kind: "failed"; reason: string };

interface InlineAiStore {
  state: InlineAiState;
  set: (state: InlineAiState) => void;
}

export const useInlineAi = create<InlineAiStore>((set) => ({
  state: { kind: "idle" },
  set: (state) => {
    set({ state });
  },
}));
