/**
 * Matching the paths an adapter reports against the files the editor holds.
 *
 * A debug adapter answers with whatever the operating system handed it: a
 * drive letter in either case, either kind of slash, and occasionally a
 * `file://` URL. None of that is a different file, but a naive string compare
 * says it is — and then a breakpoint never lights up and the current line is
 * never highlighted.
 */

/** True for `C:\...` or `c:/...` — the only paths that are case-insensitive. */
function isWindowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path);
}

function fromFileUrl(path: string): string {
  if (!path.toLowerCase().startsWith("file://")) return path;
  const withoutScheme = decodeURIComponent(path.slice("file://".length));
  // `file:///c:/x` — the leading slash belongs to the URL, not to the path.
  return /^\/[a-z]:/i.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
}

/** A path in one shape, so two spellings of the same file compare equal. */
export function normalizePath(path: string): string {
  const plain = fromFileUrl(path).replaceAll("\\", "/");
  return isWindowsPath(plain) ? plain.toLowerCase() : plain;
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return normalizePath(a) === normalizePath(b);
}

/** The part of a path worth showing in a call stack: the file name. */
export function fileNameOf(path: string): string {
  return normalizePath(path).split("/").pop() ?? path;
}

/** A path relative to the project root, for labels that must stay short. */
export function relativeTo(root: string, path: string): string {
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const normalized = normalizePath(path);
  if (!normalized.startsWith(`${normalizedRoot}/`)) return path;
  // Sliced from the original so the label keeps the user's own capitalisation.
  return path.replaceAll("\\", "/").slice(normalizedRoot.length + 1);
}
