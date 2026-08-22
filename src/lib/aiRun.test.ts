import { describe, expect, it } from "vitest";
import { parseBrief, parsePlan, parseReview, uncoveredCriteria } from "./aiRun";

const BRIEF_REPLY = `\`\`\`json
{"goal": "Keep the chosen language after a reload",
 "criteria": [{"id": "AC1", "text": "The picker still shows Vietnamese after a reload"},
              {"id": "AC2", "text": "The choice survives a new sign-in"}],
 "questions": [{"text": "Should it follow the browser language first?", "blocking": false}]}
\`\`\``;

const PLAN_REPLY = `{"steps": [{"what": "Persist the choice", "files": ["src/i18n/index.ts"], "criteria": ["AC1"]}],
 "tests": [{"name": "keeps Vietnamese after a reload", "file": "src/i18n/index.test.ts", "criterion": "AC1"}]}`;

describe("parseBrief", () => {
  it("reads the ticket the run is about to work from", () => {
    const brief = parseBrief(BRIEF_REPLY);
    expect(brief?.goal).toMatch(/language/);
    expect(brief?.criteria.map((one) => one.id)).toEqual(["AC1", "AC2"]);
    expect(brief?.questions).toEqual([
      { text: "Should it follow the browser language first?", blocking: false },
    ]);
  });

  it("numbers a criterion the model forgot to number, so a test can cite it", () => {
    const brief = parseBrief('{"goal": "g", "criteria": [{"text": "unnumbered"}]}');
    expect(brief?.criteria[0].id).toBe("AC1");
  });

  it("survives the apology a model puts in front of its JSON", () => {
    const brief = parseBrief(`Sure! Here you go:\n${PLAN_REPLY.replace("steps", "criteria")}`);
    // Not a brief: no goal. Better null than a half-read one.
    expect(brief).toBeNull();
  });

  it("answers null for prose, so the phase fails loudly instead of quietly", () => {
    expect(parseBrief("I think we should probably start by looking at the login screen.")).toBeNull();
    expect(parseBrief("")).toBeNull();
  });
});

describe("parsePlan", () => {
  it("reads the steps and the tests that will prove them", () => {
    const plan = parsePlan(PLAN_REPLY);
    expect(plan?.steps[0].files).toEqual(["src/i18n/index.ts"]);
    expect(plan?.tests[0].criterion).toBe("AC1");
  });

  it("answers null when there is nothing to do", () => {
    expect(parsePlan('{"steps": [], "tests": []}')).toBeNull();
    expect(parsePlan("let me think about it")).toBeNull();
  });
});

describe("uncoveredCriteria", () => {
  it("refuses a plan that quietly drops a criterion", () => {
    const brief = parseBrief(BRIEF_REPLY);
    const plan = parsePlan(PLAN_REPLY);
    expect(brief && plan).toBeTruthy();
    if (!brief || !plan) return;
    // AC2 has no test, and this is the mechanical half of "the tests cover
    // the requirement" - the half a machine can actually check.
    expect(uncoveredCriteria(brief, plan).map((one) => one.id)).toEqual(["AC2"]);
  });

  it("passes a plan that covers everything", () => {
    const brief = parseBrief(BRIEF_REPLY);
    const plan = parsePlan(
      PLAN_REPLY.replace(
        '"criterion": "AC1"}]',
        '"criterion": "AC1"}, {"name": "survives sign-in", "file": "a.test.ts", "criterion": "AC2"}]',
      ),
    );
    expect(brief && plan).toBeTruthy();
    if (!brief || !plan) return;
    expect(uncoveredCriteria(brief, plan)).toEqual([]);
  });
});

describe("parseReview", () => {
  it("keeps the risks it derived, not only what it found", () => {
    const review = parseReview(
      `{"risks": ["the loop issues one query per row"],
        "findings": [{"file": "src/cart.ts", "line": 12, "severity": "issue",
                      "message": "one query per line item", "check": "count queries in the cart test"}]}`,
    );
    expect(review.risks).toEqual(["the loop issues one query per row"]);
    expect(review.findings[0].severity).toBe("issue");
  });

  it("demotes an issue that cannot say how it would be proved", () => {
    // The rule that keeps a reviewer honest: an assertion with no way to check
    // it is an opinion, and an opinion is a suggestion.
    const review = parseReview(
      '{"findings": [{"file": "a.ts", "line": 1, "severity": "issue", "message": "feels wrong", "check": ""}]}',
    );
    expect(review.findings[0].severity).toBe("suggestion");
  });

  it("drops a finding with nowhere to look", () => {
    const review = parseReview(
      '{"findings": [{"severity": "issue", "message": "something is off", "check": "look"}]}',
    );
    expect(review.findings).toEqual([]);
  });

  it("treats an empty review as a real answer, unlike a brief", () => {
    const review = parseReview('{"risks": [], "findings": []}');
    expect(review.findings).toEqual([]);
    expect(review.raw).toContain("findings");
  });
});
