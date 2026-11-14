import { describe, expect, it } from "vitest";
import { caseRunOf, parseCaseTests, undeclaredCases } from "./caseTests";

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
