import { describe, expect, it } from "vitest";
import type { CommandOutcome } from "./exec";
import { compare, describePerf, isSlower, median, parseBench, readTiming, type Bench } from "./perfGate";

const bench: Bench = {
  label: "withTax over 50,000 lines",
  command: "node bench.cjs",
  dir: ".",
  files: ["bench.cjs"],
};

const printed = (stdout: string, code = 0): CommandOutcome => ({
  code,
  stdout,
  stderr: "",
  durationMs: 10,
  timedOut: false,
  cancelled: false,
  clipped: false,
});

describe("parseBench", () => {
  it("reads the benchmark the AI registered", () => {
    expect(parseBench(JSON.stringify(bench))).toEqual(bench);
  });

  it("fills in what may be left out", () => {
    expect(parseBench('{"command": "npm run bench"}')).toEqual({
      label: "npm run bench",
      command: "npm run bench",
      dir: ".",
      files: [],
    });
  });

  it("refuses a benchmark with nothing to run", () => {
    expect(parseBench('{"label": "x"}')).toBeNull();
    expect(parseBench("not json")).toBeNull();
  });
});

describe("readTiming", () => {
  it("takes the last timing the benchmark printed", () => {
    expect(readTiming(printed("warming up\nAIME_BENCH_MS=40\nAIME_BENCH_MS=12.5\n"))).toBe(12.5);
  });

  it("has none for a run that failed or printed none", () => {
    expect(readTiming(printed("AIME_BENCH_MS=3", 1))).toBeNull();
    expect(readTiming(printed("done in 3 ms"))).toBeNull();
  });
});

describe("the verdict", () => {
  it("is the middle run, not the mean a single outlier would drag", () => {
    expect(median([10, 400, 11])).toBe(11);
    expect(median([10, 12])).toBe(11);
  });

  it("calls a change slower only past both the ratio and the noise floor", () => {
    expect(isSlower(100, 140)).toBe(true);
    expect(isSlower(100, 120)).toBe(false);
    expect(isSlower(1, 2.5)).toBe(false);
  });
});

describe("compare", () => {
  /** A machine whose old tree answers `old` ms and new tree `now` ms; records the order it ran in. */
  function machine(old: string, now: string) {
    const order: string[] = [];
    const run = (_: string, cwd: string) => {
      const side = cwd.startsWith("/old") ? "old" : "new";
      order.push(side);
      return Promise.resolve(printed(side === "old" ? old : now));
    };
    return { order, run };
  }

  it("interleaves the two trees, so a machine getting busier slows both alike", async () => {
    const { order, run } = machine("AIME_BENCH_MS=10", "AIME_BENCH_MS=11");
    await compare(bench, "/old", "/new", run);
    expect(order).toEqual(["old", "new", "old", "new", "old", "new"]);
  });

  it("finds the change slower", async () => {
    const { run } = machine("AIME_BENCH_MS=10", "AIME_BENCH_MS=90");
    expect(await compare(bench, "/old", "/new", run)).toEqual({
      kind: "measured",
      before: 10,
      after: 90,
      slower: true,
    });
  });

  it("says so when the old code cannot run the benchmark", async () => {
    const { run } = machine("TypeError: withTax is not a function", "AIME_BENCH_MS=12");
    expect(await compare(bench, "/old", "/new", run)).toEqual({ kind: "noBaseline", after: 12 });
  });

  it("hands back what a benchmark printed when it printed no timing", async () => {
    const { run } = machine("AIME_BENCH_MS=10", "Error: cannot find module");
    expect(await compare(bench, "/old", "/new", run)).toEqual({
      kind: "broken",
      output: "Error: cannot find module",
    });
  });

  it("describes the measurement with the numbers", () => {
    expect(describePerf(bench, { kind: "measured", before: 10, after: 90, slower: true })).toBe(
      "withTax over 50,000 lines: 10.0 ms before the change, 90.0 ms after (medians of 3 interleaved runs each)",
    );
  });
});
