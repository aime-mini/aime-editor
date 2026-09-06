import type { PropertyRow } from "./cloudProperties";

/**
 * A JSON or XML file as the tree it is, in the rows the property table draws.
 *
 * The same rows the cloud panel shows a resource's configuration in, because a
 * configuration file and a CLI answer are the same thing to look at: keys down
 * the left, values on the right, nesting folded under its key. What differs is
 * the source: here nothing is unwrapped or cut short, since a file is looked at
 * whole, and an XML document has attributes and text as well as children.
 */
export type Structured =
  | { kind: "ok"; rows: PropertyRow[]; count: number }
  /** The file is not what its name says; the reason is the parser's own. */
  | { kind: "invalid"; reason: string };

/** Nesting deeper than this is shown as text - a tree that deep is not read as a tree. */
const MAX_DEPTH = 12;

/** A JSON file as rows: objects and lists of objects fold, lists of values read as one line. */
export function jsonStructure(text: string): Structured {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  const rows = jsonRows(parsed, 0);
  return { kind: "ok", rows, count: countRows(rows) };
}

function jsonRows(value: unknown, depth: number): PropertyRow[] {
  if (Array.isArray(value)) return value.map((entry, index) => jsonRow(String(index + 1), entry, depth));
  if (isRecord(value)) return Object.entries(value).map(([key, entry]) => jsonRow(key, entry, depth));
  return [{ key: "", kind: "value", value: scalarText(value) }];
}

function jsonRow(key: string, value: unknown, depth: number): PropertyRow {
  if (value === null || typeof value !== "object") return { key, kind: "value", value: scalarText(value) };
  if (Array.isArray(value) && value.every((entry) => entry === null || typeof entry !== "object")) {
    return { key, kind: "value", value: value.length === 0 ? "[]" : value.map(scalarText).join(", ") };
  }
  if (depth >= MAX_DEPTH) return { key, kind: "value", value: JSON.stringify(value, null, 2) };
  const rows = jsonRows(value, depth + 1);
  return rows.length === 0
    ? { key, kind: "value", value: Array.isArray(value) ? "[]" : "{}" }
    : { key, kind: "group", rows };
}

function scalarText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countRows(rows: PropertyRow[]): number {
  return rows.reduce((total, row) => total + (row.kind === "group" ? countRows(row.rows) : 1), 0);
}

/** One XML element, as the tokenizer sees it. */
interface Element {
  name: string;
  attributes: [string, string][];
  children: Element[];
  text: string;
}

/**
 * An XML file as rows: an element with children is a group, its attributes
 * first as `@name`, its own text as `#text`; an element with nothing but text
 * is one line. Parsed here rather than by `DOMParser`, which the test runner
 * does not have and which reports a malformed file as a document about the
 * error rather than as an error.
 */
export function xmlStructure(text: string): Structured {
  try {
    const root = parseXml(text);
    const rows = root.map(elementRow);
    return { kind: "ok", rows, count: countRows(rows) };
  } catch (error: unknown) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

function elementRow(element: Element): PropertyRow {
  const rows: PropertyRow[] = element.attributes.map(([name, value]) => ({
    key: `@${name}`,
    kind: "value",
    value,
  }));
  if (element.children.length === 0 && rows.length === 0) {
    return { key: element.name, kind: "value", value: element.text };
  }
  if (element.text !== "") rows.push({ key: "#text", kind: "value", value: element.text });
  rows.push(...element.children.map(elementRow));
  return { key: element.name, kind: "group", rows };
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** The root elements of a document (one in valid XML; more is still shown). */
function parseXml(text: string): Element[] {
  const roots: Element[] = [];
  const open: Element[] = [];
  let index = 0;
  const attach = (element: Element) => {
    const parent = open.at(-1);
    if (parent === undefined) roots.push(element);
    else parent.children.push(element);
  };
  const addText = (raw: string) => {
    const parent = open.at(-1);
    const trimmed = raw.trim();
    if (parent === undefined || trimmed === "") return;
    parent.text = parent.text === "" ? decode(trimmed) : `${parent.text} ${decode(trimmed)}`;
  };
  while (index < text.length) {
    const lt = text.indexOf("<", index);
    if (lt === -1) {
      addText(text.slice(index));
      break;
    }
    addText(text.slice(index, lt));
    if (text.startsWith("<!--", lt)) {
      index = endOf(text, "-->", lt, "comment");
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = endOf(text, "]]>", lt, "CDATA section");
      const parent = open.at(-1);
      if (parent !== undefined) parent.text += text.slice(lt + 9, end - 3);
      index = end;
    } else if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      index = endOf(text, ">", lt, "declaration");
    } else if (text.startsWith("</", lt)) {
      const end = endOf(text, ">", lt, "closing tag");
      const name = text.slice(lt + 2, end - 1).trim();
      const element = open.pop();
      if (element === undefined || element.name !== name) {
        throw new Error(`</${name}> closes ${element === undefined ? "nothing" : `<${element.name}>`}`);
      }
      index = end;
    } else {
      const end = endOf(text, ">", lt, "tag");
      const selfClosing = text[end - 2] === "/";
      const inside = text.slice(lt + 1, selfClosing ? end - 2 : end - 1).trim();
      const element = parseTag(inside);
      attach(element);
      if (!selfClosing) open.push(element);
      index = end;
    }
  }
  const unclosed = open.at(-1);
  if (unclosed !== undefined) throw new Error(`<${unclosed.name}> is never closed`);
  return roots;
}

/** The position right after `closer`, or a thrown error naming what was left open. */
function endOf(text: string, closer: string, from: number, what: string): number {
  const at = text.indexOf(closer, from);
  if (at === -1) throw new Error(`unterminated ${what} at offset ${String(from)}`);
  return at + closer.length;
}

/** `name attr="v" other='w'` as an element with its attributes. */
function parseTag(inside: string): Element {
  const nameMatch = /^[^\s/>]+/.exec(inside);
  if (nameMatch === null) throw new Error("a tag with no name");
  const attributes: [string, string][] = [];
  const attribute = /(?<name>[^\s=]+)\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)')/g;
  for (const match of inside.slice(nameMatch[0].length).matchAll(attribute)) {
    const name = match.groups?.name ?? "";
    attributes.push([name, decode(match.groups?.double ?? match.groups?.single ?? "")]);
  }
  return { name: nameMatch[0], attributes, children: [], text: "" };
}
