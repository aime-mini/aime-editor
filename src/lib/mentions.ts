/**
 * `@` file mentions in the AI composer.
 *
 * Telling an AI CLI which file to look at means typing a path, and a path is
 * the one thing nobody remembers. Typing `@` and a few letters of the name
 * should be enough - which makes this the difference between "ask about the
 * repo" and "ask about this file" for someone who does not live in a terminal.
 *
 * Kept pure so the fiddly part - where the mention starts, what replaces it,
 * where the cursor lands afterwards - is settled by tests rather than by
 * trying it in the app.
 */

/** An `@query` the cursor is currently inside. */
export interface Mention {
  /** Index of the `@`. */
  start: number;
  /** Index just past the query, i.e. the cursor. */
  end: number;
  /** What was typed after the `@`, possibly empty. */
  query: string;
}

/**
 * The mention being typed at `cursor`, if there is one.
 *
 * A mention starts at an `@` that begins the text or follows whitespace - so
 * an email address or a decorator does not open a file picker - and ends at
 * the cursor. Whitespace inside ends it: once the user typed a space they
 * moved on, and paths with spaces are rare enough to be pasted instead.
 */
export function activeMention(text: string, cursor: number): Mention | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;

  const preceding = at === 0 ? "" : before[at - 1];
  if (preceding !== "" && !/\s/.test(preceding)) return null;

  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, end: cursor, query };
}

/** The composer text and cursor after a mention is replaced by a path. */
export function applyMention(text: string, mention: Mention, path: string): { text: string; cursor: number } {
  // A trailing space, because the next thing typed is a question, not a path.
  const inserted = `@${path} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    cursor: mention.start + inserted.length,
  };
}
