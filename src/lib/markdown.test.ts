import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Block } from "./markdown";

/** The words of a block, for assertions that are about structure, not spans. */
function words(block: Block): string {
  if (block.kind === "code") return block.text;
  if (block.kind === "rule") return "";
  if (block.kind === "table")
    return [block.header, ...block.rows].map((row) => row.map((cell) => text(cell)).join(" | ")).join("\n");
  if (block.kind === "list")
    return block.items.map((item) => `${"  ".repeat(item.depth)}${text(item.spans)}`).join("\n");
  return text(block.spans);
}

function text(spans: { kind: string }[]): string {
  return spans
    .map((span) => {
      const inline = span as { kind: string; text?: string; spans?: { kind: string }[] };
      return inline.spans === undefined ? (inline.text ?? "") : text(inline.spans);
    })
    .join("");
}

describe("parseMarkdown", () => {
  it("reads the shape a work item description arrives in", () => {
    const blocks = parseMarkdown(
      ["## Steps to reproduce", "", "1. Open /login", "2. Submit", "", "It fails."].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "list", "paragraph"]);
    expect(blocks[0]).toMatchObject({ level: 2 });
    expect(blocks[1]).toMatchObject({ ordered: true });
    expect(words(blocks[1])).toBe("Open /login\nSubmit");
    expect(words(blocks[2])).toBe("It fails.");
  });

  it("keeps the line breaks inside a paragraph, because a ticket means them", () => {
    // Two sentences on two lines is how people write a report; joining them into
    // one line the way a blog renderer would loses the author's own layout.
    const [block] = parseMarkdown("Users cannot sign in.\nSince Monday.");
    expect(words(block)).toBe("Users cannot sign in.\nSince Monday.");
  });

  it("nests a list by its indentation and ends it on a change of marker", () => {
    const blocks = parseMarkdown(["- Outer", "  - Inner", "", "1. Numbered"].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["list", "list"]);
    expect(words(blocks[0])).toBe("Outer\n  Inner");
    expect(blocks[1]).toMatchObject({ ordered: true });
  });

  it("treats a fenced block as content, not as markup", () => {
    const blocks = parseMarkdown(["```ts", "# not a heading", "", "const a = 1;", "```"].join("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", language: "ts" });
    expect(words(blocks[0])).toBe("# not a heading\n\nconst a = 1;");
  });

  it("finds the quotes and the rules", () => {
    const blocks = parseMarkdown(["> quoted", "", "---"].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["quote", "rule"]);
    expect(words(blocks[0])).toBe("quoted");
  });
});

describe("parseInline", () => {
  it("marks up the words a person marked up", () => {
    expect(parseInline("**bold** and *thin* and `x=1`")).toEqual([
      { kind: "strong", spans: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " and " },
      { kind: "emphasis", spans: [{ kind: "text", text: "thin" }] },
      { kind: "text", text: " and " },
      { kind: "code", text: "x=1" },
    ]);
  });

  it("does not read bold as two empty italics", () => {
    expect(parseInline("**both**")).toEqual([{ kind: "strong", spans: [{ kind: "text", text: "both" }] }]);
  });

  it("leaves markup inside code alone", () => {
    expect(parseInline("`a * b`")).toEqual([{ kind: "code", text: "a * b" }]);
  });

  it("leaves arithmetic alone, because a lone star is not emphasis", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
  });

  it("links what was written as a link, and what was merely pasted", () => {
    expect(parseInline("see [the ticket](https://x.test/a)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "the ticket", href: "https://x.test/a" },
    ]);
    // The full stop ends the sentence, not the address.
    expect(parseInline("at https://x.test/a?b=1.")).toEqual([
      { kind: "text", text: "at " },
      { kind: "link", text: "https://x.test/a?b=1", href: "https://x.test/a?b=1" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("tables", () => {
  /** The shape the AI answered in on 2026-09-04, which the chat showed as raw pipes. */
  const TABLE = [
    "| Phần | Nội dung |",
    "|---|:---:|",
    "| `:root` (dòng 14) | Token màu — **đọc từ biến**, kèm fallback |",
    "| `.iodm-help-panel` | Panel trượt từ phải. Tự viết, không dùng off-canvas |",
    "| Media queries | Dưới 40rem thì full width; a \\| b |",
  ].join("\n");

  it("reads a pipe table as header, alignment and rows, with markup inside the cells", () => {
    const [table] = parseMarkdown(TABLE);
    expect(table.kind).toBe("table");
    if (table.kind !== "table") return;
    expect(table.align).toEqual([null, "center"]);
    expect(words(table)).toBe(
      [
        "Phần | Nội dung",
        ":root (dòng 14) | Token màu — đọc từ biến, kèm fallback",
        ".iodm-help-panel | Panel trượt từ phải. Tự viết, không dùng off-canvas",
        "Media queries | Dưới 40rem thì full width; a | b",
      ].join("\n"),
    );
    expect(table.rows[0]?.[0]?.[0]).toMatchObject({ kind: "code", text: ":root" });
    expect(table.rows[0]?.[1]).toContainEqual({
      kind: "strong",
      spans: [{ kind: "text", text: "đọc từ biến" }],
    });
  });

  it("ends the table at a blank line and reads what follows as prose", () => {
    const blocks = parseMarkdown(`${TABLE}\n\nnhưng hiện lên không có format.`);
    expect(blocks.map((block) => block.kind)).toEqual(["table", "paragraph"]);
  });

  it("leaves a line with a pipe but no delimiter row as prose", () => {
    const blocks = parseMarkdown("type Mode = 'a' | 'b'\nls | grep x");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph"]);
  });

  it("reads left and right alignment and a header without outer pipes", () => {
    const [table] = parseMarkdown("a | b | c\n:-- | --: | ---\n1 | 2 | 3");
    expect(table.kind).toBe("table");
    if (table.kind !== "table") return;
    expect(table.align).toEqual(["left", "right", null]);
    expect(words(table)).toBe("a | b | c\n1 | 2 | 3");
  });
});
