import { create } from "zustand";

/**
 * Dragging a path around inside Aime, on pointer events rather than HTML5
 * drag-and-drop.
 *
 * Not a preference - the two are mutually exclusive in this window. Tauri's
 * `dragDropEnabled` is what delivers a file dropped from Explorer *with its
 * path on disk*, which is the one thing an AI CLI can use; and with it on, the
 * webview's own DOM drag-and-drop is switched off (Tauri v2: "Tauri's internal
 * drag and drop system is enabled, and DOM drag and drop is disabled"). The
 * file tree used `draggable` + `dataTransfer`, so having both meant giving up
 * one of them - until the tree stopped needing DOM events at all.
 *
 * Pointer events cost nothing here: a drag is a press, a move past a few
 * pixels, and a release. The few pixels matter - without that threshold every
 * click on a file would start a drag, and opening a file is what the tree is
 * mostly for.
 */

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

interface PathDragState {
  /** The path being dragged, or null when nothing is. */
  path: string | null;
  /** Where the pointer is, so a label can follow it. */
  x: number;
  y: number;
  /**
   * Starts watching a press. Nothing is dragging yet: the listeners promote it
   * once the pointer has moved far enough, and drop it on release either way.
   */
  press: (path: string, startX: number, startY: number) => void;
  /** Ends a drag without a drop - a release outside every target. */
  cancel: () => void;
}

export const usePathDrag = create<PathDragState>((set, get) => ({
  path: null,
  x: 0,
  y: 0,

  press: (path, startX, startY) => {
    const onMove = (event: PointerEvent) => {
      const far =
        Math.abs(event.clientX - startX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - startY) > DRAG_THRESHOLD_PX;
      if (get().path === null && !far) return;
      set({ path, x: event.clientX, y: event.clientY });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Cleared on the next frame, not now: a drop target reads this in its own
      // pointerup handler, which runs after this one.
      requestAnimationFrame(() => {
        set({ path: null });
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  },

  cancel: () => {
    set({ path: null });
  },
}));
