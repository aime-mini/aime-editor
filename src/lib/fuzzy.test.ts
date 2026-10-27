import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

/** Asserts a match exists and returns its score. */
function score(query: string, target: string): number {
  const result = fuzzyScore(query, target);
  if (result === null) throw new Error(`expected "${query}" to match "${target}"`);
  return result;
}

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "GitPanel.tsx")).toBeNull();
    expect(fuzzyScore("panelg", "GitPanel")).toBeNull(); // order matters
  });

  it("is case-insensitive and matches subsequences", () => {
    expect(fuzzyScore("gitpanel", "GitPanel.tsx")).not.toBeNull();
    expect(fuzzyScore("gp", "src/components/GitPanel.tsx")).not.toBeNull();
  });

  it("ranks word-start matches above scattered ones", () => {
    expect(score("gp", "git-panel")).toBeGreaterThan(score("gp", "grape"));
  });

  it("ranks consecutive runs above gappy matches of the same letters", () => {
    expect(score("panel", "GitPanel.tsx")).toBeGreaterThan(score("panel", "p-a-n-e-l-x"));
  });

  it("prefers the shorter target on ties", () => {
    expect(score("app", "App.tsx")).toBeGreaterThan(score("app", "App.integration.test.tsx"));
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("fuzzyFilter", () => {
  const files = ["src/App.tsx", "src/components/GitPanel.tsx", "README.md", "src/stores/git.ts"];

  it("filters, ranks best-first, and honors the limit", () => {
    const results = fuzzyFilter(files, "git", (f) => f, 2);
    expect(results).toHaveLength(2);
    expect(results[0].item).toBe("src/stores/git.ts");
  });

  it("returns everything (limited) for an empty query", () => {
    expect(fuzzyFilter(files, "", (f) => f, 3)).toHaveLength(3);
  });
});
