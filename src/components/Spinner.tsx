import { Loader2 } from "lucide-react";

/**
 * The app's busy mark. An HTML box around the icon does the turning, not the
 * SVG itself: Chromium repaints an SVG whose transform is animated on the main
 * thread at every frame, while a box's transform turns on the compositor.
 * Measured in WebView2 157 with three spinners on screen during a long
 * command: 12-18% of a core in the renderer with the SVG turning, 2-9% with
 * the box turning.
 */
export function Spinner({ size, className = "" }: { size: number; className?: string }) {
  return (
    <span aria-hidden className={`inline-flex animate-spin ${className}`}>
      <Loader2 size={size} />
    </span>
  );
}
