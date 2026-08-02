import { describe, expect, it } from "vitest";
import { activeMention, applyMention } from "./mentions";
import { hasReadme, startersFor, type StarterContext } from "./aiStarters";

describe("activeMention", () => {
  it("finds a mention being typed at the cursor", () => {
    expect(activeMention("look at @edit", 13)).toEqual({ start: 8, end: 13, query: "edit" });
  });

  it("finds a bare @ so the picker opens on the first keystroke", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("ignores an @ glued to a word - emails and decorators are not mentions", () => {
    expect(activeMention("write to me@example.com", 23)).toBeNull();
    expect(activeMention("the @Override annotation", 24)).toBeNull();
  });

  it("ends the mention at whitespace", () => {
    expect(activeMention("@src/app.ts and then", 20)).toBeNull();
  });

  it("looks only at what is left of the cursor", () => {
    expect(activeMention("@app more text", 4)).toEqual({ start: 0, end: 4, query: "app" });
  });

  it("has no mention in plain text", () => {
    expect(activeMention("explain this project", 20)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the query with the path and leaves the cursor after it", () => {
    const mention = activeMention("look at @edit", 13);
    if (mention === null) throw new Error("no mention to apply");
    const result = applyMention("look at @edit", mention, "src/components/EditorPane.tsx");
    expect(result.text).toBe("look at @src/components/EditorPane.tsx ");
    expect(result.cursor).toBe(result.text.length);
  });

  it("keeps whatever followed the cursor", () => {
    const mention = activeMention("@ed and explain", 3);
    if (mention === null) throw new Error("no mention to apply");
    const result = applyMention("@ed and explain", mention, "src/app.ts");
    expect(result.text).toBe("@src/app.ts  and explain");
    expect(result.cursor).toBe("@src/app.ts ".length);
  });
});

const context = (patch: Partial<StarterContext> = {}): StarterContext => ({
  openFileName: null,
  changedFiles: 0,
  hasTests: false,
  hasReadme: true,
  ...patch,
});

describe("startersFor", () => {
  it("puts the open file first, because that is what the user is looking at", () => {
    const [first] = startersFor(context({ openFileName: "cart.ts" }));
    expect(first).toEqual({
      key: "ai.starter.explainFile",
      promptKey: "ai.starter.explainFile.prompt",
      params: { file: "cart.ts" },
    });
  });

  it("offers a review only when there is something uncommitted", () => {
    const keys = startersFor(context({ changedFiles: 3 })).map((s) => s.key);
    expect(keys).toContain("ai.starter.reviewChanges");
    expect(startersFor(context()).map((s) => s.key)).not.toContain("ai.starter.reviewChanges");
  });

  it("offers to write tests only for a project that can run them", () => {
    const withTests = startersFor(context({ openFileName: "cart.ts", hasTests: true }));
    expect(withTests.map((s) => s.key)).toContain("ai.starter.testFile");
    const without = startersFor(context({ openFileName: "cart.ts" }));
    expect(without.map((s) => s.key)).not.toContain("ai.starter.testFile");
  });

  it("offers a README only to a project without one", () => {
    expect(startersFor(context({ hasReadme: false })).map((s) => s.key)).toContain("ai.starter.writeReadme");
    expect(startersFor(context()).map((s) => s.key)).not.toContain("ai.starter.writeReadme");
  });

  it("always has something to offer, and never a wall of it", () => {
    const empty = startersFor(context());
    expect(empty.length).toBeGreaterThan(0);
    const everything = startersFor(context({ openFileName: "a.ts", changedFiles: 2, hasTests: true }));
    expect(everything).toHaveLength(4);
  });
});

describe("hasReadme", () => {
  it("recognizes the usual spellings, at the root or not", () => {
    expect(hasReadme(["src/app.ts", "README.md"])).toBe(true);
    expect(hasReadme(["docs/readme.txt"])).toBe(true);
    expect(hasReadme(["Readme"])).toBe(true);
  });

  it("is not fooled by a file that merely mentions it", () => {
    expect(hasReadme(["src/readme-parser.ts", "READMEs.md"])).toBe(false);
  });
});
