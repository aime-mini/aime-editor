import { describe, expect, it } from "vitest";
import type { Survey } from "./aiRun";
import { knowledgeBlock, learnFrom, parseKnowledge, renderKnowledge, type Learned } from "./projectKnowledge";

const survey = (patterns: string[], testsLiveIn = ""): Survey => ({
  files: [],
  patterns,
  testsLiveIn,
  suites: [],
  raw: "",
});

const LAYERS = "Controllers call services, never repositories - src/api/cart.controller.ts";
const TESTS = "beside the code as *.test.ts, run by vitest - src/cart.test.ts";

describe("learnFrom", () => {
  it("keeps what a run read, newest first", () => {
    const first = learnFrom([], survey([LAYERS], TESTS), "2026-10-01");
    const second = learnFrom(first, survey(["Money is an integer of cents - src/money.ts"]), "2026-10-02");
    expect(second.map((one) => one.text)).toEqual([
      "Money is an integer of cents - src/money.ts",
      LAYERS,
      TESTS,
    ]);
  });

  it("says a rule seen again once, with the newer day", () => {
    const first = learnFrom([], survey([LAYERS]), "2026-10-01");
    const again = learnFrom(first, survey([`  ${LAYERS.toUpperCase()} `]), "2026-10-05");
    expect(again).toHaveLength(1);
    expect(again[0].seen).toBe("2026-10-05");
  });

  it("replaces where tests live with the newest answer", () => {
    const first = learnFrom([], survey([], TESTS), "2026-10-01");
    const moved = learnFrom(
      first,
      survey([], "under tests/, run by pytest - tests/test_cart.py"),
      "2026-10-02",
    );
    expect(moved.filter((one) => one.kind === "tests").map((one) => one.text)).toEqual([
      "under tests/, run by pytest - tests/test_cart.py",
    ]);
  });

  it("forgets the oldest past forty", () => {
    const many: Learned[] = Array.from({ length: 40 }, (_, index) => ({
      text: `rule ${String(index)}`,
      kind: "convention",
      seen: "2026-09-01",
    }));
    const next = learnFrom(many, survey(["a new rule"]), "2026-10-01");
    expect(next).toHaveLength(40);
    expect(next[0].text).toBe("a new rule");
    expect(next.at(-1)?.text).toBe("rule 38");
  });
});

describe("parseKnowledge", () => {
  it("reads back what was written, leaving out what it cannot trust", () => {
    const text = JSON.stringify({
      version: 1,
      learned: [
        { text: LAYERS, kind: "convention", seen: "2026-10-01" },
        { text: "", kind: "convention" },
        7,
      ],
    });
    expect(parseKnowledge(text)).toEqual([{ text: LAYERS, kind: "convention", seen: "2026-10-01" }]);
    expect(parseKnowledge("not json")).toEqual([]);
  });
});

describe("what the AI is handed", () => {
  const learned = learnFrom([], survey([LAYERS], TESTS), "2026-10-01");

  it("is a page that says who writes it and where rules of one's own go", () => {
    const page = renderKnowledge(learned);
    expect(page).toContain("## How things are done here");
    expect(page).toContain(`- ${LAYERS} (2026-10-01)`);
    expect(page).toContain(`## Tests\n\n- ${TESTS} (2026-10-01)`);
    expect(page).toContain("do not edit it");
    expect(page).toContain("AGENTS.md");
  });

  it("is asked to be confirmed in the code, not taken on trust", () => {
    expect(knowledgeBlock(learned)[0]).toContain("confirm it in the code");
    expect(knowledgeBlock(learned)).toContain(`- Tests: ${TESTS}`);
    expect(knowledgeBlock([])).toEqual([]);
  });
});
