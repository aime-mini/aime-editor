import { convertFileSrc } from "@tauri-apps/api/core";
import { isWithin, relativeTo } from "./repositories";

/** The URI scheme Rust serves previewed pages under (`page_preview.rs`). */
const PAGE_SCHEME = "aime-page";

/**
 * Where the scheme's addresses start. The webview spells a custom scheme
 * differently per platform - `http://aime-page.localhost/` on Windows,
 * `aime-page://localhost/` elsewhere - and Tauri's own conversion knows which.
 */
export function pageOrigin(): string {
  return convertFileSrc("", PAGE_SCHEME);
}

/**
 * The folder a page is fenced into: the workspace that holds it, so a page can
 * reach the shared assets a site keeps beside its pages, or the page's own
 * folder for a file opened from somewhere else.
 */
export function previewRootOf(file: string, workspace: string | null): string {
  if (workspace !== null && isWithin(file, workspace)) return workspace;
  return file.slice(0, Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/")));
}

/**
 * The address of `file` under the token Rust gave its root. Each folder stays
 * a segment of its own, which is what lets the page's relative addresses -
 * `css/app.css`, `../img/logo.png` - resolve the way they do on a server.
 */
export function pageAddress(origin: string, token: string, root: string, file: string): string {
  const inside = relativeTo(root, file).split("/").map(encodeURIComponent).join("/");
  return `${origin}${token}/${inside}`;
}
