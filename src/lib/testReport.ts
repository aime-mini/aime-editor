import { stripAnsi } from "./taskOutput";

/**
 * Reading what a test run actually said, and telling two runs apart.
 *
 * This is the evidence the regression gate rests on: run the suite before a
 * change and after it, and block on anything that went from passing to
 * failing. The comparison is the whole point — a suite that was already red
 * stays red through no fault of the change, and blaming a change for damage it
 * did not do is how a gate loses the reader's trust.
 *
 * Two levels of resolution, and the difference is stated rather than hidden:
 *
 * - **The verdict** always works. Every runner on earth exits non-zero when it
 *   fails, so "was passing, is failing now" needs no parsing at all.
 * - **The failing set** needs a reader that understands the runner's output,
 *   and there is one only for runners whose real output has been measured. A
 *   report with `reader: null` says so, and the gate then knows it may only
 *   speak about the verdict.
 *
 * No reader guesses at a format. A framework arrives here by someone running
 * it, keeping the output, and writing a fixture from it.
 */

/** What one run of a test suite says about itself. */
export interface TestReport {
  /** Whether the runner reported success. A killed run never did. */
  passed: boolean;
  /** Every failing test the output named, in the order it named them. */
  failed: string[];
  /** How many tests ran, when the output says; null when it does not. */
  total: number | null;
  /**
   * Which reader understood this output, or null when none did — in which case
   * `failed` is empty because nothing is known, not because nothing failed.
   */
  reader: string | null;
}

/** How two runs of the same suite differ. */
export interface Comparison {
  /** Passing before, failing now. The only thing that blocks a run. */
  broken: string[];
  /** Failing before and still failing: real, but not this change's doing. */
  alreadyBroken: string[];
  /** Failing before, passing now — worth saying out loud. */
  repaired: string[];
  /**
   * True when the verdict got worse and no reader could say which test did it.
   * A blocking result with nothing to point at, which is still a blocking
   * result: better a gate that says "something broke, look yourself" than one
   * that stays quiet because it could not parse.
   */
  brokeWithoutDetail: boolean;
}

/** Whether this comparison should stop a run. */
export function isRegression(comparison: Comparison): boolean {
  return comparison.broken.length > 0 || comparison.brokeWithoutDetail;
}

/**
 * What a finished test command said.
 *
 * The exit code is the runner's own, from the process rather than from a line
 * it printed; `null` means it was killed, which is never a pass.
 */
export function readTestOutput(output: string, exitCode: number | null): TestReport {
  const text = stripAnsi(output);
  const passed = exitCode === 0;
  for (const reader of READERS) {
    const found = reader.read(text);
    if (found !== null) return { passed, reader: reader.name, ...found };
  }
  return { passed, failed: [], total: null, reader: null };
}

/** What one run left that the other did not. */
export function compareRuns(before: TestReport, after: TestReport): Comparison {
  const failedBefore = new Set(before.failed);
  const failedAfter = new Set(after.failed);
  const broken = after.failed.filter((name) => !failedBefore.has(name));
  return {
    broken,
    alreadyBroken: after.failed.filter((name) => failedBefore.has(name)),
    repaired: before.failed.filter((name) => !failedAfter.has(name)),
    // Only when there is nothing to point at: a named regression is already
    // reported above, and saying it twice would double-count it.
    brokeWithoutDetail: before.passed && !after.passed && broken.length === 0,
  };
}

/** What one reader gets out of an output it recognises. */
type Found = Pick<TestReport, "failed" | "total">;

interface Reader {
  name: string;
  /** The parsed result, or null when this is not that runner's output. */
  read: (text: string) => Found | null;
}

/**
 * `cargo test`. Measured against a real failing run of this project's own
 * suite: every test prints `test <name> ... ok|FAILED|ignored`, and the tail
 * repeats the failures under a `failures:` heading before a `test result:`
 * line. The per-test lines are read rather than the tail, because the tail
 * appears once per binary while the lines cover them all.
 */
const CARGO_LINE = /^test (\S+) \.\.\. (ok|FAILED|ignored)$/;
const CARGO_RESULT = /^test result: (?:ok|FAILED)\./;

const cargoReader: Reader = {
  name: "cargo",
  read: (text) => {
    const lines = text.split("\n").map((line) => line.trim());
    if (!lines.some((line) => CARGO_RESULT.test(line))) return null;
    const failed: string[] = [];
    let total = 0;
    for (const line of lines) {
      const match = CARGO_LINE.exec(line);
      if (match === null) continue;
      total += 1;
      if (match[2] === "FAILED") failed.push(match[1]);
    }
    return { failed, total };
  },
};

/**
 * Vitest. Measured against a real failing run: each failure is repeated as
 * `FAIL  <file> > <suite> > <test>` under a "Failed Tests" heading, and the
 * summary line reads `Tests  1 failed | 3 passed (4)`.
 *
 * The `FAIL` line is used rather than the `×` line above it because the `×`
 * line carries only the test's own name — two suites with a test of the same
 * name would collapse into one, and the full path is what makes a name a name.
 */
const VITEST_FAIL = /^FAIL\s+(.+?)\s*$/;
const VITEST_TOTAL = /^Tests\s+(?:(\d+) failed\s*\|?\s*)?(?:(\d+) passed)?.*\((\d+)\)/;
const VITEST_NO_TESTS = /^Test Files\s+/;

const vitestReader: Reader = {
  name: "vitest",
  read: (text) => {
    const lines = text.split("\n").map((line) => line.trim());
    const summary = lines.map((line) => VITEST_TOTAL.exec(line)).find((match) => match !== null);
    // Without the summary this is not a finished vitest run; the banner alone
    // could be anything, including a run that crashed before testing.
    if (summary === undefined && !lines.some((line) => VITEST_NO_TESTS.test(line))) return null;
    const failed = lines
      .map((line) => VITEST_FAIL.exec(line))
      .filter((match) => match !== null)
      .map((match) => match[1].replace(/\s*>\s*/g, " > "));
    return {
      failed: [...new Set(failed)],
      total: summary === undefined ? null : Number(summary[3]),
    };
  },
};

/**
 * In the order they are tried. Cargo first because its `test result:` line is
 * unmistakable; a reader that is unsure answers null and lets the next look.
 */
const READERS: Reader[] = [cargoReader, vitestReader];

/** The runners whose output has been measured, for saying so on screen. */
export const KNOWN_RUNNERS = READERS.map((reader) => reader.name);
