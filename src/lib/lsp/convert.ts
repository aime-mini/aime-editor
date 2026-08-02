import type { IPosition, IRange } from "monaco-editor";

/**
 * Conversions between LSP and Monaco. LSP counts lines and characters from 0,
 * Monaco counts lines and columns from 1 — an off-by-one here misplaces every
 * completion and every squiggle, so the mapping lives in one tested place.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export function toLspPosition(position: IPosition): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toMonacoRange(range: LspRange): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * Servers answer hovers as a string, a `{value}` object, or a list of both.
 * Flattening them here keeps the provider free of shape checks.
 */
export function hoverToMarkdown(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverToMarkdown).filter(Boolean).join("\n\n");
  if (typeof contents === "object" && contents !== null) {
    const { value } = contents as { value?: unknown };
    if (typeof value === "string") return value;
  }
  return "";
}

/** `file:///c%3A/path/file.ts` ↔ the OS path Aime works with. */
export function pathToUri(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${withRoot.split("/").map(encodeURIComponent).join("/")}`;
}

export function uriToPath(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\//, "");
  const decoded = decodeURIComponent(withoutScheme);
  // A Windows path arrives as `/C:/…`; the leading slash is not part of it.
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
}
