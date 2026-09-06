/**
 * Paces streamed text so it reads as typing rather than as jumps.
 *
 * Measured 2026-09-04 against the real CLI: the text of a turn reaches Aime in
 * chunks of about 150 characters every 750 ms - two lines at a time, once or
 * twice a second - and the same run replayed outside Aime showed the same
 * cadence, so the chunking is upstream and nothing here can make the data
 * arrive sooner. What can be done is to show each chunk over the time the next
 * one takes to arrive: the buffer drains at the rate text has been arriving,
 * a little faster so it trends towards empty, and a chunk that arrives all at
 * once is painted over ~40 frames instead of one.
 *
 * Pure and clock-free: the store hands in `now` and takes the characters back,
 * so the pacing is tested without a frame loop.
 */

/** Arrivals older than this no longer describe the current pace. */
const PACE_WINDOW_MS = 2_000;

/** Drain a little faster than text arrives, so the backlog shrinks between chunks. */
const PACE_HEADROOM = 1.15;

/** With no pace known yet, the first chunk is shown over roughly this long. */
const FIRST_CHUNK_MS = 600;

/** A backlog this deep is shown at once: the reader is waiting on words that are already here. */
const MAX_BACKLOG_CHARS = 4_000;

/** What one frame is worth when nothing says otherwise. */
const FRAME_MS = 16;

interface Arrival {
  at: number;
  chars: number;
}

export class Typewriter {
  private buffer = "";
  private arrivals: Arrival[] = [];
  private lastTakeAt: number | null = null;

  /** Text that just arrived, at `now` milliseconds. */
  push(text: string, now: number): void {
    if (text === "") return;
    // A chunk landing on an empty buffer starts a new run of typing: the time
    // since the last frame that had anything to show is waiting, not typing,
    // and counting it would show the whole chunk in one frame (measured: it did).
    if (this.buffer === "") this.lastTakeAt = null;
    this.buffer += text;
    this.arrivals.push({ at: now, chars: text.length });
    this.arrivals = this.arrivals.filter((arrival) => now - arrival.at <= PACE_WINDOW_MS);
  }

  /** The characters to show at `now`: paced to the arrival rate, never fewer than one. */
  take(now: number): string {
    // The first frame after a pause counts as one frame's worth, not as zero.
    const elapsed = this.lastTakeAt === null ? FRAME_MS : Math.max(0, now - this.lastTakeAt);
    this.lastTakeAt = now;
    if (this.buffer === "") return "";
    if (this.buffer.length >= MAX_BACKLOG_CHARS) return this.flush();
    const wanted = Math.max(1, Math.ceil(this.charsPerMs() * elapsed));
    const shown = this.buffer.slice(0, wanted);
    this.buffer = this.buffer.slice(wanted);
    return shown;
  }

  /** Everything still waiting - for the end of a turn, or a tool call the text must precede. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    this.arrivals = [];
    this.lastTakeAt = null;
    return rest;
  }

  get pending(): boolean {
    return this.buffer !== "";
  }

  /** How fast text has been arriving lately, in characters per millisecond. */
  private charsPerMs(): number {
    const chars = this.arrivals.reduce((sum, arrival) => sum + arrival.chars, 0);
    const first = this.arrivals.at(0);
    const last = this.arrivals.at(-1);
    const span = first === undefined || last === undefined ? 0 : last.at - first.at;
    if (first === undefined || span <= 0) {
      // One chunk and no history: spread what arrived over the time the next one usually takes.
      return chars / FIRST_CHUNK_MS;
    }
    // Rate between arrivals: the first chunk opens the span, so its characters
    // are not part of what arrived during it - counting them read 150 chars
    // per 750 ms as 225 and left a pause after every chunk (measured).
    return ((chars - first.chars) / span) * PACE_HEADROOM;
  }
}
