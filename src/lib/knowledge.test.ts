import { describe, expect, it } from "vitest";
import {
  INDEX_FILE,
  memoryBlock,
  nameFor,
  parseMemory,
  recall,
  renderIndex,
  renderMemory,
  treeOf,
  type Memory,
} from "./knowledge";

const TODAY = "2026-10-01";

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

describe("recall", () => {
  const decision = memory({
    name: "no-installs",
    kind: "decision",
    summary: "Aime never makes the user install",
  });
  const cart = memory({ name: "cart-cents", scope: "src/cart", summary: "Totals are cents" });
  const src = memory({ name: "api-errors", scope: "src", summary: "Every API error is an ApiError" });
  const auth = memory({ name: "auth-tokens", scope: "src/auth", summary: "Tokens expire after an hour" });
  const all = [decision, cart, src, auth];
  const names = (focus: Parameters<typeof recall>[1]) =>
    recall(all, focus, untouched, TODAY).map(({ memory: chosen }) => chosen.name);

  it("carries the person's project-wide decisions on every turn", () => {
    expect(names({ files: [], text: "" })).toEqual(["no-installs"]);
  });

  it("climbs the tree from the file in view: its folder, then the folders above it", () => {
    expect(names({ files: ["src/cart/totals.ts"], text: "" })).toEqual([
      "no-installs",
      "cart-cents",
      "api-errors",
    ]);
  });

  it("finds a memory by the rarer words of the request", () => {
    expect(names({ files: [], text: "why do tokens expire so fast?" })).toEqual([
      "no-installs",
      "auth-tokens",
    ]);
  });

  it("puts a memory about the very file above one about its folder", () => {
    const exact = memory({ name: "totals-rounding", scope: "src", files: ["src/cart/totals.ts"] });
    const chosen = recall([cart, exact], { files: ["src/cart/totals.ts"], text: "" }, untouched, TODAY);
    expect(chosen.map(({ memory: one }) => one.name)).toEqual(["totals-rounding", "cart-cents"]);
  });

  it("stops at the budget rather than cutting a memory in half", () => {
    const big = memory({ name: "big", scope: "src/cart", body: "x".repeat(500) });
    const chosen = recall([cart, big], { files: ["src/cart/a.ts"], text: "" }, untouched, TODAY, 200);
    expect(chosen.map(({ memory: one }) => one.name)).toEqual(["cart-cents"]);
  });

  it("marks a memory whose evidence changed or vanished since it was written", () => {
    const cited = memory({
      name: "cited",
      scope: "src/cart",
      files: ["src/money.ts", "src/gone.ts"],
      updated: "2026-09-01",
    });
    const changed = (file: string) => (file === "src/money.ts" ? Date.parse("2026-09-20T10:00:00Z") : null);
    const [recalled] = recall([cited], { files: ["src/cart/a.ts"], text: "" }, changed, TODAY);
    expect(recalled.stale).toEqual(["src/money.ts", "src/gone.ts"]);
    expect(memoryBlock([recalled], 1)).toContain(
      "STALE - changed or gone since 2026-09-01: src/money.ts, src/gone.ts",
    );
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
