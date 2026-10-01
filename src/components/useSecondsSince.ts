import { useEffect, useState } from "react";

const SECONDS_PER_MINUTE = 60;

/**
 * Whole seconds since `active` last turned true; 0 while it is false.
 *
 * A wait that shows nothing for half a minute is the one moment a panel has
 * nothing to say, and a number that keeps climbing is the difference between
 * "this is slow" and "this is stuck".
 */
export function useSecondsSince(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  // Nothing resets the count, and nothing has to: what carries a clock - a
  // turn's bubble, a tool chip - is a fresh instance each time, starting at 0.
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const ticking = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      clearInterval(ticking);
    };
  }, [active]);
  return active ? seconds : 0;
}

/** `42s`, then `3m 05s`: a clock that reads at a glance, in either language. */
export function formatElapsed(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = String(seconds % SECONDS_PER_MINUTE).padStart(2, "0");
  return `${String(minutes)}m ${rest}s`;
}
