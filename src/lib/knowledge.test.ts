import { describe, expect, it } from "vitest";
import {
  INDEX_FILE,
  memoryBlock,
  nameFor,
  parseMemory,
  renderIndex,
  renderMemory,
  treeOf,
  type Memory,
} from "./knowledge";

const memory = (patch: Partial<Memory> & Pick<Memory, "name">): Memory => ({
  kind: "convention",
  scope: "/",
  summary: `${patch.name} summary`,
  files: [],
  updated: "2026-09-01",
  body: "",
  ...patch,
});

const untouched = () => 0;

describe("a memory file", () => {
  const cents = memory({
    name: "money-in-cents",
    scope: "src/cart",
    summary: "Money is an integer of cents; round only in money.ts",
    files: ["src/money.ts", "src/cart/totals.ts"],
    updated: "2026-10-01",
    body: "Never a float.\nCurrency travels beside the amount.",
  });

  it("reads back what it wrote", () => {
    expect(parseMemory(renderMemory(cents), "money-in-cents.md")).toEqual(cents);
  });

  it("takes its name from the file when the header has none, and tidies the scope", () => {
    const parsed = parseMemory(
      "---\nkind: pitfall\nscope: ./src/api/\nsummary: retries double-charge\n---\n",
      "x.md",
    );
    expect(parsed).toMatchObject({ name: "x", scope: "src/api", files: [] });
  });

  it("is not a memory without a kind or a summary", () => {
    expect(parseMemory("# notes\n", "a.md")).toBeNull();
    expect(parseMemory("---\nkind: idea\nsummary: s\n---\n", "a.md")).toBeNull();
    expect(parseMemory("---\nkind: decision\n---\n", "a.md")).toBeNull();
  });

  it("is named from its words", () => {
    expect(nameFor("Money is an integer of cents; round only in money.ts")).toBe(
      "money-is-an-integer-of-cents",
    );
  });
});

describe("what a turn carries", () => {
  const decision = memory({
    name: "no-installs",
    kind: "decision",
    summary: "Aime never makes the user install",
  });
  const cents = memory({
    name: "cart-cents",
    scope: "src/cart",
    summary: "Prices are integer cents, never floats",
  });
  const tokens = memory({ name: "auth-tokens", scope: "src/auth", summary: "Tokens expire after an hour" });

  it("is every memory, one line each, so the AI picks by meaning rather than Aime by words", () => {
    const block = memoryBlock([decision, cents, tokens], [], untouched) ?? "";
    expect(block).toContain("## /\n- decision `no-installs` - Aime never makes the user install");
    expect(block).toContain(
      "## src/cart\n- convention `cart-cents` - Prices are integer cents, never floats",
    );
    expect(block).toContain("## src/auth\n- convention `auth-tokens`");
  });

  it("is nothing for a project that remembers nothing yet", () => {
    expect(memoryBlock([], ["src/a.ts"], untouched)).toBeNull();
  });

  it("marks a line whose evidence changed or vanished since it was written", () => {
    const cited = memory({ name: "cited", files: ["src/money.ts", "src/gone.ts"], updated: "2026-09-01" });
    const changed = (file: string) => (file === "src/money.ts" ? Date.parse("2026-09-20T10:00:00Z") : null);
    expect(memoryBlock([cited], [], changed)).toContain("STALE since 2026-09-01: src/money.ts, src/gone.ts");
  });

  it("past what a turn should carry, opens the whole project and the folders in view, and pages the rest", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      memory({ name: `m${String(index)}`, scope: ["src/cart", "src/auth", "docs"][index % 3] }),
    );
    const block = memoryBlock([decision, ...many], ["src/cart/totals.ts"], untouched) ?? "";
    expect(block).toContain("- decision `no-installs`");
    expect(block).toContain("## src/cart\n");
    expect(block).not.toContain("## src/auth\n");
    expect(block).toContain("- src/auth: 100 · .aime/memory/index/src_auth.md");
    expect(block).toContain("- docs: 100 · .aime/memory/index/docs.md");
  });
});

describe("the index", () => {
  it("is one page while it is small, grouped by folder", () => {
    const pages = renderIndex([memory({ name: "a", scope: "src" }), memory({ name: "b" })]);
    expect(pages.map((page) => page.path)).toEqual([INDEX_FILE]);
    expect(pages[0].content).toContain("## /\n- convention `b`");
    expect(pages[0].content).toContain("## src\n- convention `a`");
  });

  it("splits into a page per folder before it grows too large to read", () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      memory({ name: `m${String(index)}`, scope: index % 2 === 0 ? "src/cart" : "/" }),
    );
    const pages = renderIndex(many);
    expect(pages.map((page) => page.path)).toEqual([
      INDEX_FILE,
      ".aime/memory/index/_root.md",
      ".aime/memory/index/src_cart.md",
    ]);
    expect(pages[0].content).toContain("- src/cart: 125 · .aime/memory/index/src_cart.md");
    expect(pages[0].content).not.toContain("`m0`");
  });

  it("is a tree with the whole project at its root", () => {
    expect(
      treeOf([memory({ name: "a", scope: "src" }), memory({ name: "b" })]).map((node) => node.scope),
    ).toEqual(["/", "src"]);
  });
});
