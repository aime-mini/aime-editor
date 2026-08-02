import { describe, expect, it } from "vitest";
import { buildCompletionPrompt, cleanCompletion, windowAround } from "./inlineCompletion";

const at = (prefix: string, suffix = "") => ({ prefix, suffix });

describe("windowAround", () => {
  it("keeps the lines nearest the cursor", () => {
    const before = Array.from({ length: 200 }, (_, i) => `before ${String(i)}`).join("\n");
    const after = Array.from({ length: 200 }, (_, i) => `after ${String(i)}`).join("\n");
    const { prefix, suffix } = windowAround(before, after);

    expect(prefix.split("\n")).toHaveLength(60);
    expect(prefix.endsWith("before 199")).toBe(true);
    expect(suffix.split("\n")).toHaveLength(20);
    expect(suffix.startsWith("after 0")).toBe(true);
  });

  it("leaves a short file whole", () => {
    expect(windowAround("a\nb", "c")).toEqual({ prefix: "a\nb", suffix: "c" });
  });
});

describe("buildCompletionPrompt", () => {
  it("marks the cursor inside the code and names the file", () => {
    const prompt = buildCompletionPrompt({
      path: "src/app.ts",
      languageId: "typescript",
      prefix: "const total = ",
      suffix: ";\n",
    });

    expect(prompt).toContain("src/app.ts (typescript)");
    expect(prompt).toContain("const total = <CURSOR>;");
  });
});

describe("cleanCompletion", () => {
  it("keeps a plain continuation as it is", () => {
    expect(cleanCompletion("items.length", at("const total = "))).toBe("items.length");
  });

  it("unwraps a markdown fence the model added anyway", () => {
    expect(cleanCompletion("```ts\nitems.length\n```", at("const total = "))).toBe("items.length");
  });

  it("drops the current line when the model retypes it", () => {
    expect(cleanCompletion("const total = items.length", at("const total = "))).toBe("items.length");
  });

  it("drops a partial echo of the current line", () => {
    expect(cleanCompletion("Name(user) {", at("function get"))).toBe("Name(user) {");
    expect(cleanCompletion("getName(user) {", at("function get"))).toBe("Name(user) {");
  });

  it("does not treat an earlier line's repetition as an echo", () => {
    expect(cleanCompletion("value + 1", at("const value = 1;\n"))).toBe("value + 1");
  });

  it("drops a tail that retypes what follows the cursor", () => {
    expect(cleanCompletion("items.length;", at("const total = ", ";\nreturn total;"))).toBe("items.length");
  });

  it("refuses prose", () => {
    expect(cleanCompletion("Sorry, I cannot complete this.", at("const x = "))).toBe("");
    expect(cleanCompletion("I can't infer what you want here", at("const x = "))).toBe("");
  });

  it("refuses an answer that leaked the marker", () => {
    expect(cleanCompletion("foo<CURSOR>bar", at("const x = "))).toBe("");
  });

  it("refuses an answer that is only the echo", () => {
    expect(cleanCompletion("const total = ", at("const total = "))).toBe("");
  });

  it("caps a suggestion that turned into a rewrite", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join("\n");
    expect(cleanCompletion(long, at("")).split("\n")).toHaveLength(12);
  });

  it("keeps indentation of the lines after the first", () => {
    expect(cleanCompletion("{\n  return 1;\n}", at("function one() "))).toBe("{\n  return 1;\n}");
  });

  it("returns nothing for an empty answer", () => {
    expect(cleanCompletion("\n\n  \n", at("const x = "))).toBe("");
  });
});
