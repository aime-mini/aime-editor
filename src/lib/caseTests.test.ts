import { describe, expect, it } from "vitest";
import { caseRunOf, parseCaseTests, parseRerun, rerunVerdictOf, undeclaredCases } from "./caseTests";

const CASES = {
  cases: [
    {
      id: "TC1",
      criterion: "AC1",
      prove: "unit test",
      given: "",
      when: "",
      then: "",
      kind: "changed" as const,
    },
    {
      id: "TC2",
      criterion: "AC1",
      prove: "unit test",
      given: "",
      when: "",
      then: "",
      kind: "changed" as const,
    },
  ],
  raw: "",
};

describe("parseCaseTests", () => {
  it("reads each case's own command, in the folder it runs from", () => {
    const text = JSON.stringify({
      tests: [
        { case: "TC1", command: 'npx vitest run src/cart.test.ts -t "rounds"', dir: "web" },
        { case: "TC2", command: "node test.cjs" },
        { case: "TC3", command: " " },
        "junk",
      ],
    });
    expect(parseCaseTests(text)).toEqual([
      { case: "TC1", command: 'npx vitest run src/cart.test.ts -t "rounds"', dir: "web" },
      { case: "TC2", command: "node test.cjs", dir: "." },
    ]);
    expect(parseCaseTests("not json")).toEqual([]);
  });
});

describe("undeclaredCases", () => {
  it("names the cases no declared command runs", () => {
    expect(undeclaredCases(CASES, [{ case: "TC1", command: "node test.cjs", dir: "." }])).toEqual(["TC2"]);
  });
});

describe("caseRunOf", () => {
  const report = (passed: boolean, total: number | null) => ({ passed, failed: [], total, reader: "vitest" });

  it("holds a case whose own command passed having run a test", () => {
    expect(caseRunOf(report(true, 3))).toEqual({ held: true, ran: 3 });
  });

  it("does not hold a case whose filter ran nothing, though the runner exited green", () => {
    expect(caseRunOf(report(true, 0)).held).toBe(false);
  });

  it("does not hold a failing run, and believes a green exit where the runner gives no count", () => {
    expect(caseRunOf(report(false, 1)).held).toBe(false);
    expect(caseRunOf(report(true, null))).toEqual({ held: true, ran: null });
  });
});

describe("parseRerun", () => {
  it("reads the declared command and its folder, and nothing from an emptied or broken file", () => {
    expect(parseRerun('{"command":"npx vitest run a.test.ts -t \\"x\\"","dir":"web"}')).toEqual({
      command: 'npx vitest run a.test.ts -t "x"',
      dir: "web",
    });
    expect(parseRerun('{"command":"npm test"}')).toEqual({ command: "npm test", dir: "." });
    expect(parseRerun("")).toBeNull();
    expect(parseRerun('{"command":"  "}')).toBeNull();
    expect(parseRerun("null")).toBeNull();
  });
});

describe("rerunVerdictOf", () => {
  const report = (passed: boolean, total: number | null, failed: string[] = []) => ({
    passed,
    failed,
    total,
    reader: "vitest",
  });

  it("holds a re-run that passed having run the tests", () => {
    expect(rerunVerdictOf(report(true, 2))).toEqual({ kind: "held" });
  });

  it("takes the failing tests the runner named as the next repair's evidence", () => {
    expect(rerunVerdictOf(report(false, 2, ["cart > rounds"]))).toEqual({
      kind: "failing",
      failed: ["cart > rounds"],
    });
  });

  /**
   * A filter that matched nothing exits green with every test skipped, and a
   * wrong command fails without naming a test; neither says anything about the
   * fix, so the suites decide instead.
   */
  it("leaves a re-run that selected nothing, or broke on its own, to the suites", () => {
    expect(rerunVerdictOf(report(true, 0))).toEqual({ kind: "unread" });
    expect(rerunVerdictOf(report(false, null))).toEqual({ kind: "unread" });
  });
});
