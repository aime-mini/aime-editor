import { describe, expect, it } from "vitest";
import type { Brief, Plan, TestCases } from "./aiRun";
import type { CommandOutcome } from "./exec";
import type { GateVerdict } from "./regressionGate";
import { readTestOutput } from "./testReport";
import { caseOutcomes, casesProvenRed, renderTestCases } from "./testCaseFile";

const BRIEF: Brief = {
  goal: "Keep the chosen language after a reload",
  criteria: [
    { id: "AC1", text: "The picker still shows Vietnamese after a reload" },
    { id: "AC2", text: "The choice survives a new sign-in" },
  ],
  questions: [],
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
      then: "the picker still reads Vietnamese",
    },
  ],
  raw: "",
};

const PLAN: Plan = {
  steps: [],
  tests: [{ name: "keeps Vietnamese after a reload", file: "src/i18n/index.test.ts", case: "TC1" }],
  raw: "",
};

function outcome(over: Partial<CommandOutcome>): CommandOutcome {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    clipped: false,
    ...over,
  };
}

/** A verdict over one suite whose run said this. */
function verdictOf(output: string, code: number | null): GateVerdict {
  const report = readTestOutput(output, code);
  const run = { command: "npm test", report, outcome: outcome({ stdout: output, code }) };
  return {
    suites: [
      {
        id: "node.test",
        label: "npm test",
        before: run,
        after: run,
        comparison: { broken: [], alreadyBroken: report.failed, repaired: [], brokeWithoutDetail: false },
      },
    ],
    silent: [],
    blocks: false,
  };
}

const GREEN = verdictOf("test a::one ... ok\ntest result: ok. 1 passed;", 0);
const RED = verdictOf(
  "FAIL  src/i18n/index.test.ts > keeps Vietnamese after a reload\nTests  1 failed | 0 passed (1)",
  1,
);

describe("renderTestCases", () => {
  it("files each case under the criterion it proves", () => {
    const page = renderTestCases(CASES, BRIEF, "Login forgets the language");

    expect(page).toContain("# Test cases — Login forgets the language");
    expect(page).toContain("## AC1 — The picker still shows Vietnamese after a reload");
    expect(page).toContain("### TC1");
    expect(page).toContain("- **Proved by** drive the running app");
    expect(page).toContain("- **When** the app is reloaded");
  });

  it("says out loud which criterion nothing covers", () => {
    // The page a person reads must not be quieter than the gate: AC2 has no
    // case, and a heading with nothing under it is how that gets missed.
    expect(renderTestCases(CASES, BRIEF, "x")).toContain("_No case covers this criterion._");
  });

  it("keeps a case whose criterion no longer exists rather than dropping it", () => {
    const orphaned: TestCases = {
      ...CASES,
      cases: [...CASES.cases, { ...CASES.cases[0], id: "TC9", criterion: "AC7" }],
    };
    const page = renderTestCases(orphaned, BRIEF, "x");

    expect(page).toContain("## Cases with no criterion of that name");
    expect(page).toContain("### TC9 (AC7)");
  });
});

/** The full set of conditions a PASS needs, to be weakened one at a time. */
const IN_TREE = new Set(["src/i18n/index.test.ts"]);
const WAS_RED = new Set(["TC1"]);
const HAS_PROOF = new Map([["TC1", ["C:/repo/.aime/evidence/TC1.png"]]]);
const NO_PROOF = new Map<string, string[]>([["TC1", []]]);

describe("caseOutcomes", () => {
  it("calls a case proved only when every condition holds at once", () => {
    const proved = caseOutcomes(CASES, PLAN, GREEN, IN_TREE, WAS_RED, HAS_PROOF);
    expect(proved.get("TC1")).toEqual({ outcome: "passed", gap: null });
  });

  it("will not call a case proved when the test file is not in the tree", () => {
    // The planned test was never written. Everything else looks identical from
    // here - which is exactly why this is checked rather than assumed.
    const held = caseOutcomes(CASES, PLAN, GREEN, new Set(), WAS_RED, HAS_PROOF).get("TC1");
    expect(held).toEqual({ outcome: "unknown", gap: "testMissing" });
  });

  it("will not call a case proved while any suite is red", () => {
    const elsewhere = verdictOf("test a::one ... FAILED\ntest result: FAILED. 0 passed; 1 failed;", 101);
    const held = caseOutcomes(CASES, PLAN, elsewhere, IN_TREE, WAS_RED, HAS_PROOF).get("TC1");
    expect(held).toEqual({ outcome: "unknown", gap: "suitesNotGreen" });
  });

  it("will not call a case proved whose own test was never seen failing", () => {
    // Red-then-green is a per-case fact: a case whose test never failed first
    // has a test that proves nothing, however green everything is now.
    const held = caseOutcomes(CASES, PLAN, GREEN, IN_TREE, new Set(), HAS_PROOF).get("TC1");
    expect(held).toEqual({ outcome: "unknown", gap: "neverRed" });
  });

  it("will not call a case proved without an artifact from the running software", () => {
    const held = caseOutcomes(CASES, PLAN, GREEN, IN_TREE, WAS_RED, NO_PROOF).get("TC1");
    expect(held).toEqual({ outcome: "unknown", gap: "noEvidence" });
  });

  it("calls a case failed when the failing test is the one that cites it", () => {
    const held = caseOutcomes(CASES, PLAN, RED, IN_TREE, WAS_RED, HAS_PROOF).get("TC1");
    expect(held).toEqual({ outcome: "failed", gap: null });
  });

  it("says which case no test cites at all", () => {
    const unplanned: Plan = { ...PLAN, tests: [] };
    const held = caseOutcomes(CASES, unplanned, GREEN, new Set(), WAS_RED, HAS_PROOF).get("TC1");
    expect(held).toEqual({ outcome: "unknown", gap: "noTestPlanned" });
  });

  it("says unknown when there was no verdict to read", () => {
    const held = caseOutcomes(CASES, PLAN, null, IN_TREE, WAS_RED, HAS_PROOF).get("TC1");
    expect(held?.outcome).toBe("unknown");
  });

  it("matches a failing test by its words, not by its punctuation", () => {
    // Runners print a name the way the code spells it; a plan writes it the way
    // a person says it. Every word has to be there, so a short name cannot
    // match every test in the file.
    const spelled = verdictOf(
      ["FAIL  src/i18n/index.test.ts > i18n > keeps_vietnamese_after_a_reload", "Tests  1 failed (1)"].join(
        "\n",
      ),
      1,
    );
    expect(caseOutcomes(CASES, PLAN, spelled, IN_TREE, WAS_RED, HAS_PROOF).get("TC1")?.outcome).toBe(
      "failed",
    );

    const other = verdictOf(
      ["FAIL  src/i18n/index.test.ts > i18n > falls back to English", "Tests  1 failed (1)"].join("\n"),
      1,
    );
    expect(caseOutcomes(CASES, PLAN, other, IN_TREE, WAS_RED, HAS_PROOF).get("TC1")?.outcome).toBe("unknown");
  });
});

describe("casesProvenRed", () => {
  it("credits a case whose planned test is among the named failures", () => {
    const red = casesProvenRed(PLAN, ["src/i18n/index.test.ts > keeps Vietnamese after a reload"]);
    expect(red.has("TC1")).toBe(true);
  });

  it("credits nothing from an anonymous failure", () => {
    // A runner that names no tests can attribute nothing to any case, and an
    // empty failure list must never be read as "every case failed as planned".
    expect(casesProvenRed(PLAN, []).size).toBe(0);
    expect(casesProvenRed(PLAN, ["some unrelated words"]).size).toBe(0);
  });

  it("answers empty with no plan at all", () => {
    expect(casesProvenRed(null, ["anything"]).size).toBe(0);
  });
});
