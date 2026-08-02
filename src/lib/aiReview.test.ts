import { describe, expect, it } from "vitest";
import { parseReview } from "./aiReview";

/** Shapes a CLI actually replies with, including the ones it was not asked for. */
describe("parseReview", () => {
  it("reads the array it was asked for", () => {
    const { findings } = parseReview(
      '[{"file":"src/a.ts","line":12,"severity":"issue","message":"Null is not handled."}]',
    );
    expect(findings).toEqual([
      { file: "src/a.ts", line: 12, severity: "issue", message: "Null is not handled." },
    ]);
  });

  it("survives a code fence and a sentence in front of it", () => {
    const reply =
      'Here is what I found:\n```json\n[{"file":"a.rs","line":3,"severity":"suggestion","message":"Rename this."}]\n```';
    expect(parseReview(reply).findings).toHaveLength(1);
  });

  it("treats an unknown severity as a suggestion rather than an issue", () => {
    const { findings } = parseReview('[{"file":"a","line":1,"severity":"nit","message":"Spacing."}]');
    expect(findings[0].severity).toBe("suggestion");
  });

  it("keeps a finding whose line the AI could not place", () => {
    const { findings } = parseReview('[{"file":"a","severity":"issue","message":"This file needs tests."}]');
    expect(findings[0].line).toBe(0);
  });

  it("drops entries with nothing to say", () => {
    expect(parseReview('[{"file":"a","line":1,"message":"   "}, "nonsense", null]').findings).toEqual([]);
  });

  it("an empty array means the AI found nothing", () => {
    const review = parseReview("[]");
    expect(review.findings).toEqual([]);
    expect(review.text).toBe("[]");
  });

  it("keeps prose so an unparsable answer is still shown to the user", () => {
    const review = parseReview("I could not analyse this diff.");
    expect(review.findings).toEqual([]);
    expect(review.text).toBe("I could not analyse this diff.");
  });
});
