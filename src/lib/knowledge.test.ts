import { describe, expect, it } from "vitest";
import {
  memoryBlock,
  nameFor,
  parseMemory,
  renderMemory,
  renderPages,
  treeOf,
  type Evidence,
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

const at = (iso: string) => Date.parse(iso);
/** Nothing cited has changed since any memory was written. */
const untouched: Evidence = { changed: () => 0, written: () => 0 };

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

describe("what a conversation is handed", () => {
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

  describe("a line goes STALE on the file's own time, not the day the header claims", () => {
    const cited = memory({ name: "cited", files: ["src/money.ts", "src/gone.ts"], updated: "2026-01-01" });
    const writtenAt = at("2026-09-20T10:00:00Z");

    it("when a cited file changed after the memory was written, or is gone", () => {
      const evidence: Evidence = {
        changed: (file) => (file === "src/money.ts" ? at("2026-09-20T10:05:00Z") : null),
        written: () => writtenAt,
      };
      expect(memoryBlock([cited], [], evidence)).toContain("STALE, changed since: src/money.ts, src/gone.ts");
    });

    it("not when the file changed earlier the same day, however old the header's date", () => {
      const evidence: Evidence = { changed: () => at("2026-09-20T09:55:00Z"), written: () => writtenAt };
      expect(memoryBlock([cited], [], evidence)).not.toContain("STALE, changed since");
    });
  });

  describe("past what a turn should carry", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      memory({ name: `m${String(index)}`, scope: ["src/cart", "src/auth", "docs"][index % 3] }),
    );

    it("opens the whole project and the folders in view, and pages the rest", () => {
      const block = memoryBlock([decision, ...many], ["src/cart/totals.ts"], untouched) ?? "";
      expect(block).toContain("- decision `no-installs`");
      expect(block).toContain("## src/cart\n");
      expect(block).not.toContain("## src/auth\n");
      expect(block).toContain("- src/auth: 100 · .aime/memory/index/src_auth.md");
      expect(block).toContain("- docs: 100 · .aime/memory/index/docs.md");
    });

    it("caps what it opens, keeps every decision, and sends the rest to the folder's page", () => {
      const project = Array.from({ length: 260 }, (_, index) =>
        memory({
          name: `p${String(index)}`,
          kind: index % 20 === 0 ? "decision" : "convention",
          updated: index % 2 === 0 ? "2026-09-01" : "2026-08-01",
        }),
      );
      const block = memoryBlock([...project, cents], ["src/cart/totals.ts"], untouched) ?? "";
      const lines = block.split("\n").filter((line) => line.startsWith("- "));
      expect(lines.filter((line) => line.startsWith("- decision"))).toHaveLength(13);
      expect(lines.filter((line) => /^- (decision|convention) `/.test(line))).toHaveLength(200);
      expect(block).toContain("- … 61 more in this folder · .aime/memory/index/_root.md");
      expect(block).toContain("## src/cart\n- convention `cart-cents`");
      // The newest of the rest are the ones kept.
      expect(block).toContain("`p2`");
      expect(block).not.toContain("`p259`");
    });
  });
});

describe("the pages of a large index", () => {
  it("are none while the block already lists every memory", () => {
    expect(renderPages([memory({ name: "a", scope: "src" }), memory({ name: "b" })])).toEqual([]);
  });

  it("are one per folder past the ceiling, every memory of the folder on it", () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      memory({ name: `m${String(index)}`, scope: index % 2 === 0 ? "src/cart" : "/" }),
    );
    const pages = renderPages(many);
    expect(pages.map((page) => page.path)).toEqual([
      ".aime/memory/index/_root.md",
      ".aime/memory/index/src_cart.md",
    ]);
    expect(pages[0].content).toContain("# Memories for /\n");
    expect(pages[0].content).toContain("- convention `m1`");
    expect(pages[1].content).toContain("- convention `m0`");
  });

  it("is a tree with the whole project at its root", () => {
    expect(
      treeOf([memory({ name: "a", scope: "src" }), memory({ name: "b" })]).map((node) => node.scope),
    ).toEqual(["/", "src"]);
  });
});
