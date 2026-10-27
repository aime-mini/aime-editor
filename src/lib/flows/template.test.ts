import { describe, expect, it } from "vitest";
import { fill, lookup, placeholdersIn } from "./template";

const scope = {
  outputs: {
    read: { value: { items: ["a", "b"], count: 2 }, files: ["x.ts"], summary: "two items" },
    input: { value: { text: "hi" }, files: [], summary: "hi" },
  },
  bundle: {
    text: "fix the build",
    items: [{ kind: "ticket" as const, ref: "SHOP-1" }],
    params: { env: "staging" },
  },
};

describe("templates", () => {
  it("inserts fields of earlier steps and of the run's input", () => {
    expect(fill("Found {{read.summary}}: {{read.value.count}} ({{read.value.items.1}})", scope)).toBe(
      "Found two items: 2 (b)",
    );
    expect(fill("{{input.text}} on {{input.params.env}} for {{input.items.0.ref}}", scope)).toBe(
      "fix the build on staging for SHOP-1",
    );
  });

  it("renders a structure as JSON and a missing path as nothing, saying which", () => {
    expect(fill("{{read.value.items}}", scope)).toBe('[\n  "a",\n  "b"\n]');
    const missing: string[] = [];
    expect(fill("[{{nowhere.value}}|{{read.value.none}}]", scope, (path) => missing.push(path))).toBe("[|]");
    expect(missing).toEqual(["nowhere.value", "read.value.none"]);
    expect(lookup("read.files", scope)).toEqual(["x.ts"]);
  });

  it("lists the placeholders a text uses", () => {
    expect(placeholdersIn("{{ a.value }} and {{b.summary}} but not {single}")).toEqual([
      "a.value",
      "b.summary",
    ]);
  });
});
