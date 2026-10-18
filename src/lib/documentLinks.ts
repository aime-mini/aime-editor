/**
 * Where a link or a picture in a Markdown file points, from that file.
 *
 * A README says `docs/setup.md`, `../LICENSE` or `images/logo.png` and means
 * "next to me" - the browser would read it against the page's own address,
 * which in Aime is the dev server, so it has to be resolved here.
 */

/** What a link in a document asks for. */
export type DocumentTarget =
  { kind: "anchor"; id: string } | { kind: "external"; url: string } | { kind: "file"; path: string };

/** A scheme (`https:`, `mailto:`) or a protocol-relative `//host`, but not a drive letter. */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]+:|\/\/)/i;
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;
const FILE_URL = /^file:\/\//i;

export function linkTarget(documentPath: string, href: string): DocumentTarget {
  if (href.startsWith("#")) return { kind: "anchor", id: decoded(href.slice(1)) };
  if (FILE_URL.test(href)) return { kind: "file", path: fileUrlPath(href) };
  if (WINDOWS_ABSOLUTE.test(href)) return { kind: "file", path: withoutFragment(href) };
  if (EXTERNAL.test(href)) return { kind: "external", url: href };
  return { kind: "file", path: resolveBeside(documentPath, decoded(withoutFragment(href))) };
}

/** The file a picture's `src` names, or null for one on the web or inline. */
export function localPicture(documentPath: string, src: string): string | null {
  const target = linkTarget(documentPath, src);
  return target.kind === "file" ? target.path : null;
}

/** `rel` read from the folder `documentPath` is in, written with that path's own separator. */
function resolveBeside(documentPath: string, rel: string): string {
  const separator = documentPath.includes("\\") ? "\\" : "/";
  const parts = documentPath.split(/[\\/]/);
  parts.pop(); // the document itself
  // A path from the root of the drive or the filesystem starts over there.
  if (rel.startsWith("/") || rel.startsWith("\\")) parts.splice(1);
  for (const segment of rel.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(segment);
  }
  return parts.join(separator);
}

function withoutFragment(href: string): string {
  return href.split(/[?#]/)[0] ?? href;
}

function fileUrlPath(url: string): string {
  const path = decoded(withoutFragment(url.replace(FILE_URL, "")));
  // `file:///C:/x` is C:/x; `file:///home/x` is /home/x.
  return /^\/[a-z]:/i.test(path) ? path.slice(1) : path;
}

/** Percent-escapes undone, or the text as written when it holds a stray `%`. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
