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
 * `dotnet test`. Measured 2026-08-23 against real failing runs of xunit 2.9,
 * MSTest 3.6 and NUnit 4.2 — all three go through the same VSTest console
 * runner, so one reader covers them, and the SDK 10 template still prints this
 * format.
 *
 * Each failure is a `Failed <name> [<duration>]` line and every test assembly
 * ends with `Failed!  - Failed: 2, Passed: 3, Skipped: 1, Total: 6`. A solution
 * prints one such summary per assembly, so the totals are added rather than
 * taken from the last one.
 *
 * The name is kept exactly as printed and never rebuilt: xunit prints it fully
 * qualified with the theory arguments (`Shop.CartTests.Rounds(amount: 1)`),
 * MSTest and NUnit print the bare method (`Rounds_down`, `Never_negative (1)`).
 * Whichever it is, both runs of a comparison print it the same way, which is all
 * the gate needs.
 *
 * English output only, and deliberately not more: the runner translates these
 * words with the machine's UI language and no other language has been measured.
 * An output this does not recognise answers null, and the gate then speaks about
 * the exit code alone rather than about tests it invented.
 */
const DOTNET_SUMMARY =
  /^(?:Passed|Failed)!\s+-\s+Failed:\s+\d+, Passed:\s+\d+, Skipped:\s+\d+, Total:\s+(\d+)/;
/** `Failed!  - Failed: …` is the summary, not a test: the space after the word tells them apart. */
const DOTNET_FAILURE = /^Failed\s+(.+?)\s+\[[^\]]*\]$/;

const dotnetReader: Reader = {
  name: "dotnet",
  read: (text) => {
    const lines = text.split("\n").map((line) => line.trim());
    const totals = lines
      .map((line) => DOTNET_SUMMARY.exec(line))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]));
    // Without a summary line the run never reached the runner - a build error,
    // or a project with no test assembly - and nothing here may be claimed.
    if (totals.length === 0) return null;
    const failed = lines
      .map((line) => DOTNET_FAILURE.exec(line))
      .filter((match) => match !== null)
      .map((match) => match[1]);
    return {
      failed: [...new Set(failed)],
      total: totals.reduce((sum, count) => sum + count, 0),
    };
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
 * Jest. Measured 2026-09-25 against real failing runs of Jest 30.5, output
 * piped the way Aime runs it (all of it on stderr, colours only inside the code
 * frames): each test file opens with `FAIL <file>` or `PASS <file>`, each
 * failure under it is `● <describe> › <test>`, and the run ends with
 * `Tests:       3 failed, 3 passed, 6 total`.
 *
 * A failure is named after its file as well, `src/cart.test.js › cart ›
 * rounds to cents`: Jest's own bullet line carries only the describe path, and
 * two files with a test of the same name are two tests. A file that does not
 * even load answers `● Test suite failed to run`, which is kept - under its file
 * - because a change that breaks an import breaks every test in that file.
 */
const JEST_TOTAL = /^Tests:\s+.*?(\d+) total$/;
const JEST_FILE = /^(?:FAIL|PASS)\s+(\S+)/;
const JEST_FAILURE = /^●\s+(.+)$/;

const jestReader: Reader = {
  name: "jest",
  read: (text) => {
    const lines = text.split("\n").map((line) => line.trim());
    const summary = lines.map((line) => JEST_TOTAL.exec(line)).find((match) => match !== null);
    if (summary === undefined) return null;
    const failed: string[] = [];
    let file = "";
    for (const line of lines) {
      const opened = JEST_FILE.exec(line);
      if (opened !== null) {
        file = opened[1];
        continue;
      }
      const failure = JEST_FAILURE.exec(line);
      if (failure !== null) failed.push(file === "" ? failure[1] : `${file} › ${failure[1]}`);
    }
    return { failed: [...new Set(failed)], total: Number(summary[1]) };
  },
};

/**
 * Playwright Test. Measured 2026-09-25 against real failing runs of 1.63 with
 * the list, line, dot and html reporters, piped: whichever reporter runs, the
 * output opens with `Running 6 tests using 2 workers` and closes on the same
 * epilogue -
 *
 *     4 failed
 *       [chromium] › tests\cart.spec.ts:4:7 › cart › rounds to cents ──────
 *     1 flaky
 *       [chromium] › tests\flaky.spec.ts:2:5 › sometimes fails ────────────
 *     2 passed (4.2s)
 *
 * Only the lines under `failed` are failures: a flaky test passed on a retry,
 * and blocking a change on it would blame the change for the test. The name
 * keeps the project and the title path but drops the `:line:col`, because a
 * change that adds a test above another one moves it, and the gate compares
 * names across the two runs.
 */
const PLAYWRIGHT_RUNNING = /^Running (\d+) tests? using \d+ workers?/;
const PLAYWRIGHT_HEADING = /^\d+ (failed|flaky|skipped|passed|did not run|interrupted)\b/;
const PLAYWRIGHT_LOCATION = /(\S):\d+:\d+ › /;

const playwrightReader: Reader = {
  name: "playwright",
  read: (text) => {
    const lines = text.split("\n").map((line) => line.trim());
    const running = lines.map((line) => PLAYWRIGHT_RUNNING.exec(line)).find((match) => match !== null);
    if (running === undefined || !lines.some((line) => PLAYWRIGHT_HEADING.test(line))) return null;
    const failed: string[] = [];
    let section = "";
    for (const line of lines) {
      const heading = PLAYWRIGHT_HEADING.exec(line);
      if (heading !== null) {
        section = heading[1];
      } else if (section === "failed" && line.includes(" › ")) {
        failed.push(line.replace(/[\s─]+$/, "").replace(PLAYWRIGHT_LOCATION, "$1 › "));
      } else if (line !== "") {
        section = "";
      }
    }
    return { failed: [...new Set(failed)], total: Number(running[1]) };
  },
};

/**
 * pytest. Measured 2026-09-25 against real runs of pytest 9.1, default and
 * `-q`: failures are listed under "short test summary info" as `FAILED
 * tests/test_cart.py::TestDiscount::test_never_negative - assert -1 >= 0`, a
 * fixture that broke as `ERROR <node id> - …`, a file that does not import as a
 * bare `ERROR <file>`, and the run ends with `4 failed, 2 passed, 1 skipped,
 * 1 error in 0.14s` - framed by `=` in the default output, bare under `-q`.
 *
 * The node id is kept to its closing bracket - a parametrised test is
 * `test_amounts[2]` - and the reason after ` - ` is dropped: it is the
 * assertion's text, which a fix changes without the test being any different.
 * Deselected tests did not run and are not counted.
 */
const PYTEST_SUMMARY = /^=*\s*((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s\b/;
const PYTEST_NOTHING = /^=*\s*no tests ran in [\d.]+s\b/;
const PYTEST_FAILURE = /^(?:FAILED|ERROR) ([^\s[]+(?:\[[^\]]*\])?)/;
const PYTEST_COUNTED = new Set(["failed", "passed", "skipped", "error", "errors", "xfailed", "xpassed"]);

const pytestReader: Reader = {
  name: "pytest",
  read: (text) => {
    const lines = text.split("\n").map((line) => line.trim());
    if (lines.some((line) => PYTEST_NOTHING.test(line))) return { failed: [], total: 0 };
    const summary = lines.map((line) => PYTEST_SUMMARY.exec(line)).find((match) => match !== null);
    if (summary === undefined) return null;
    const total = summary[1]
      .split(", ")
      .map((part) => part.split(" "))
      .filter(([, word]) => PYTEST_COUNTED.has(word))
      .reduce((sum, [count]) => sum + Number(count), 0);
    const failed = lines
      .map((line) => PYTEST_FAILURE.exec(line))
      .filter((match) => match !== null)
      .map((match) => match[1]);
    return { failed: [...new Set(failed)], total };
  },
};

/**
 * In the order they are tried. Cargo first because its `test result:` line is
 * unmistakable; a reader that is unsure answers null and lets the next look.
 * The summaries do not overlap - Jest's `Tests:` has a colon where Vitest's
 * `Tests` has none, pytest's `FAILED` is not Vitest's `FAIL ` - so the order
 * decides nothing between them.
 */
const READERS: Reader[] = [
  cargoReader,
  dotnetReader,
  vitestReader,
  jestReader,
  playwrightReader,
  pytestReader,
];
