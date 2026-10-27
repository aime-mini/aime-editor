import type { InputBundle, StepOutput } from "./model";

/**
 * `{{a.value.key}}` in a step's text: a field of an earlier step's output,
 * inserted where the text says. The picker in the inspector writes these;
 * nobody types a path by hand, but the form is plain enough to read.
 *
 * Roots: every upstream step by its id (`{{read.summary}}`, `{{read.value.items}}`),
 * `input` for the run's own input (`{{input.text}}`, `{{input.params.env}}`),
 * and `item` inside a for-each. A path that leads nowhere becomes nothing,
 * and the caller is told which.
 */
export interface TemplateScope {
  outputs: Record<string, StepOutput>;
  bundle: InputBundle;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;

export function fill(text: string, scope: TemplateScope, missing?: (path: string) => void): string {
  return text.replace(PLACEHOLDER, (_whole, path: string) => {
    const value = lookup(path, scope);
    if (value === undefined) {
      missing?.(path);
      return "";
    }
    return render(value);
  });
}

/** The value a path names, or undefined when there is none. */
export function lookup(path: string, scope: TemplateScope): unknown {
  const [root, ...rest] = path.split(".");
  let current: unknown;
  if (root === "input") {
    current = { ...scope.bundle, value: scope.bundle };
  } else {
    current = scope.outputs[root];
  }
  for (const key of rest) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[Number(key)] : (current as Record<string, unknown>)[key];
  }
  return current;
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/** The placeholders a text uses, for the editor to check against what is wired in. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
}
