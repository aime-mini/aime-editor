import { describe, expect, it } from "vitest";
import {
  casesWithoutProof,
  parseBrief,
  parsePlan,
  parseReview,
  parseSolution,
  parseSurvey,
  parseTestCases,
  uncoveredCases,
  uncoveredCriteria,
} from "./aiRun";

const BRIEF_REPLY = `\`\`\`json
{"goal": "Keep the chosen language after a reload",
 "criteria": [{"id": "AC1", "text": "The picker still shows Vietnamese after a reload"},
              {"id": "AC2", "text": "The choice survives a new sign-in"}],
 "questions": [{"text": "Should it follow the browser language first?", "blocking": false}]}
\`\`\``;

const PLAN_REPLY = `{"steps": [{"what": "Persist the choice", "files": ["src/i18n/index.ts"], "criteria": ["AC1"]}],
 "tests": [{"name": "keeps Vietnamese after a reload", "file": "src/i18n/index.test.ts", "case": "TC1"}]}`;

const CASES_REPLY = `{"cases": [
  {"id": "TC1", "criterion": "AC1", "prove": "drive the running app: switch language, reload, read the picker",
   "given": "Vietnamese is chosen", "when": "the app is reloaded",
   "then": "the picker still reads Vietnamese"}]}`;

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
  it("reads the steps and the test that will prove each case", () => {
    const plan = parsePlan(PLAN_REPLY);
    expect(plan?.steps[0].files).toEqual(["src/i18n/index.ts"]);
    expect(plan?.tests[0].case).toBe("TC1");
  });

  it("answers null when there is nothing to do", () => {
    expect(parsePlan('{"steps": [], "tests": []}')).toBeNull();
    expect(parsePlan("let me think about it")).toBeNull();
  });
});

describe("parseSurvey", () => {
  it("keeps the files and the conventions it read out of the code", () => {
    const survey = parseSurvey(
      `{"files": ["src/i18n/index.ts", "not a path", "src/i18n/index.ts"],
        "patterns": ["state lives in a zustand store - src/stores/git.ts", ""],
        "testsLiveIn": "beside the file as <name>.test.ts, run by vitest"}`,
    );
    // Deduplicated, and a sentence about a path is not a path.
    expect(survey?.files).toEqual(["src/i18n/index.ts"]);
    expect(survey?.patterns).toEqual(["state lives in a zustand store - src/stores/git.ts"]);
    expect(survey?.testsLiveIn).toMatch(/vitest/);
  });

  it("answers null when nothing nameable came back, so the phase stops", () => {
    expect(parseSurvey('{"files": [], "patterns": ["lots of opinions"]}')).toBeNull();
    expect(parseSurvey("I would probably start with the login screen")).toBeNull();
  });

  it("reads the test commands found for a project that declares none", () => {
    // The commands are claims until Aime has run them - but a claim without a
    // command is nothing at all, and a missing dir means the root.
    const survey = parseSurvey(
      `{"files": ["src/x.ts"],
        "suites": [{"command": "make test", "dir": "."}, {"command": "gradle test", "dir": "app"},
                   {"command": "", "dir": "app"}]}`,
    );
    expect(survey?.suites).toEqual([
      { command: "make test", dir: "." },
      { command: "gradle test", dir: "app" },
    ]);
    // And an answer that says nothing about suites is an empty list, not a crash.
    expect(parseSurvey('{"files": ["src/x.ts"]}')?.suites).toEqual([]);
  });
});

describe("parseSolution", () => {
  const REPLY = `{"how": "store the language on the profile row and read it at sign-in",
    "why": "it has to survive a new sign-in, which localStorage cannot do",
    "decisions": ["the language column goes on the profile row"]}`;

  it("reads the one way it decided on, and what that locks in", () => {
    const solution = parseSolution(REPLY);
    expect(solution?.how).toMatch(/profile row/);
    expect(solution?.why).toMatch(/sign-in/);
    expect(solution?.decisions).toEqual(["the language column goes on the profile row"]);
  });

  it("refuses a way with no reason behind it", () => {
    expect(parseSolution(REPLY.replace(/"why": "[^"]*"/, '"why": ""'))).toBeNull();
  });

  it("refuses a reason with no way to carry it out", () => {
    expect(parseSolution(REPLY.replace(/"how": "[^"]*"/, '"how": ""'))).toBeNull();
  });
});

describe("parseTestCases", () => {
  it("reads a case as a tester writes one", () => {
    const cases = parseTestCases(CASES_REPLY);
    expect(cases?.cases[0]).toMatchObject({ id: "TC1", criterion: "AC1" });
    expect(cases?.cases[0].prove).toMatch(/running app/);
    expect(cases?.cases[0].then).toMatch(/Vietnamese/);
  });

  it("drops a case with no action or no expected result", () => {
    // Nothing could be written from it and nothing could fail it, so it is not
    // a case - and keeping it would inflate the count the report is judged on.
    const half = parseTestCases(
      '{"cases": [{"id": "TC1", "criterion": "AC1", "when": "reload", "then": ""}]}',
    );
    expect(half).toBeNull();
  });

  it("numbers a case the model forgot to number, so a plan can place it", () => {
    const cases = parseTestCases('{"cases": [{"criterion": "AC1", "when": "a", "then": "b"}]}');
    // Unnumbered, but still citable - a case no test can name is unusable.
    expect(cases?.cases[0].id).toBe("TC1");
  });
});

describe("uncoveredCriteria", () => {
  it("refuses a case list that quietly drops a criterion", () => {
    const brief = parseBrief(BRIEF_REPLY);
    const cases = parseTestCases(CASES_REPLY);
    expect(brief && cases).toBeTruthy();
    if (!brief || !cases) return;
    // AC2 has no case, and this is the mechanical half of "the tests cover the
    // requirement" - the half a machine can actually check.
    expect(uncoveredCriteria(brief, cases).map((one) => one.id)).toEqual(["AC2"]);
  });
});

describe("uncoveredCases", () => {
  it("refuses a plan that leaves an agreed case with nowhere to be proved", () => {
    const cases = parseTestCases(
      CASES_REPLY.replace(
        "]}",
        ', {"id": "TC2", "criterion": "AC2", "prove": "a unit test", "given": "g", "when": "w", "then": "t"}]}',
      ),
    );
    const plan = parsePlan(PLAN_REPLY);
    expect(cases && plan).toBeTruthy();
    if (!cases || !plan) return;
    expect(uncoveredCases(cases, plan).map((one) => one.id)).toEqual(["TC2"]);
  });

  it("passes a plan that places every case", () => {
    const cases = parseTestCases(CASES_REPLY);
    const plan = parsePlan(PLAN_REPLY);
    expect(cases && plan).toBeTruthy();
    if (!cases || !plan) return;
    expect(uncoveredCases(cases, plan)).toEqual([]);
  });
});

describe("casesWithoutProof", () => {
  it("hands back the case that never said how it would be checked", () => {
    const mixed = parseTestCases(
      CASES_REPLY.replace(
        "]}",
        ', {"id": "TC2", "criterion": "AC2", "given": "g", "when": "w", "then": "t"}]}',
      ),
    );
    expect(mixed).toBeTruthy();
    if (!mixed) return;
    // Aime no longer guesses the check from a file path; the case has to say.
    expect(casesWithoutProof(mixed).map((one) => one.id)).toEqual(["TC2"]);
  });

  it("passes a case that names its own check", () => {
    const proved = parseTestCases(CASES_REPLY);
    expect(proved).toBeTruthy();
    if (!proved) return;
    expect(casesWithoutProof(proved)).toEqual([]);
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
