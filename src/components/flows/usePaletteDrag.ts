import { useCallback, useEffect, useRef, useState } from "react";
import type { PaletteEntry } from "./abilities";

/** How far the pointer moves before a press on the palette is a drag rather than a click. */
const DRAG_FROM_PX = 5;

export interface PaletteGhost {
  entry: PaletteEntry;
  x: number;
  y: number;
}

/**
 * Dragging a step out of the palette onto the canvas, on pointer events.
 *
 * Not HTML drag and drop: with Tauri's own file drop switched on, the webview
 * delivers no DOM drag events at all (the file tree learned the same, see
 * `FileTree`). A press that barely moves stays a click, which adds the step
 * the way it always did.
 *
 * @param onHover where the pointer is while a step is held, for marking a wire under it.
 * @param onDrop where it was let go.
 */
export function usePaletteDrag(
  onHover: (clientX: number, clientY: number) => void,
  onDrop: (entry: PaletteEntry, clientX: number, clientY: number) => void,
) {
  const [ghost, setGhost] = useState<PaletteGhost | null>(null);
  const press = useRef<{ entry: PaletteEntry; x: number; y: number; dragging: boolean } | null>(null);
  /** Set by a drag that ended over the palette, so the click it leaves behind adds nothing. */
  const dragged = useRef(false);
  const handlers = useRef({ onHover, onDrop });
  useEffect(() => {
    handlers.current = { onHover, onDrop };
  });

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const held = press.current;
      if (held === null) return;
      if (!held.dragging && Math.hypot(event.clientX - held.x, event.clientY - held.y) < DRAG_FROM_PX) return;
      held.dragging = true;
      setGhost({ entry: held.entry, x: event.clientX, y: event.clientY });
      handlers.current.onHover(event.clientX, event.clientY);
    };
    const up = (event: PointerEvent) => {
      const held = press.current;
      press.current = null;
      if (held?.dragging !== true) return;
      dragged.current = true;
      setGhost(null);
      handlers.current.onDrop(held.entry, event.clientX, event.clientY);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  const begin = useCallback((entry: PaletteEntry, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragged.current = false;
    press.current = { entry, x: event.clientX, y: event.clientY, dragging: false };
  }, []);

  /** Whether the click that follows a press was the end of a drag, and so not a click. */
  const wasDrag = useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  return { ghost, begin, wasDrag };
}
