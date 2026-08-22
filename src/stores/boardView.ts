import { create } from "zustand";
import type { GroupBy } from "../lib/workItems";
import { useWorkspace } from "./workspace";

/**
 * How the reader has asked to see the board.
 *
 * This is not in the panel because the sidebar renders one view at a time: a
 * glance at the file tree unmounts the work items, and everything the reader
 * had set up - what they had typed into the filter, how they had filed the
 * list, which headings they had folded away - would be gone when they came
 * back. None of it is worth a request or a byte on disk, but all of it is worth
 * surviving a click on another tab.
 *
 * It is not in the tracker store either: that store is about what the board
 * says, and this is about how one person is looking at it.
 */
interface BoardView {
  /** Narrows what is on screen, without asking the service again. */
  filter: string;
  /** null = let the list decide how it reads best (see `autoGroupBy`). */
  grouping: GroupBy | null;
  /** Headings folded away by hand; null until the reader folds one themselves. */
  folded: string[] | null;
  /** Headings the reader has asked to see in full, past the cap. */
  expanded: string[];

  setFilter: (filter: string) => void;
  /** A new way of filing means other headings, so the folding starts over. */
  setGrouping: (grouping: GroupBy) => void;
  setFolded: (folded: string[]) => void;
  expand: (key: string) => void;
}

const UNTOUCHED = { filter: "", grouping: null, folded: null, expanded: [] };

export const useBoardView = create<BoardView>((set) => ({
  ...UNTOUCHED,

  setFilter: (filter) => {
    set({ filter });
  },
  setGrouping: (grouping) => {
    set({ grouping, folded: null, expanded: [] });
  },
  setFolded: (folded) => {
    set({ folded });
  },
  expand: (key) => {
    set((state) => ({ expanded: [...state.expanded, key] }));
  },
}));

/**
 * Another project is another board: its headings are not these headings, and a
 * filter typed for one repository's work has nothing to say about the next.
 */
useWorkspace.subscribe((state, previous) => {
  if (state.rootPath !== previous.rootPath) useBoardView.setState(UNTOUCHED);
});
