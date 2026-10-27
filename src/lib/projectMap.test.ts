import { describe, expect, it } from "vitest";
import type { Evidence, Memory } from "./knowledge";
import {
  changesFrom,
  memoriesShown,
  outlineOf,
  parseLearned,
  parseState,
  renderState,
  studiesDue,
  studyPrompt,
  topFolders,
  type Learned,
  type LearningState,
} from "./projectMap";

const memory = (patch: Partial<Memory> & Pick<Memory, "name">): Memory => ({
  kind: "structure",
  scope: "/",
  summary: `${patch.name} summary`,
  files: [],
  updated: "2026-10-10",
  body: "",
  ...patch,
});

const FILES = [
  "package.json",
  "README.md",
  "src/main.ts",
  "src/cart/totals.ts",
  "src/cart/discount.ts",
  "api/server.ts",
  ".aime/memory/x.md",
];
const NOTHING_LEFT: LearningState = { pending: [], considered: ["api", "src"] };
/** Nothing cited has changed since any memory was written. */
const untouched: Evidence = { changed: () => 0, written: () => 1 };

describe("what is due", () => {
  it("studies the whole project first when it was never studied", () => {
    expect(
      studiesDue({ files: FILES, memories: [], evidence: untouched, state: { pending: [], considered: [] } }),
    ).toEqual(["/"]);
  });

  it("has nothing to do once the whole and every named part are studied and unchanged", () => {
    const memories = [memory({ name: "overview" }), memory({ name: "cart", scope: "src/cart" })];
    expect(studiesDue({ files: FILES, memories, evidence: untouched, state: NOTHING_LEFT })).toEqual([]);
  });

  it("goes on with the parts a stopped run left waiting", () => {
    const memories = [memory({ name: "overview" })];
    const state = { pending: ["src/cart", "api"], considered: ["api", "src"] };
    expect(studiesDue({ files: FILES, memories, evidence: untouched, state })).toEqual(["src/cart", "api"]);
  });

  it("studies again a part whose cited code changed, and only that part", () => {
    const memories = [
      memory({ name: "overview", files: ["package.json"] }),
      memory({ name: "cart", scope: "src/cart", files: ["src/cart/totals.ts"] }),
    ];
    const evidence: Evidence = {
      changed: (file) => (file === "src/cart/totals.ts" ? 5 : 0),
      written: () => 1,
    };
    expect(studiesDue({ files: FILES, memories, evidence, state: NOTHING_LEFT })).toEqual(["src/cart"]);
  });

  it("studies the whole again when a top-level folder appeared that no study has seen", () => {
    const memories = [memory({ name: "overview" })];
    const state = { pending: [], considered: ["src"] };
    expect(studiesDue({ files: FILES, memories, evidence: untouched, state })).toEqual(["/"]);
  });

  it("counts a folder a studied part lives in as seen, so a re-clone does not study the whole again", () => {
    // The state file is not mirrored; the memories are.
    const memories = [
      memory({ name: "overview" }),
      memory({ name: "cart", scope: "src/cart" }),
      memory({ name: "api", scope: "api" }),
    ];
    expect(
      studiesDue({ files: FILES, memories, evidence: untouched, state: { pending: [], considered: [] } }),
    ).toEqual([]);
  });

  it("skips a waiting part whose folder is gone", () => {
    const memories = [memory({ name: "overview" })];
    const state = { pending: ["old/module", "api"], considered: ["api", "src"] };
    expect(studiesDue({ files: FILES, memories, evidence: untouched, state })).toEqual(["api"]);
  });
});

describe("the outline a study plans from", () => {
  it("counts files per folder, keeps a folder next to what is inside it, and leaves tooling out", () => {
    expect(outlineOf([...FILES, "src-legacy/old.ts"])).toBe(
      [
        "Files at the top: README.md, package.json",
        "api/ - 1 files",
        "src/ - 3 files",
        "src/cart/ - 2 files",
        "src-legacy/ - 1 files",
      ].join("\n"),
    );
  });

  it("keeps the shallowest folders when a large repository would make it long", () => {
    const files = Array.from({ length: 400 }, (_, i) => `pkg/m${String(i).padStart(3, "0")}/src/x.ts`);
    const outline = outlineOf(files).split("\n");
    expect(outline[0]).toBe("pkg/ - 400 files");
    expect(outline.at(-1)).toMatch(/^… and \d+ deeper folders$/);
    expect(outline.length).toBeLessThanOrEqual(301);
  });

  it("names the top-level folders, tooling left out", () => {
    expect(topFolders(FILES)).toEqual(["api", "src"]);
  });
});

describe("the prompt", () => {
  it("asks a study of the whole for the parts, and tells it which are done", () => {
    const prompt = studyPrompt({
      scope: "/",
      outline: "src/ - 3 files",
      known: [],
      evidence: untouched,
      studied: ["api"],
    });
    expect(prompt).toContain('"parts"');
    expect(prompt).toContain("do not name them again: api");
    expect(prompt).toContain("change nothing: do not edit files");
  });

  it("keeps a study of one part to that part, with what is remembered about it", () => {
    const known = [memory({ name: "cart", scope: "src/cart", summary: "The cart totals orders" })];
    const prompt = studyPrompt({
      scope: "src/cart",
      outline: "src/cart/ - 2 files",
      known,
      evidence: untouched,
      studied: [],
    });
    expect(prompt).toContain("Study one part of this project: `src/cart`");
    expect(prompt).toContain("- structure `cart` (src/cart) - The cart totals orders");
    expect(prompt).not.toContain('"parts"');
  });

  it("marks what went stale, so the study checks it", () => {
    const known = [
      memory({ name: "cart", scope: "src/cart", summary: "The cart", files: ["src/cart/totals.ts"] }),
    ];
    const changed: Evidence = { changed: () => 5, written: () => 1 };
    const prompt = studyPrompt({ scope: "src/cart", outline: "", known, evidence: changed, studied: [] });
    expect(prompt).toContain("- structure `cart` (src/cart) - The cart - STALE");
  });

  it("shows a study the memories of its folder, the user's decisions first", () => {
    const memories = [
      memory({ name: "style", kind: "convention", scope: "src/cart" }),
      memory({ name: "api", scope: "api" }),
      memory({ name: "cart", scope: "src/cart" }),
      memory({ name: "cents", kind: "decision", scope: "src" }),
      memory({ name: "rounding", kind: "decision", scope: "src/cart/totals" }),
    ];
    expect(memoriesShown(memories, "src/cart").map((one) => one.name)).toEqual(["rounding", "cart", "style"]);
  });
});

describe("a study's answer", () => {
  const day = "2026-10-10";
  const answer = (value: unknown) => `Here is what I found:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

  it("becomes memories dated today, with tidy names, scopes and paths", () => {
    const learned = parseLearned(
      answer({
        memories: [
          {
            name: "Cart Module",
            kind: "structure",
            scope: "./src/cart/",
            summary: "src/cart computes order totals",
            files: [".\\src\\cart\\totals.ts", "not a path"],
            body: "Entry: totals.ts",
          },
        ],
        forget: ["old-cart"],
      }),
      { scope: "src/cart", day },
    );
    expect(learned).toEqual({
      memories: [
        {
          name: "cart-module",
          kind: "structure",
          scope: "src/cart",
          summary: "src/cart computes order totals",
          files: ["src/cart/totals.ts"],
          updated: day,
          body: "Entry: totals.ts",
        },
      ],
      parts: [],
      forget: ["old-cart"],
    });
  });

  it("keeps the parts a study of the whole named, the root, duplicates and overlaps dropped", () => {
    // Measured on express: `test` beside `test/acceptance`, `examples` beside
    // `examples/mvc` - each folder would have been read twice.
    const learned = parseLearned(
      answer({
        memories: [{ name: "overview", kind: "structure", scope: "/", summary: "A shop" }],
        parts: ["src/cart/", "/", "api", "src/cart", "src", "api/v1", "web"],
      }),
      { scope: "/", day },
    );
    expect(learned?.parts).toEqual(["src/cart", "api", "web"]);
  });

  it("drops what a study may not write: a decision, a memory outside the part, one without a summary", () => {
    const learned = parseLearned(
      answer({
        memories: [
          { name: "cart", kind: "structure", scope: "src/cart", summary: "The cart" },
          { name: "money", kind: "decision", scope: "src/cart", summary: "Cents" },
          { name: "api", kind: "convention", scope: "api", summary: "REST" },
          { name: "empty", kind: "pitfall", scope: "src/cart", summary: "" },
        ],
      }),
      { scope: "src/cart", day },
    );
    expect(learned?.memories.map((one) => one.name)).toEqual(["cart"]);
  });

  it("is not an answer without the structure memory of the folder studied, or in prose", () => {
    const withoutStructure = answer({
      memories: [{ name: "c", kind: "convention", scope: "src/cart", summary: "x" }],
    });
    expect(parseLearned(withoutStructure, { scope: "src/cart", day })).toBeNull();
    expect(parseLearned("The cart computes totals.", { scope: "src/cart", day })).toBeNull();
  });
});

describe("what of an answer is acted on", () => {
  const day = "2026-10-11";
  const learned = (patch: Partial<Learned>): Learned => ({ memories: [], parts: [], forget: [], ...patch });
  const acted = (answer: Learned, existing: Memory[], evidence: Evidence = untouched) =>
    changesFrom({ learned: answer, existing, shown: existing, evidence, day });

  it("never rewrites or removes a decision or a piece of work", () => {
    const existing = [
      memory({ name: "money", kind: "decision", scope: "src/cart" }),
      memory({ name: "todo", kind: "work", scope: "src/cart" }),
    ];
    const answer = learned({
      memories: [memory({ name: "money", kind: "convention", scope: "src/cart" })],
      forget: ["todo"],
    });
    expect(acted(answer, existing)).toEqual({ write: [], forget: [] });
  });

  it("keeps a second structure memory of the same folder that the answer did not mention", () => {
    // A conversation may have written it; a study that says nothing about it is no reason to lose it.
    const existing = [memory({ name: "cart-flow", scope: "src/cart" })];
    const fresh = memory({ name: "cart", scope: "src/cart" });
    expect(acted(learned({ memories: [fresh] }), existing)).toEqual({ write: [fresh], forget: [] });
  });

  it("forgets only what exists, and never what the same answer writes", () => {
    const existing = [
      memory({ name: "floats", kind: "convention", scope: "src/cart" }),
      memory({ name: "cart", scope: "src/cart" }),
    ];
    const cart = memory({ name: "cart", scope: "src/cart" });
    expect(acted(learned({ memories: [cart], forget: ["floats", "ghost", "cart"] }), existing)).toEqual({
      write: [cart],
      forget: ["floats"],
    });
  });

  it("writes again a STALE memory the answer left out, which says it still holds", () => {
    const routing = memory({
      name: "routing",
      scope: "lib",
      files: ["lib/router.js"],
      updated: "2026-10-01",
    });
    const money = memory({ name: "money", kind: "decision", scope: "lib", files: ["lib/router.js"] });
    const changed: Evidence = { changed: () => 5, written: () => 1 };
    expect(
      acted(learned({ memories: [memory({ name: "lib", scope: "lib" })] }), [routing, money], changed),
    ).toEqual({
      write: [memory({ name: "lib", scope: "lib" }), { ...routing, updated: day }],
      forget: [],
    });
  });
});

describe("the state beside the memories", () => {
  it("reads back what it wrote, and reads anything else as nothing left", () => {
    const state = { pending: ["api"], considered: ["api", "src"] };
    expect(parseState(renderState(state))).toEqual(state);
    expect(parseState("not json")).toEqual({ pending: [], considered: [] });
  });
});
