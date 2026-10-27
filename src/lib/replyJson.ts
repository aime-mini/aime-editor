/**
 * Reading the JSON an AI was asked to answer with.
 *
 * Models fence their JSON, apologise before it and explain after it. Taking the
 * outermost braces survives all three. Whatever is not the shape asked for
 * reads as empty, so each parser checks what it needs instead of trusting the
 * reply.
 */

/** The first JSON object in a reply, or an empty one when there is none. */
export function objectIn(reply: string): Record<string, unknown> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    return asRecord(JSON.parse(reply.slice(start, end + 1)));
  } catch {
    return {};
  }
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
