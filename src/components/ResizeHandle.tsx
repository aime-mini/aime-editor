import { PanelResizeHandle } from "react-resizable-panels";

/**
 * The drag bar between two panels - thin, highlighted on hover and while
 * dragging. Shared so every divider in the app is the same three pixels: the
 * workbench ones and the one inside the Git panel.
 */
export function ResizeHandle({ horizontal = false }: { horizontal?: boolean }) {
  return (
    <PanelResizeHandle
      className={`${horizontal ? "h-[3px]" : "w-[3px]"} shrink-0 bg-line transition-colors hover:bg-accent data-[resize-handle-state=drag]:bg-accent`}
    />
  );
}
