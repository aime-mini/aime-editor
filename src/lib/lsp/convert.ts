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

/** A symbol as servers send it: hierarchical `DocumentSymbol`, or flat `SymbolInformation`. */
export interface LspSymbol {
  name?: string;
  detail?: string;
  kind?: number;
  range?: LspRange;
  selectionRange?: LspRange;
  children?: LspSymbol[];
  /** `SymbolInformation` carries its place inside a location instead. */
  location?: { range?: LspRange };
}

/** A symbol in Monaco's coordinates, still free of Monaco's enums. */
export interface OutlineSymbol {
  name: string;
  detail: string;
  /** The LSP kind, 1-based; the session maps it to Monaco's enum. */
  kind: number;
  range: IRange;
  selectionRange: IRange;
  children: OutlineSymbol[];
}

function toSymbol(symbol: LspSymbol): OutlineSymbol | null {
  const range = symbol.range ?? symbol.location?.range;
  // A symbol with no name or no place cannot be drawn anywhere; dropping it
  // beats handing Monaco an entry that points at line 1 of nothing.
  if (!symbol.name || !range) return null;
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: symbol.kind ?? 0,
    range: toMonacoRange(range),
    // Monaco needs the selection inside the range; the whole range is the
    // honest fallback when a server sends no narrower one.
    selectionRange: toMonacoRange(symbol.selectionRange ?? range),
    children: (symbol.children ?? []).flatMap((child) => toSymbol(child) ?? []),
  };
}

function startsBefore(one: IRange, other: IRange): boolean {
  return one.startLineNumber === other.startLineNumber
    ? one.startColumn - other.startColumn < 0
    : one.startLineNumber - other.startLineNumber < 0;
}

function contains(outer: IRange, inner: IRange): boolean {
  const startsAtOrBefore = !startsBefore(inner, outer);
  const endsAtOrAfter =
    outer.endLineNumber === inner.endLineNumber
      ? outer.endColumn >= inner.endColumn
      : outer.endLineNumber > inner.endLineNumber;
  return startsAtOrBefore && endsAtOrAfter;
}

/**
 * The outline of a file, from either shape a server may answer with.
 *
 * `DocumentSymbol` is already a tree; `SymbolInformation` is a flat list, and
 * servers still answer with it. Both come out nested here, because what makes an
 * outline useful - the enclosing scope of the line you are on - only exists once
 * the symbols contain one another. Nesting a tree again is a no-op: symbols a
 * server already nested never overlap at the same level.
 */
export function toOutline(answer: unknown): OutlineSymbol[] {
  if (!Array.isArray(answer)) return [];
  const symbols = (answer as LspSymbol[]).flatMap((symbol) => toSymbol(symbol) ?? []);
  symbols.sort((one, other) => (startsBefore(one.range, other.range) ? -1 : 1));

  const roots: OutlineSymbol[] = [];
  const enclosing: OutlineSymbol[] = [];
  for (const symbol of symbols) {
    while (enclosing.length > 0 && !contains(enclosing[enclosing.length - 1].range, symbol.range)) {
      enclosing.pop();
    }
    (enclosing.at(-1)?.children ?? roots).push(symbol);
    enclosing.push(symbol);
  }
  return roots;
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

/**
 * The file a Monaco model stands for.
 *
 * Not `model.uri.fsPath`, which is wrong here: `@monaco-editor/react` builds the
 * model's URI with `Uri.parse(path)`, and a Windows path parses as a URI whose
 * *scheme* is the drive letter. Measured against the real window 2026-08-06 -
 * `C:\…\App.java` arrives as scheme `C`, path `\…\App.java` - so every URI Aime
 * sent a language server was missing its drive. Servers that answer from the text
 * they were handed never noticed (pyright, typescript-language-server); JDT LS
 * opens the file on disk, answered nothing at all, and is what exposed it.
 */
export function modelPath(model: { uri: { scheme: string; path: string; fsPath: string } }): string {
  const { scheme, path, fsPath } = model.uri;
  return /^[a-zA-Z]$/.test(scheme) ? `${scheme}:${path}` : fsPath || path;
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

/**
 * What to answer a server-to-client request with.
 *
 * Aime registers no dynamic capabilities and holds no per-server settings, so
 * the answer is "nothing" — but the *shape* of nothing matters. Measured against
 * the Roslyn language server: `workspace/configuration` must come back with one
 * value per item asked for, and a shorter array kills the server outright
 * ("Unexpected null - DidChangeConfigurationNotificationHandler.cs line 127",
 * then "Error processing queue, shutting down"). It asks for several sections at
 * once, so the old single-element answer was a server that died on startup.
 */
export function answerToServerRequest(method: string, params: unknown): unknown {
  if (method !== "workspace/configuration") return null;
  const items = (params as { items?: unknown[] } | null | undefined)?.items;
  return Array.isArray(items) ? items.map(() => null) : [];
}
