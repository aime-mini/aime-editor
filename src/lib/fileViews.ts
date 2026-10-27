import { isDelimitedFile } from "./csv";

/**
 * Files that open as something other than their text.
 *
 * A .csv is a table, a .md is a document, a .json or .xml is a tree, an .html
 * is a page; the text is what a program reads, not what a person opens the
 * file to see. The other side is one click away, per file, so a person editing
 * a README switches once and stays there until they open another file.
 */
export type RenderedView = "table" | "markdown" | "json" | "xml" | "page";

/** XML by another name: the build and package files a developer opens most. */
const XML_EXTENSIONS = /\.(xml|xsd|xsl|xslt|csproj|vbproj|fsproj|props|targets|nuspec|pom|plist|svg)$/i;

export function renderedViewOf(path: string): RenderedView | null {
  if (isDelimitedFile(path)) return "table";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (/\.json$/i.test(path)) return "json";
  if (XML_EXTENSIONS.test(path)) return "xml";
  if (/\.html?$/i.test(path)) return "page";
  return null;
}

/**
 * Whether the file opens on its rendered side. A web page opens on its code:
 * it is opened to be edited far more often than to be looked at, and running
 * its scripts is something to ask for rather than something opening a file
 * does.
 */
export function opensRendered(view: RenderedView): boolean {
  return view !== "page";
}
