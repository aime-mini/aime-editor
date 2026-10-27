/**
 * Ghost-text completion driven by whichever AI CLI the user picked.
 *
 * A CLI is not a completion endpoint: every request spawns a process and costs
 * a second or more, so this deliberately does not fire on every keystroke.
 * What lives here is the part that decides *what to ask* and *what of the
 * answer is usable* - both pure, both testable without a model, which is the
 * only way to be sure the ghost text never duplicates code the user already
 * typed.
 */

/** How much of the file travels with the request. Enough to be useful,
 *  small enough to stay cheap on a file of any size. */
const LINES_BEFORE = 60;
const LINES_AFTER = 20;

/** Past this a suggestion is a rewrite, and nobody reads a rewrite as ghost text. */
const MAX_SUGGESTION_LINES = 12;

/** Answers that are prose rather than code - a model declining, in any of its usual shapes. */
const PROSE_REPLY = /^(sorry|i'm sorry|i can(?:'|no)t|i am unable|as an ai|there is (?:no|not))/i;

export interface CompletionRequest {
  /** Project-relative path, so the model knows what it is editing. */
  path: string;
  languageId: string;
  /** Code before the cursor, already windowed. */
  prefix: string;
  /** Code after the cursor, already windowed. */
  suffix: string;
}

/** Keeps the request small: the lines the cursor can plausibly depend on. */
export function windowAround(before: string, after: string): { prefix: string; suffix: string } {
  return {
    prefix: before.split("\n").slice(-LINES_BEFORE).join("\n"),
    suffix: after.split("\n").slice(0, LINES_AFTER).join("\n"),
  };
}

export function buildCompletionPrompt(request: CompletionRequest): string {
  return [
    "You are the completion engine of a code editor. Continue the code exactly at <CURSOR>.",
    "",
    `File: ${request.path} (${request.languageId})`,
    "",
    "<CODE>",
    `${request.prefix}<CURSOR>${request.suffix}`,
    "</CODE>",
    "",
    "Reply with only the code that belongs at <CURSOR> - no explanation, no markdown",
    "fences, and never repeat code that is already before or after the cursor.",
    "Match the surrounding indentation and style. Reply with nothing at all if no",
    "sensible continuation exists.",
  ].join("\n");
}

/** Removes a markdown code fence the model added despite being asked not to. */
function stripFence(text: string): string {
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return fenced ? fenced[1] : text;
}

/**
 * Drops the part of the answer that re-types what is already left of the cursor.
 *
 * Models routinely restate the current line before continuing it, which would
 * show as `const x = const x = 1`. The overlap is measured on the cursor's own
 * line only: an earlier line repeating by chance is a coincidence, the current
 * line repeating is the model echoing.
 */
function dropEchoedPrefix(completion: string, prefix: string): string {
  const currentLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  // On an indent-only line the echo is the indentation itself: models answer a
  // Python body with its four spaces already on the first line, which would
  // land at eight. Later lines keep their own indentation, as they must.
  if (currentLine.trim() === "") {
    return completion.startsWith(currentLine) ? completion.slice(currentLine.length) : completion;
  }
  // Also without the trailing spaces: an answer is trimmed before it gets here,
  // so an echo of `const total = ` arrives as `const total =`.
  for (const line of [currentLine, currentLine.trimEnd()]) {
    if (line.trim() === "") continue;
    for (let length = line.length; length > 0; length--) {
      const echo = line.slice(line.length - length);
      if (completion.startsWith(echo)) return completion.slice(length);
    }
  }
  return completion;
}

/** Drops a tail that re-types what already follows the cursor. */
function dropEchoedSuffix(completion: string, suffix: string): string {
  const nextLine = suffix.slice(0, suffix.indexOf("\n") === -1 ? suffix.length : suffix.indexOf("\n"));
  if (nextLine.trim() === "") return completion;
  for (let length = Math.min(nextLine.length, completion.length); length > 0; length--) {
    if (completion.endsWith(nextLine.slice(0, length))) return completion.slice(0, -length);
  }
  return completion;
}

/**
 * Turns a model's answer into text that can be inserted at the cursor as is.
 *
 * Returns an empty string for anything unusable - prose, an echo of what is
 * already there, a whole rewritten file - because showing nothing is always
 * better than showing a suggestion that corrupts the line when accepted.
 */
export function cleanCompletion(raw: string, request: Pick<CompletionRequest, "prefix" | "suffix">): string {
  const unfenced = stripFence(raw).replace(/^\n+/, "").replace(/\s+$/, "");
  if (unfenced === "" || PROSE_REPLY.test(unfenced.trimStart()) || unfenced.includes("<CURSOR>")) return "";

  const deduped = dropEchoedSuffix(dropEchoedPrefix(unfenced, request.prefix), request.suffix);
  const lines = deduped.split("\n").slice(0, MAX_SUGGESTION_LINES);
  const completion = lines.join("\n");
  return completion.trim() === "" ? "" : completion;
}
