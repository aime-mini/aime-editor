import { hashOf } from "./compiler";
import type { Flow } from "./model";

/**
 * What a flow holds, as a mark the trust gate can compare: the same for the
 * same content however its keys are ordered. The backend stores a flow with
 * its keys sorted, so a mark taken from the object in memory never matched
 * the one read back, and every flow written here asked to be trusted again.
 */
export function fingerprintOf(flow: Flow): string {
  return hashOf(canonical(flow));
}

/** JSON with every object's keys in order and nothing undefined, at any depth. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
