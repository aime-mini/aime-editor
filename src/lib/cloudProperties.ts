/**
 * A cloud CLI's JSON answer, as rows a person reads instead of a blob.
 *
 * The AWS Toolkit and the Azure portal both show a resource as a table of
 * properties, not as its raw payload, and for the same reason: a developer
 * opening a database wants the endpoint, the port and the engine version in
 * three lines they can copy, not a hunt through two hundred lines of braces.
 * The payload stays available whole - a `Raw` tab - because the CLI's own words
 * are the ground truth when the table surprises.
 */

/** One property, or one nested group of them. */
export type PropertyRow =
  | { key: string; kind: "value"; value: string }
  /** A nested object or a list of objects, shown folded under its key. */
  | { key: string; kind: "group"; rows: PropertyRow[] };

/** How deep nesting is followed before the rest is shown as JSON text. */
const MAX_DEPTH = 3;

/** Keys the AWS CLI wraps a single answer in; the wrapper carries nothing. */
const LIST_OF_ONE = /s$/;

/**
 * Rows for one CLI answer.
 *
 * Unwraps the two shapes the CLIs use for "here is the one thing you asked
 * for": `{"Stacks":[{...}]}` - a list of one under a plural key - and a
 * single-key object whose value is the object itself. Everything else is
 * rendered as it came, key by key.
 */
export function propertiesOf(json: string): PropertyRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [{ key: "", kind: "value", value: json.trim() }];
  }
  return rowsOf(unwrap(parsed), 0);
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const only = keys[0];
  const inner = value[only];
  if (Array.isArray(inner) && inner.length === 1 && LIST_OF_ONE.test(only) && isRecord(inner[0]))
    return inner[0];
  return isRecord(inner) ? inner : value;
}

function rowsOf(value: unknown, depth: number): PropertyRow[] {
  if (Array.isArray(value)) {
    return value.map((entry, index) => rowOf(String(index + 1), entry, depth));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => rowOf(key, entry, depth));
  }
  return [{ key: "", kind: "value", value: textOf(value) }];
}

function rowOf(key: string, value: unknown, depth: number): PropertyRow {
  if (value === null || typeof value !== "object") return { key, kind: "value", value: textOf(value) };
  if (Array.isArray(value) && value.every((entry) => entry === null || typeof entry !== "object")) {
    // A list of plain values reads as one line; a list of objects is a group.
    return { key, kind: "value", value: value.map(textOf).join(", ") };
  }
  if (depth >= MAX_DEPTH) return { key, kind: "value", value: JSON.stringify(value, null, 2) };
  const rows = rowsOf(value, depth + 1);
  return rows.length === 0 ? { key, kind: "value", value: "—" } : { key, kind: "group", rows };
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many properties are in a set of rows, groups included. */
export function countOf(rows: PropertyRow[]): number {
  return rows.reduce((total, row) => total + (row.kind === "group" ? countOf(row.rows) : 1), 0);
}

/**
 * The rows a developer connects with, pulled to the top.
 *
 * An endpoint, a host, a URL, a port: whatever the payload calls them, these
 * are what a person came to a resource for, and burying them at row forty of a
 * describe answer is the thing this whole panel exists to stop. Matched on the
 * key, case-insensitively, and returned in payload order.
 */
export function connectionRows(rows: PropertyRow[]): PropertyRow[] {
  const found: PropertyRow[] = [];
  const walk = (list: PropertyRow[]) => {
    for (const row of list) {
      if (row.kind === "group") walk(row.rows);
      else if (CONNECTION_KEY.test(row.key) && row.value !== "—") found.push(row);
    }
  };
  walk(rows);
  return found;
}

/** Keys that hold something a client connects to. */
const CONNECTION_KEY =
  /endpoint|hostname|^host$|address|^url$|uri$|url$|^port$|fqdn|dns|connection|database$|^engine/i;
