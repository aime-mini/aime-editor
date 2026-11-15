import type { TestCases } from "./aiRun";
import { runFolder } from "./runSweep";
import type { TestReport } from "./testReport";

/**
 * Each case's own test, run on its own by Aime.
 *
 * A whole suite going green says nothing about one case: the suite also
 * passes when the case's test was never written, sits in a file the runner
 * skips, or was filtered out. And a runner reports the tests that failed, not
 * the ones that passed, so the suite's output cannot say either. So the builder
 * declares, for every case, the command that runs only that case's test - a
 * file and a name filter in the project's own runner - and Aime runs each one
 * itself and reads the runner's verdict. A case is proved by a test only when
 * its own command passes having run at least one test.
 *
 * The same commands are what the "would it catch a regression" check runs
 * with the change taken out.
 */

/** The command that runs one case's own test, as the builder declared it. */
export interface CaseTest {
  case: string;
  command: string;
  /** Where it runs, relative to the run's root. */
  dir: string;
}

/** Where the builder declares them. */
export function caseTestsFileOf(root: string, runId: string): string {
  return `${runFolder(root, runId)}/case-tests.json`;
}

/** The declared commands; an unreadable file declares none. */
export function parseCaseTests(text: string): CaseTest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const tests = (parsed as { tests?: unknown }).tests;
  if (!Array.isArray(tests)) return [];
  return tests.flatMap((entry: unknown) => {
    const row = (entry ?? {}) as { case?: unknown; command?: unknown; dir?: unknown };
    if (typeof row.case !== "string" || typeof row.command !== "string" || row.command.trim() === "")
      return [];
    return [
      {
        case: row.case,
        command: row.command,
        dir: typeof row.dir === "string" && row.dir !== "" ? row.dir : ".",
      },
    ];
  });
}

/** The agreed cases no declared command runs. */
export function undeclaredCases(cases: TestCases, declared: readonly CaseTest[]): string[] {
  return cases.cases.map((one) => one.id).filter((id) => !declared.some((test) => test.case === id));
}

/** What running one case's own test showed. */
export interface CaseRun {
  /** Its command passed and ran at least one test - or passed where the runner does not say how many. */
  held: boolean;
  /** How many tests the runner said it ran; null when its output does not say. */
  ran: number | null;
}

/**
 * Whether a case's own run proves it. A runner that ran nothing exits green
 * too, so "zero tests" is a failure here; a runner whose count no reader can
 * find is believed on its exit, as the suites are.
 */
export function caseRunOf(report: TestReport): CaseRun {
  return { held: report.passed && report.total !== 0, ran: report.total };
}

/** The prompt line that asks the builder to declare the commands. */
export function declareCaseTestsRule(root: string, runId: string): string {
  return `Also write ${caseTestsFileOf(root, runId)}, naming for every case the command that runs ONLY that
case's test - a file filter and a test-name filter in this project's own runner:
{"tests": [{"case": "TC1", "command": "npx vitest run src/cart.test.ts -t \\"rounds to two places\\"", "dir": "."}]}
Aime runs each command on its own and reads the runner's verdict; a case whose command runs no test, or
fails, is not proved.`;
}

/**
 * The command that re-runs only the tests a repair round is mending.
 *
 * A round that mends two broken tests would otherwise pay for their whole
 * suites to learn whether the fix worked - minutes for a browser suite, every
 * round. So the builder names those tests in the project's own runner, the way
 * it names each case's test, and Aime runs that first. Only a run that holds
 * sends the work on to the suites, and then straight to the full pass that
 * catches a fix which broke something elsewhere.
 */
export interface Rerun {
  command: string;
  /** Where it runs, relative to the run's root. */
  dir: string;
}

/** Where the builder declares it; emptied before each repair turn so an old one is never taken. */
export function rerunFileOf(root: string, runId: string): string {
  return `${runFolder(root, runId)}/rerun.json`;
}

/** The declared command; null when there is none or it cannot be read. */
export function parseRerun(text: string): Rerun | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const row = (parsed ?? {}) as { command?: unknown; dir?: unknown };
  if (typeof row.command !== "string" || row.command.trim() === "") return null;
  return { command: row.command, dir: typeof row.dir === "string" && row.dir !== "" ? row.dir : "." };
}

/** What re-running the mended tests on their own showed. */
export type RerunVerdict =
  /** They ran and passed: the suites are next. */
  | { kind: "held" }
  /** The runner named tests that still fail: the evidence for the next repair, no suite needed. */
  | { kind: "failing"; failed: string[] }
  /** It selected nothing, or failed without naming a test: only the suites can say. */
  | { kind: "unread" };

/**
 * Reads a re-run the way a case's own run is read (`caseRunOf`). A failure
 * counts only when the runner named the failing tests: a command that broke
 * for its own reasons - a wrong filter, a missing runner - says nothing about
 * the fix, and must not end a run that the suites would have passed.
 */
export function rerunVerdictOf(report: TestReport): RerunVerdict {
  if (caseRunOf(report).held) return { kind: "held" };
  if (!report.passed && report.failed.length > 0) return { kind: "failing", failed: report.failed };
  return { kind: "unread" };
}

/** The prompt line that asks the builder to declare the re-run. */
export function declareRerunRule(root: string, runId: string): string {
  return `When the fix is in, write ${rerunFileOf(root, runId)} with the one command that runs ONLY the
tests named above - a file filter and a test-name filter in this project's own runner - and the
folder it runs in:
{"command": "npx vitest run src/cart.test.ts -t \\"rounds to two places\\"", "dir": "."}
Aime runs it before the suites, which run only once it passes.`;
}
