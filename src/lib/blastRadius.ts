/**
 * What else a change touches, answered by the language server rather than by a
 * guess.
 *
 * This is the part of an autonomous run that Aime can do and a bare CLI agent
 * cannot: the editor already has a language server indexing the project, and
 * "who calls this?" is a question that server answers exactly. Asking a model
 * to imagine the callers of a function produces a plausible list; asking
 * `textDocument/references` produces the real one.
 *
 * The logic here is pure so it can be tested without Monaco or a server: the
 * caller resolves symbols and references however it likes, and this turns the
 * answers into the map a run reasons about.
 */

/** One file a change touches, and what depends on it. */
export interface Impact {
  /** The file about to change. */
  file: string;
  /** Files that use something this file declares, this file excluded. */
  dependents: string[];
  /** The symbols whose references were followed, so the work can be checked. */
  symbols: string[];
  /**
   * True when the language server had nothing to say about this file — no
   * server for the language, or no outline. The list is then not "no
   * dependents", it is "unknown", and a gate must treat the two differently.
   */
  unknown: boolean;
}

/** One symbol of a file, and every file that references it. */
export interface SymbolReferences {
  symbol: string;
  /** File paths, as the server gave them; duplicates and self are fine. */
  files: string[];
}

/**
 * The impact of changing one file.
 *
 * A file always references its own symbols, so it is dropped from its own
 * dependents: the question is what *else* breaks, and a file listing itself
 * makes every change look like it has reach.
 */
export function impactOf(file: string, references: SymbolReferences[]): Impact {
  if (references.length === 0) {
    return { file, dependents: [], symbols: [], unknown: true };
  }
  const dependents = new Set<string>();
  for (const reference of references) {
    for (const other of reference.files) {
      if (!samePath(other, file)) dependents.add(other);
    }
  }
  return {
    file,
    dependents: [...dependents].sort((left, right) => left.localeCompare(right)),
    symbols: references.map((reference) => reference.symbol),
    unknown: false,
  };
}

/** Everything one change reaches: the files it edits and the files that use them. */
export interface Radius {
  /** The files the change itself edits. */
  changing: string[];
  /** Everything that depends on them, none of which is being changed. */
  dependents: string[];
  /** Files the language server could say nothing about. */
  unknown: string[];
}

/** One radius from the per-file impacts. */
export function radiusOf(impacts: Impact[]): Radius {
  const changing = impacts.map((impact) => impact.file);
  const dependents = new Set<string>();
  for (const impact of impacts) {
    for (const dependent of impact.dependents) {
      if (!changing.some((file) => samePath(file, dependent))) dependents.add(dependent);
    }
  }
  return {
    changing,
    dependents: [...dependents].sort((left, right) => left.localeCompare(right)),
    unknown: impacts.filter((impact) => impact.unknown).map((impact) => impact.file),
  };
}

/**
 * Whether the radius is knowable at all.
 *
 * A run must not report "nothing else is affected" when what happened is that
 * no language server answered. Silence and a clean bill of health look
 * identical in a list of zero dependents, and only one of them is safe.
 */
export function radiusIsComplete(radius: Radius): boolean {
  return radius.unknown.length === 0;
}

/**
 * The test files covering a radius, by the convention the project itself uses.
 *
 * This is a naming heuristic, not an answer from a tool, and it is labelled as
 * one wherever it is shown: a test can exercise a module it never names. It is
 * here to *narrow* the fast inner loop, never to decide that something is
 * safe — that decision belongs to the full suite and the baseline comparison.
 */
export function testsCovering(radius: Radius, projectFiles: string[]): string[] {
  const reached = [...radius.changing, ...radius.dependents].map(stemOf);
  const covering = projectFiles.filter(
    (file) => looksLikeTestFile(file) && reached.some((stem) => stem !== "" && stemOf(file).startsWith(stem)),
  );
  return [...new Set(covering)].sort((left, right) => left.localeCompare(right));
}

/**
 * The conventions this recognises, which is only the ones it can name.
 *
 * `test_` is matched as a *prefix* below rather than listed here: anywhere in
 * the name it also claims `contest_results.py`.
 */
const TEST_MARKERS = [".test.", ".spec.", "_test."];
const TEST_FOLDERS = ["/__tests__/", "/tests/", "/test/", "/spec/"];

export function looksLikeTestFile(path: string): boolean {
  const normalised = path.replaceAll("\\", "/").toLowerCase();
  const name = normalised.split("/").pop() ?? "";
  return (
    TEST_MARKERS.some((marker) => name.includes(marker)) ||
    name.startsWith("test_") ||
    TEST_FOLDERS.some((folder) => normalised.includes(folder))
  );
}

/** A file's name with its extension and any test marker taken off. */
function stemOf(path: string): string {
  const name = (path.replaceAll("\\", "/").split("/").pop() ?? "").toLowerCase();
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  for (const marker of [".test", ".spec", "_test", "_spec"]) {
    if (withoutExtension.endsWith(marker)) return withoutExtension.slice(0, -marker.length);
  }
  return withoutExtension.startsWith("test_") ? withoutExtension.slice("test_".length) : withoutExtension;
}

/** Paths from a language server arrive in whatever shape the OS uses. */
function samePath(left: string, right: string): boolean {
  const clean = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  return clean(left) === clean(right);
}
