import { describe, expect, it } from "vitest";
import type { Finding, Survey } from "./aiRun";
import { conventionsLearned, lessonsLearned } from "./runLearning";

const survey: Survey = {
  files: [],
  patterns: [
    "plain ES modules, no framework - src/checkout.js",
    "Errors go through ApiError - src/api/errors.ts",
  ],
  testsLiveIn: "test.cjs at the root, run by node",
  suites: [],
  raw: "",
};

describe("conventionsLearned", () => {
  it("files each rule under the folder of the file it was seen in", () => {
    const learned = conventionsLearned(survey, "2026-10-01");
    expect(learned[0]).toMatchObject({
      name: "plain-es-modules-no-framework",
      kind: "convention",
      scope: "src",
      summary: "plain ES modules, no framework",
      files: ["src/checkout.js"],
    });
    expect(learned[1]).toMatchObject({ scope: "src/api", files: ["src/api/errors.ts"] });
  });

  it("keeps where tests live for the whole project", () => {
    const tests = conventionsLearned(survey, "2026-10-01").at(-1);
    expect(tests).toMatchObject({
      name: "where-tests-live",
      scope: "/",
      summary: "Tests: test.cjs at the root, run by node",
    });
  });
});

describe("lessonsLearned", () => {
  it("keeps what the reviewer had fixed as a trap beside the file it was in", () => {
    const finding: Finding = {
      file: "src/api/orders.js",
      line: 6,
      severity: "issue",
      kind: "security",
      message: "SQL is built by concatenating req.params.id",
      check: "request /orders/1 OR 1=1",
    };
    expect(lessonsLearned([finding], "2026-10-01")).toEqual([
      {
        name: "sql-is-built-by-concatenating-req",
        kind: "pitfall",
        scope: "src/api",
        summary: "SQL is built by concatenating req.params.id",
        files: ["src/api/orders.js"],
        updated: "2026-10-01",
        body: "A reviewer found this (security) in a change here, and it was fixed. How it was proved: request /orders/1 OR 1=1",
      },
    ]);
  });
});
