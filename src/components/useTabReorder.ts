import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { moveItem, slotAt } from "../lib/reorder";

/** How far the pointer moves before a press on a tab is a drag rather than a click. */
const DRAG_FROM_PX = 5;

/** The attribute every tab in the strip carries, holding its label (`WorkspaceTabs`). */
const TAB_ATTRIBUTE = "data-workspace-tab";

/**
 * Dragging a workspace tab along the strip to put it somewhere else, on
 * pointer events: with Tauri's own file drop switched on the webview delivers
 * no DOM drag events (see `usePaletteDrag`).
 *
 * While a tab is held the strip is drawn in the order it would take if let go
 * there. Once let go, that order is handed to `onReorder` and stays on screen
 * until the strip comes back from the backend, so the tab does not jump back
 * for the moment in between; a reorder the backend refuses puts it back.
 *
 * @param strip the element holding the tabs.
 * @param labels the tabs in the order the backend has them.
 */
export function useTabReorder(
  strip: RefObject<HTMLElement | null>,
  labels: readonly string[],
  onReorder: (labels: string[]) => Promise<void>,
) {
  const [held, setHeld] = useState<string | null>(null);
  /** The order shown while held and since let go, with the strip it was made from. */
  const [dropped, setDropped] = useState<{ from: string; order: string[] } | null>(null);
  /** The tab pressed, and - once it is being dragged - the order it would leave. */
  const press = useRef<{ label: string; x: number; order: string[] | null } | null>(null);
  /** Set by a drag, so the click it leaves behind on the tab does not switch to it. */
  const dragged = useRef(false);
  const latest = useRef({ labels, onReorder });

  // A strip the backend sends afterwards - the reordered one - replaces it.
  const order = dropped?.from === labels.join("\n") ? dropped.order : labels;
  useEffect(() => {
    latest.current = { labels, onReorder };
  });

  useEffect(() => {
    const orderAt = (label: string, pointerX: number): string[] => {
      const others = [...(strip.current?.querySelectorAll<HTMLElement>(`[${TAB_ATTRIBUTE}]`) ?? [])]
        .filter((tab) => tab.getAttribute(TAB_ATTRIBUTE) !== label)
        .map((tab) => tab.getBoundingClientRect());
      const base = latest.current.labels;
      return moveItem(base, base.indexOf(label), slotAt(pointerX, others));
    };
    const move = (event: PointerEvent) => {
      const pressed = press.current;
      if (pressed === null) return;
      if (pressed.order === null && Math.abs(event.clientX - pressed.x) < DRAG_FROM_PX) return;
      pressed.order = orderAt(pressed.label, event.clientX);
      setHeld(pressed.label);
      setDropped({ from: latest.current.labels.join("\n"), order: pressed.order });
    };
    const end = () => {
      const chosen = press.current?.order ?? null;
      press.current = null;
      if (chosen === null) return;
      dragged.current = true;
      setHeld(null);
      const { labels: base, onReorder: reorder } = latest.current;
      if (chosen.join("\n") === base.join("\n")) {
        setDropped(null);
        return;
      }
      reorder(chosen).catch((error: unknown) => {
        console.error("could not reorder the workspace tabs:", error);
        setDropped(null);
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [strip]);

  const begin = useCallback((label: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragged.current = false;
    press.current = { label, x: event.clientX, order: null };
  }, []);

  /** Whether the click that follows a press was the end of a drag, and so not a click. */
  const wasDrag = useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  return { order, held, begin, wasDrag };
}
