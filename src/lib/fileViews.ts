import { isDelimitedFile } from "./csv";

/**
 * Files that open as something other than their text.
 *
 * A .csv is a table, a .md is a document, a .json or .xml is a tree; the text
 * is what a program reads, not what a person opens the file to see. The
 * rendered view is the default and the text is one click away, per file, so a
 * person editing a README switches once and stays there until they open
 * another file.
 */
export type RenderedView = "table" | "markdown" | "json" | "xml";

/** XML by another name: the build and package files a developer opens most. */
const XML_EXTENSIONS = /\.(xml|xsd|xsl|xslt|csproj|vbproj|fsproj|props|targets|nuspec|pom|plist|svg)$/i;

export function renderedViewOf(path: string): RenderedView | null {
  if (isDelimitedFile(path)) return "table";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (/\.json$/i.test(path)) return "json";
  if (XML_EXTENSIONS.test(path)) return "xml";
  return null;
}
