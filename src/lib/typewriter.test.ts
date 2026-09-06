import { describe, expect, it } from "vitest";
import { Typewriter } from "./typewriter";

/** Runs `count` frames of 16 ms starting after `from`, collecting what each one shows. */
function frames(writer: Typewriter, from: number, count: number): string[] {
  const shown: string[] = [];
  for (let i = 1; i <= count; i++) shown.push(writer.take(from + i * 16));
  return shown;
}

describe("Typewriter", () => {
  it("spreads a lone chunk over about 600 ms instead of showing it in one frame", () => {
    const writer = new Typewriter();
    writer.push("x".repeat(150), 1_000);
    const shown = frames(writer, 1_000, 60);
    const perFrame = shown.map((s) => s.length);
    // 150 chars over ~600 ms is 4 per 16 ms frame; the chunk is gone well before a second.
    expect(perFrame[0]).toBe(4);
    expect(shown.join("")).toBe("x".repeat(150));
    const framesUsed = perFrame.findIndex((n) => n === 0);
    expect(framesUsed).toBeGreaterThan(30);
    expect(framesUsed).toBeLessThan(45);
  });

  it("keeps up with the measured cadence: 150 chars every 750 ms drains before the next chunk", () => {
    const writer = new Typewriter();
    let now = 0;
    let worstBacklog = 0;
    for (let chunk = 0; chunk < 6; chunk++) {
      writer.push("a".repeat(150), now);
      let shownSinceChunk = 0;
      for (let t = now + 16; t < now + 750; t += 16) shownSinceChunk += writer.take(t).length;
      // Everything that arrived is on screen before the next chunk lands.
      worstBacklog = Math.max(worstBacklog, 150 - shownSinceChunk);
      now += 750;
    }
    expect(worstBacklog).toBe(0);
  });

  it("types the next chunk out too, instead of showing it whole after the wait", () => {
    const writer = new Typewriter();
    writer.push("a".repeat(150), 0);
    for (let t = 16; t < 750; t += 16) writer.take(t);
    expect(writer.pending).toBe(false);
    // 750 ms of silence, then the next chunk: the first frame shows a frame's worth.
    writer.push("b".repeat(150), 750);
    const firstFrame = writer.take(766);
    expect(firstFrame.length).toBeGreaterThan(0);
    expect(firstFrame.length).toBeLessThan(12);
  });

  it("keeps up with fine-grained streaming too: 11 chars every 53 ms never falls far behind", () => {
    const writer = new Typewriter();
    let now = 0;
    let shown = 0;
    let pushed = 0;
    let worstBacklog = 0;
    for (let i = 0; i < 100; i++) {
      writer.push("b".repeat(11), now);
      pushed += 11;
      for (let t = now + 16; t < now + 53; t += 16) shown += writer.take(t).length;
      worstBacklog = Math.max(worstBacklog, pushed - shown);
      now += 53;
    }
    shown += writer.flush().length;
    expect(shown).toBe(pushed);
    // Never more than a couple of chunks behind what has arrived.
    expect(worstBacklog).toBeLessThan(30);
  });

  it("shows at least one character per frame, so a trickle still moves", () => {
    const writer = new Typewriter();
    writer.push("ab", 0);
    expect(writer.take(16)).toBe("a");
    expect(writer.take(32)).toBe("b");
    expect(writer.take(48)).toBe("");
    expect(writer.pending).toBe(false);
  });

  it("dumps a deep backlog at once rather than typing for a minute", () => {
    const writer = new Typewriter();
    writer.push("c".repeat(5_000), 0);
    expect(writer.take(16)).toHaveLength(5_000);
    expect(writer.pending).toBe(false);
  });

  it("flush hands back everything still waiting and forgets the pace", () => {
    const writer = new Typewriter();
    writer.push("hello ", 0);
    writer.push("world", 100);
    const shown = writer.take(116) + writer.take(132);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown + writer.flush()).toBe("hello world");
    expect(writer.pending).toBe(false);
    expect(writer.flush()).toBe("");
  });
});
