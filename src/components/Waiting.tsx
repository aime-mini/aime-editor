import { Loader2 } from "lucide-react";

/**
 * One line saying that something is on its way.
 *
 * It stands where the content will be, so an answer that takes a second reads as
 * work in progress rather than as an empty panel - the difference between "there
 * is nothing here" and "we are still looking".
 */
export function Waiting({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-muted">
      <Loader2 size={12} className="animate-spin" /> {label}
    </p>
  );
}

/** Offsets that turn three identical dots into one wave. */
const DOT_DELAYS_MS = [0, 180, 360];

/**
 * Three dots travelling as a wave: an answer is coming but nothing of it has
 * been written yet.
 *
 * A spinner would do as well for a second of waiting, but an AI turn is minutes
 * long and a spinner that long turns into a machine that has hung. Dots read as
 * someone composing.
 */
export function ThinkingDots() {
  return (
    <span aria-hidden className="flex items-center gap-1">
      {DOT_DELAYS_MS.map((delay) => (
        <span
          key={delay}
          style={{ animationDelay: `${String(delay)}ms` }}
          className="size-[3px] animate-thinking rounded-full bg-current"
        />
      ))}
    </span>
  );
}

/**
 * The blinking bar at the end of text that is still arriving.
 *
 * Without it a stream that pauses mid-sentence is indistinguishable from a turn
 * that ended mid-sentence - the panel just stops, and the reader is left to
 * guess. `align-middle` rather than a nudged block: the bar has to sit on the
 * same baseline as the character before it, whatever the line ends up wrapping.
 */
export function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[0.95em] w-[2px] animate-caret bg-accent align-middle"
    />
  );
}
