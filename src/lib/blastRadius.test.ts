import { describe, expect, it } from "vitest";
import {
  impactOf,
  looksLikeTestFile,
  radiusFrom,
  radiusIsComplete,
  radiusOf,
  testsCovering,
  type SymbolReferences,
} from "./blastRadius";

describe("impactOf", () => {
  it("lists what uses a file, and never the file itself", () => {
    const impact = impactOf("src/cart.ts", [
      { symbol: "subtotal", files: ["src/cart.ts", "src/checkout.ts", "src/invoice.ts"] },
      { symbol: "withTax", files: ["src/cart.ts", "src/invoice.ts"] },
    ]);
    // Sorted and deduplicated: invoice.ts uses both symbols, and cart.ts uses
    // its own - a file that lists itself makes every change look far-reaching.
    expect(impact.dependents).toEqual(["src/checkout.ts", "src/invoice.ts"]);
    expect(impact.symbols).toEqual(["subtotal", "withTax"]);
    expect(impact.unknown).toBe(false);
  });

  it("says a file is unknown rather than unaffected when nothing answered", () => {
    const impact = impactOf("src/legacy.vb", []);
    expect(impact.unknown).toBe(true);
    expect(impact.dependents).toEqual([]);
  });

  it("treats the two spellings of a path as one file", () => {
    // A language server answers in whatever the OS hands it; the same file must
    // not appear as its own dependent because of a backslash.
    const impact = impactOf("src/cart.ts", [{ symbol: "subtotal", files: ["src\\Cart.ts"] }]);
    expect(impact.dependents).toEqual([]);
  });
});

describe("radiusOf", () => {
  const impacts = [
    impactOf("src/cart.ts", [{ symbol: "subtotal", files: ["src/checkout.ts", "src/cart.ts"] }]),
    impactOf("src/checkout.ts", [{ symbol: "checkout", files: ["src/api.ts"] }]),
  ];

  it("does not count a file being changed as something the change reaches", () => {
    const radius = radiusOf(impacts);
    expect(radius.changing).toEqual(["src/cart.ts", "src/checkout.ts"]);
    // checkout.ts uses cart.ts, but it is being edited too - it is not collateral.
    expect(radius.dependents).toEqual(["src/api.ts"]);
    expect(radiusIsComplete(radius)).toBe(true);
  });

  it("refuses to call a radius complete when a file could not be read", () => {
    const radius = radiusOf([...impacts, impactOf("src/legacy.vb", [])]);
    expect(radius.unknown).toEqual(["src/legacy.vb"]);
    // The distinction that matters: an empty dependent list from silence is not
    // a clean bill of health.
    expect(radiusIsComplete(radius)).toBe(false);
  });
});

describe("testsCovering", () => {
  const project = [
    "src/cart.ts",
    "src/cart.test.ts",
    "src/checkout.ts",
    "src/__tests__/checkout.spec.ts",
    "src/api.ts",
    "src/unrelated.test.ts",
  ];

  it("finds the tests named after what the change reaches", () => {
    const radius = radiusOf([impactOf("src/cart.ts", [{ symbol: "subtotal", files: ["src/checkout.ts"] }])]);
    expect(testsCovering(radius, project)).toEqual(["src/__tests__/checkout.spec.ts", "src/cart.test.ts"]);
  });

  it("leaves out tests for things the change never touches", () => {
    const radius = radiusOf([impactOf("src/api.ts", [{ symbol: "handler", files: [] }])]);
    expect(testsCovering(radius, project)).not.toContain("src/unrelated.test.ts");
  });
});

describe("radiusFrom", () => {
  /** A stand-in for the language server: answers per file, remembers the order. */
  function probe(answers: Record<string, SymbolReferences[] | null>) {
    const asked: string[] = [];
    return {
      asked,
      dependentsOf: (file: string) => {
        asked.push(file);
        return Promise.resolve(answers[file] ?? null);
      },
    };
  }

  it("asks about every file and folds the answers into one radius", async () => {
    const server = probe({
      "src/cart.ts": [{ symbol: "withTax", files: ["src/cart.ts", "src/checkout.ts"] }],
      "src/tax.ts": [{ symbol: "rate", files: ["src/cart.ts", "src/invoice.ts"] }],
    });
    const radius = await radiusFrom(["src/cart.ts", "src/tax.ts"], server);

    expect(server.asked).toEqual(["src/cart.ts", "src/tax.ts"]);
    expect(radius.changing).toEqual(["src/cart.ts", "src/tax.ts"]);
    // cart.ts references tax.ts but is being changed itself, so it is not a
    // bystander this change might break.
    expect(radius.dependents).toEqual(["src/checkout.ts", "src/invoice.ts"]);
    expect(radiusIsComplete(radius)).toBe(true);
  });

  it("does not call a file a leaf on the word of a server that never left it", async () => {
    // What a server confined to one file at a time answers, and what a project
    // where nothing depends on anything answers, are the same list of zeroes -
    // so zero is only believed once something in this radius proved the server
    // can see past the file it was handed.
    const blind = await radiusFrom(["src/cart.ts", "src/tax.ts"], {
      dependentsOf: (file) => Promise.resolve([{ symbol: "withTax", files: [file] }]),
    });
    expect(blind.dependents).toEqual([]);
    expect(blind.unknown).toEqual(["src/cart.ts", "src/tax.ts"]);
    expect(radiusIsComplete(blind)).toBe(false);

    // One dependant anywhere is that proof, and the zeroes beside it then mean
    // what they say.
    const seeing = await radiusFrom(["src/cart.ts", "src/tax.ts"], {
      dependentsOf: (file) =>
        Promise.resolve(
          file === "src/cart.ts"
            ? [{ symbol: "withTax", files: ["src/checkout.ts"] }]
            : [{ symbol: "rate", files: [file] }],
        ),
    });
    expect(seeing.dependents).toEqual(["src/checkout.ts"]);
    expect(seeing.unknown).toEqual([]);
    expect(radiusIsComplete(seeing)).toBe(true);
  });

  it("keeps a file nobody could answer for apart from a file nothing uses", async () => {
    // `cart.ts` is answered and reaches another file, which is what makes the
    // rest of this radius readable; `tax.ts` is answered and reaches nothing,
    // which now means what it says; `notes.md` has no server at all.
    const radius = await radiusFrom(["src/cart.ts", "src/tax.ts", "docs/notes.md"], {
      dependentsOf: (file) =>
        Promise.resolve(
          file === "src/cart.ts"
            ? [{ symbol: "withTax", files: ["src/checkout.ts"] }]
            : file === "src/tax.ts"
              ? [{ symbol: "rate", files: [] }]
              : null,
        ),
    });

    expect(radius.dependents).toEqual(["src/checkout.ts"]);
    expect(radius.unknown).toEqual(["docs/notes.md"]);
    // The whole point: with one file unanswered, the radius may not be read as
    // "nothing else is affected".
    expect(radiusIsComplete(radius)).toBe(false);
  });
});

describe("looksLikeTestFile", () => {
  it("knows the conventions it can name, and no others", () => {
    for (const named of [
      "src/cart.test.ts",
      "src/cart.spec.js",
      "tests/test_cart.py",
      "src/__tests__/cart.ts",
      "backend/tests/CartTests.cs",
      "src\\__tests__\\cart.ts",
    ]) {
      expect(looksLikeTestFile(named), named).toBe(true);
    }
    // `contest_results` carries "test_" in the middle of a word; a marker
    // matched anywhere in the name would claim it.
    for (const not of ["src/cart.ts", "src/testimonials.ts", "src/latest.ts", "src/contest_results.py"]) {
      expect(looksLikeTestFile(not), not).toBe(false);
    }
  });
});
