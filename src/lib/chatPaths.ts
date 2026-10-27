import type { Block, Inline } from "./markdown";

/**
 * Files and folders an AI answer mentions, found by their shape.
 *
 * Shape alone proves nothing - `and/or` looks like a relative path - so what
 * is found here is only a candidate: the chat asks the disk which of them
 * exist (`path_kinds`) and links those, leaving the rest as the words they
 * were.
 */

/** One mention: where it sits in the text, the path on disk, and a line to land on. */
export interface PathMention {
  start: number;
  end: number;
  path: string;
  line?: number;
}

/**
 * A path written into running text. Absolute on Windows (`C:\…`, `C:/…`) or
 * POSIX (`/…`), or relative with at least one separator (`src/app.ts`) - a bare
 * `README.md` in a sentence is too often just a word. No spaces: in running
 * text nothing says where a path with a space in it would end. A `~` belongs:
 * Windows gives long folder names short ones like `RUNNER~1`, and the temp
 * folder is usually spelled with them.
 */
const PATH_IN_TEXT = /(?<![\w/\\.:~-])(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])?(?:[\w@.+~-]+[\\/])+[\w@.+~-]*/g;

/** The `:42` or `:42:7` an answer puts after a path to point at a line. */
const LINE_SUFFIX = /^:(\d+)(?::\d+)?/;
const LINE_AT_END = /:(\d+)(?::\d+)?$/;

/** Punctuation that ends a sentence rather than a path. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

/** A whole code span that is a path: a separator, or a name with an extension. */
const PATH_SPAN = /^(?:[A-Za-z]:[\\/][^<>"|?*\n]*|[\w@.+~\-/\\]+)$/;
const HAS_SEPARATOR_OR_EXTENSION = /[\\/]|\.[A-Za-z0-9]{1,8}$/;

/** Every path-shaped run in a stretch of running text. */
export function mentionsInText(text: string, root: string): PathMention[] {
  const mentions: PathMention[] = [];
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");
    if (raw.length < 2 || !/[\\/]/.test(raw)) continue;
    const start = match.index;
    let end = start + raw.length;
    const suffix = LINE_SUFFIX.exec(text.slice(end));
    const line = suffix ? Number(suffix[1]) : undefined;
    if (suffix) end += suffix[0].length;
    mentions.push({ start, end, path: resolvePath(raw, root), line });
  }
  return mentions;
}

/** A code span as a path, when the whole of it reads as one. */
export function mentionInCode(code: string, root: string): PathMention | null {
  const text = code.trim();
  const suffix = LINE_AT_END.exec(text);
  const raw = suffix ? text.slice(0, suffix.index) : text;
  if (!PATH_SPAN.test(raw) || !HAS_SEPARATOR_OR_EXTENSION.test(raw)) return null;
  return {
    start: 0,
    end: code.length,
    path: resolvePath(raw, root),
    line: suffix ? Number(suffix[1]) : undefined,
  };
}

/** A link's target as a path, for one that is not a web address. */
export function mentionInHref(href: string, root: string): PathMention | null {
  if (/^file:\/\//i.test(href)) {
    const path = decodeURIComponent(href.replace(/^file:\/\/\/?/i, ""));
    // `file:///C:/x` names a drive; `file:///home/x` names the POSIX root.
    return { start: 0, end: href.length, path: /^[A-Za-z]:/.test(path) ? path : `/${path}` };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return null;
  const [target, anchor] = href.split("#", 2);
  const line = anchor ? /^L(\d+)/.exec(anchor) : null;
  return {
    start: 0,
    end: href.length,
    path: resolvePath(decodeURIComponent(target), root),
    line: line ? Number(line[1]) : undefined,
  };
}

/** A path as it is on disk: absolute as written, or relative to the workspace. */
export function resolvePath(raw: string, root: string): string {
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\")) return raw;
  const separator = root.includes("\\") ? "\\" : "/";
  const relative = raw.replace(/^\.[\\/]/, "").replace(/[\\/]/g, separator);
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative}`;
}

/** Every path a parsed answer could be naming - in its words, its code spans and its links. */
export function pathsMentionedIn(blocks: readonly Block[], root: string): string[] {
  const paths: string[] = [];
  const visit = (spans: readonly Inline[]) => {
    for (const span of spans) {
      if (span.kind === "text") paths.push(...mentionsInText(span.text, root).map((m) => m.path));
      else if (span.kind === "code") pushIfFound(paths, mentionInCode(span.text, root));
      else if (span.kind === "link") pushIfFound(paths, mentionInHref(span.href, root));
      else visit(span.spans);
    }
  };
  for (const block of blocks) {
    if (block.kind === "list") for (const item of block.items) visit(item.spans);
    else if (block.kind === "table") for (const cell of [block.header, ...block.rows].flat()) visit(cell);
    else if ("spans" in block) visit(block.spans);
  }
  return paths;
}

function pushIfFound(paths: string[], mention: PathMention | null) {
  if (mention !== null) paths.push(mention.path);
}
