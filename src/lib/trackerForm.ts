/**
 * The connect form's own small piece of logic: turning a connector's `{field}`
 * template into the address of the page where its credential is made.
 *
 * It lives here rather than in the panel because it is the kind of thing that is
 * quietly wrong until something tests it - a self-hosted Jira's field *is* a URL,
 * and percent-encoding it produced `https%3A%2F%2Fjira.company.com/...`.
 */

/** What the connect form has been filled in with so far. */
export type Fields = Partial<Record<string, string>>;

/** `{organization}` and friends, as a connector writes them in a help URL. */
const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/**
 * Fills `{field}` from what has been typed and answers the address, or `null`
 * when there is nothing worth offering: a field still empty, or a result that is
 * not a URL. A half-built link is worse than no link.
 *
 * Values go in verbatim - a field can be a whole origin - and the result is
 * checked by parsing it, which is what actually matters about a link. A site
 * typed as a bare host is completed the way the connectors complete it.
 */
export function fillTemplate(template: string, values: Fields): string | null {
  if (template === "") return null;
  const typed = (name: string) => (values[name] ?? "").trim();
  const needed = [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);
  if (needed.some((name) => typed(name) === "")) return null;

  const filled = template.replace(PLACEHOLDER, (_, name: string) => typed(name));
  // Same rule as the connectors: something that already names a scheme stands or
  // falls as it is, and only a bare host gets one added. Without that split, a
  // `file://` value would be "rescued" into a nonsense https address.
  return HAS_SCHEME.test(filled) ? asUrl(filled) : asUrl(`https://${filled}`);
}

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function asUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    // A link Aime hands to the browser has to be one the browser will follow.
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
