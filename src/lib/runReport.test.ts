import { describe, expect, it } from "vitest";
import type { Brief, Plan, Solution, TestCases } from "./aiRun";
import { newRun, type Run } from "./runPlan";
import { isEvidence, renderReport } from "./runReport";
import type { CaseVerdict } from "./testCaseFile";

const RUN: Run = { ...newRun("run-1", "42", "Login forgets the language", 0), branch: "bugfix/42-login" };

const BRIEF: Brief = {
  goal: "Keep the chosen language after a reload",
  criteria: [{ id: "AC1", text: "The picker still shows Vietnamese after a reload" }],
  questions: [{ text: "Follow the browser language first?", blocking: true }],
  raw: "",
};

const SOLUTION: Solution = {
  how: "store the language on the profile row and read it at sign-in",
  why: "it has to survive a new sign-in, which localStorage cannot do",
  decisions: ["the language column goes on the profile row"],
  needsDeploy: true,
  raw: "",
};

const CASES: TestCases = {
  cases: [
    {
      id: "TC1",
      criterion: "AC1",
      prove: "drive the running app: switch language, reload, read the picker",
      given: "Vietnamese is chosen",
      when: "the app is reloaded",
      then: "the picker still reads Vietnamese | not English",
    },
  ],
  raw: "",
};

const PLAN: Plan = {
  steps: [{ what: "persist it", files: ["src/i18n/index.ts"], criteria: ["AC1"] }],
  tests: [{ name: "keeps Vietnamese", file: "src/i18n/index.test.ts", case: "TC1" }],
  raw: "",
};

function reportOf(verdict: CaseVerdict, evidence: string[] = [], evidenceRequired = true): string {
  return renderReport({
    run: RUN,
    brief: BRIEF,
    solution: SOLUTION,
    cases: CASES,
    plan: PLAN,
    review: null,
    verdict: null,
    outcomes: new Map<string, CaseVerdict>([["TC1", verdict]]),
    evidence,
    evidenceRequired,
  });
}

const PASSED: CaseVerdict = { outcome: "passed", gap: null };
const FAILED: CaseVerdict = { outcome: "failed", gap: null };

describe("renderReport", () => {
  it("is a table of cases against results, which is what a tester signs", () => {
    const page = reportOf(PASSED);

    expect(page).toContain("| Case | Criterion | Then | Proved by | Test | Result |");
    expect(page).toContain("| TC1 | AC1 |");
    expect(page).toContain("src/i18n/index.test.ts");
    expect(page).toContain("PASS");
  });

  it("writes an unproved case as unproven, naming the condition it is missing", () => {
    // The cell itself, not the legend below the table - and the reason, because
    // "unproven" alone leaves the reader to guess which of five conditions failed.
    const page = reportOf({ outcome: "unknown", gap: "noEvidence" });
    expect(page).toContain("| unproven — no artifact from the running software names it |");
    expect(page).not.toContain("| PASS |");

    expect(reportOf({ outcome: "unknown", gap: "suitesNotGreen" })).toContain(
      "| unproven — a suite is red |",
    );
  });

  it("says what PASS meant in this run, and never more than that", () => {
    // A change that was never deployed has no running software to photograph,
    // so printing the longer set of conditions would be the report claiming a
    // check nobody made.
    expect(reportOf(PASSED, [], true)).toContain("an artifact made against the running software");
    const suitesOnly = reportOf(PASSED, [], false);
    expect(suitesOnly).toContain("needed no deployment to be believed");
    expect(suitesOnly).not.toContain("an artifact made against the running software");
  });

  it("escapes a pipe, which would otherwise split the row it sits in", () => {
    // The case text is somebody's sentence, and a sentence with a pipe in it
    // would silently turn one row into two columns of nonsense.
    expect(reportOf(FAILED)).toContain("the picker still reads Vietnamese \\| not English");
  });

  it("says which approach was taken and what the run decided for itself", () => {
    const page = reportOf(PASSED);

    expect(page).toContain("store the language on the profile row and read it at sign-in");
    expect(page).toContain("_Why this way:_ it has to survive a new sign-in");
    expect(page).toContain("the language column goes on the profile row");
    // The assumption is the thing a reader most needs to disagree with.
    expect(page).toContain("Follow the browser language first?");
  });

  it("lists the evidence the suites left, and says nothing when there is none", () => {
    expect(reportOf(PASSED, ["C:/work/test-results/one.png"])).toContain(
      "## Evidence the suites left behind",
    );
    expect(reportOf(PASSED)).not.toContain("## Evidence");
  });

  it("renders a run that got nowhere without inventing sections", () => {
    const bare = renderReport({
      run: RUN,
      brief: null,
      solution: null,
      cases: null,
      plan: null,
      review: null,
      verdict: null,
      outcomes: new Map(),
      evidence: [],
      evidenceRequired: true,
    });

    expect(bare).toContain("# Task run — Login forgets the language");
    expect(bare).not.toContain("## Test cases");
  });
});

describe("isEvidence", () => {
  it("takes what a person can look at or a machine can re-read", () => {
    expect(isEvidence("failure-1.PNG")).toBe(true);
    expect(isEvidence("trace.zip")).toBe(true);
    expect(isEvidence("results.trx")).toBe(true);
    expect(isEvidence("index.html")).toBe(true);
  });

  it("leaves alone what is not evidence of anything", () => {
    expect(isEvidence("chromedriver.exe")).toBe(false);
    expect(isEvidence("lockfile")).toBe(false);
  });
});
