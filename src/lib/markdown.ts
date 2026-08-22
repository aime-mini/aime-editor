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

export type Block =
  | { kind: "heading"; level: number; spans: Inline[] }
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "quote"; spans: Inline[] }
  | { kind: "rule" };

/** How many spaces of indentation make one level of nesting. */
const INDENT_WIDTH = 2;

const FENCE = /^\s*(?:```|~~~)\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

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
