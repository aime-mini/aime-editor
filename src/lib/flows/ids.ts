/**
 * Step ids. An id is how jq programs and templates name a step's output, so
 * it has to be one jq reads as a path - and when a step gets a new one, the
 * places that named the old one have to follow.
 */

/**
 * An id jq can read as a path. A step's id is how jq programs and templates
 * name its output, and jq reads `.run-tests` as `.run - tests` - measured on
 * the jaq the engine runs, which answers that "tests" is not a filter.
 */
export function jqSafeId(id: string): string {
  const safe = id
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (safe === "") return "step";
  return /^[0-9]/.test(safe) ? `step_${safe}` : safe;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A text with a step's id changed where it names the step: `.id` and `["id"]` in jq, `{{id…}}` in a template. */
export function withStepRenamed(text: string, from: string, to: string): string {
  const id = escapeRegExp(from);
  return text
    .replace(new RegExp(`\\.${id}(?![A-Za-z0-9_-])`, "g"), `.${to}`)
    .replace(new RegExp(`\\["${id}"\\]`, "g"), `["${to}"]`)
    .replace(new RegExp(`\\{\\{\\s*${id}(?=[.}\\s])`, "g"), `{{${to}`);
}

/** Every string in a JSON value passed through `change`, at every depth. */
export function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((inner) => mapStrings(inner, change));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapStrings(inner, change)]));
}

/** An id no other step of the flow has: `key` numbered, with an underscore jq reads as part of the path. */
export function freshStepId(key: string, taken: readonly string[]): string {
  const base = jqSafeId(key);
  let n = 1;
  while (taken.includes(`${base}_${String(n)}`)) n += 1;
  return `${base}_${String(n)}`;
}

/**
 * A name no other step shows: `name` itself, else numbered from 2 - two cards
 * both called "Command" cannot be told apart on the canvas or in a run.
 */
export function freshStepName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  let n = 2;
  while (taken.includes(`${name} ${String(n)}`)) n += 1;
  return `${name} ${String(n)}`;
}
