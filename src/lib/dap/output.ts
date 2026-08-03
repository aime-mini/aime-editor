import type { OutputEventBody } from "./protocol";

/**
 * What the Debug Console shows.
 *
 * The console is a list of segments rather than a list of lines, because a
 * program's output does not arrive in lines. Measured against debugpy: a
 * single `print("total", n)` came back as `"total"`, `" 6\n"` — two events.
 * Treating each event as a line would print that as two rows.
 */
export type OutputCategory = "stdout" | "stderr" | "console";

export interface OutputSegment {
  category: OutputCategory;
  text: string;
}

/**
 * Categories that are for the debugger, not for the user.
 *
 * js-debug mixes `telemetry` events into the same stream as program output;
 * showing them would put the adapter's own metrics in the user's console.
 */
const HIDDEN_CATEGORIES = new Set(["telemetry"]);

/** Anything Aime does not recognise is treated as ordinary console text. */
function categoryOf(raw: string | undefined): OutputCategory {
  if (raw === "stderr") return "stderr";
  if (raw === "stdout") return "stdout";
  return "console";
}

/** The console keeps this much text; a runaway loop must not eat the window. */
const MAX_CHARACTERS = 200_000;

/**
 * Appends one `output` event, merging it into the previous segment when it is
 * more of the same stream. Returns the same array when there is nothing to
 * show, so a telemetry storm causes no re-render.
 */
export function appendOutput(segments: OutputSegment[], body: OutputEventBody): OutputSegment[] {
  if (HIDDEN_CATEGORIES.has(body.category ?? "")) return segments;
  const text = body.output ?? "";
  if (text === "") return segments;

  const category = categoryOf(body.category);
  const last = segments[segments.length - 1] as OutputSegment | undefined;
  const merged =
    last && last.category === category
      ? [...segments.slice(0, -1), { category, text: last.text + text }]
      : [...segments, { category, text }];
  return trim(merged);
}

/** Drops whole segments from the front until the console is back under its cap. */
function trim(segments: OutputSegment[]): OutputSegment[] {
  let total = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  if (total <= MAX_CHARACTERS) return segments;

  const kept = [...segments];
  while (kept.length > 1 && total > MAX_CHARACTERS) {
    const dropped = kept.shift();
    total -= dropped?.text.length ?? 0;
  }
  // A single segment can be over the cap on its own; keep its tail.
  const first = kept[0] as OutputSegment | undefined;
  if (first && first.text.length > MAX_CHARACTERS) {
    kept[0] = { category: first.category, text: first.text.slice(-MAX_CHARACTERS) };
  }
  return kept;
}
