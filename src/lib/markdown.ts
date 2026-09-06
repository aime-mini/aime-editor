/**
 * Markdown as a shape a component can render.
 *
 * Work items arrive as Markdown from every connector - GitHub and ClickUp store
 * it, Azure DevOps and Jira are converted into it (`trackers/rich_text.rs`) -
 * and a description is the one thing in this app people actually read. Rendered
 * as raw text it loses exactly what made it readable: the steps stop being a
 * list, the headings stop being headings.
 *
 * This is deliberately a *reader's* subset - headings, lists, quotes, code,
 * links, emphasis - and nothing that can execute or embed. It parses to a model
 * rather than to markup, which is what keeps it testable without a DOM and what
 * makes rendering unable to inject anything: the component only ever builds
 * elements out of the shapes below.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "strong"; spans: Inline[] }
  | { kind: "emphasis"; spans: Inline[] }
  | { kind: "strike"; spans: Inline[] };

/** One line of a list, with how far it is nested (0 is the outermost). */
export interface ListItem {
  depth: number;
  spans: Inline[];
}

/** Where a column's text sits, as its delimiter row said; null is the renderer's default. */
export type Alignment = "left" | "center" | "right" | null;

export type Block =
  | { kind: "heading"; level: number; spans: Inline[] }
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "quote"; spans: Inline[] }
  | { kind: "rule" }
  /** A pipe table: header cells, one alignment per column, then the body rows. */
  | { kind: "table"; header: Inline[][]; align: Alignment[]; rows: Inline[][][] };

/** How many spaces of indentation make one level of nesting. */
const INDENT_WIDTH = 2;

const FENCE = /^\s*(?:```|~~~)\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** The row under a table header: `---`, `:--`, `--:` or `:-:` per column, pipes between. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** A pipe that is a column boundary - not one escaped as `\|`. */
const CELL_SPLIT = /(?<!\\)\|/;

/** The blocks a piece of Markdown is made of, in the order they read. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  /** Lines of the paragraph being collected, if one is open. */
  let paragraph: string[] = [];

  const endParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence !== null) {
      endParagraph();
      const body: string[] = [];
      // Everything up to the closing fence is content, including blank lines and
      // anything that would otherwise look like Markdown.
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", language: fence[1] === "" ? null : fence[1], text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      endParagraph();
      continue;
    }

    if (RULE.test(line)) {
      endParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      endParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }

    // A table is a header line with a pipe, then the delimiter row; the body is
    // every following line that still has a pipe. A lone line with a pipe in
    // it - a shell command, a type union - is prose, and stays prose.
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    if (line.includes("|") && next.includes("|") && TABLE_DELIMITER.test(next)) {
      endParagraph();
      const header = cellsOf(line).map(parseInline);
      const align = cellsOf(next).map(alignmentOf);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        rows.push(cellsOf(lines[index]).map(parseInline));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }

    const item = itemOn(line);
    if (item !== null) {
      endParagraph();
      // Lines that keep the same marker keep the same list; a paragraph between
      // them, or a switch between bullets and numbers, starts a new one.
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === item.ordered) last.items.push(item.item);
      else blocks.push({ kind: "list", ordered: item.ordered, items: [item.item] });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      endParagraph();
      blocks.push({ kind: "quote", spans: parseInline(quote[1]) });
      continue;
    }

    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}

/** The cells of one table row, outer pipes dropped, `\|` read as a literal pipe. */
function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(CELL_SPLIT).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/** What one delimiter cell says about its column: colons on the left, right, or both. */
function alignmentOf(cell: string): Alignment {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** One list line, whichever of the two kinds of marker it carries. */
function itemOn(line: string): { ordered: boolean; item: ListItem } | null {
  for (const [pattern, ordered] of [
    [BULLET, false],
    [NUMBERED, true],
  ] as const) {
    const match = pattern.exec(line);
    if (match !== null) {
      return {
        ordered,
        item: { depth: Math.floor(match[1].length / INDENT_WIDTH), spans: parseInline(match[2]) },
      };
    }
  }
  return null;
}

/**
 * The markers, most binding first. Code comes before everything because
 * backticks make their contents literal, and `**` before `*` so bold does not
 * read as two empty italics.
 */
const MARKERS: { pattern: RegExp; span: (match: RegExpExecArray) => Inline }[] = [
  { pattern: /`([^`\n]+)`/, span: (match) => ({ kind: "code", text: match[1] }) },
  {
    pattern: /\[([^\]\n]*)\]\(\s*(\S+?)\s*\)/,
    span: (match) => ({ kind: "link", text: match[1] === "" ? match[2] : match[1], href: match[2] }),
  },
  // A bare URL is a link too: work items are full of them, written by people who
  // were not thinking about Markdown. The trailing punctuation of a sentence is
  // left out of the address.
  {
    pattern: /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?]/,
    span: (match) => ({ kind: "link", text: match[0], href: match[0] }),
  },
  { pattern: /\*\*([^\n]+?)\*\*/, span: (match) => ({ kind: "strong", spans: parseInline(match[1]) }) },
  { pattern: /~~([^\n]+?)~~/, span: (match) => ({ kind: "strike", spans: parseInline(match[1]) }) },
  { pattern: /\*([^*\n]+?)\*/, span: (match) => ({ kind: "emphasis", spans: parseInline(match[1]) }) },
];

/** The spans of one run of text: whatever is marked up, and the words between. */
export function parseInline(text: string): Inline[] {
  const spans: Inline[] = [];
  let rest = text;

  while (rest !== "") {
    const found = earliestMarker(rest);
    if (found === null) {
      spans.push({ kind: "text", text: rest });
      break;
    }
    if (found.at > 0) spans.push({ kind: "text", text: rest.slice(0, found.at) });
    spans.push(found.span);
    rest = rest.slice(found.at + found.length);
  }
  return spans;
}

/** The first marker in this text, whichever kind it turns out to be. */
function earliestMarker(text: string): { at: number; length: number; span: Inline } | null {
  let best: { at: number; length: number; span: Inline } | null = null;
  for (const marker of MARKERS) {
    const match = marker.pattern.exec(text);
    if (match === null) continue;
    if (best !== null && match.index >= best.at) continue;
    best = { at: match.index, length: match[0].length, span: marker.span(match) };
  }
  return best;
}
