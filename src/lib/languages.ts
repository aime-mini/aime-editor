/**
 * File extension -> Monaco language id. One table for the whole app: the
 * editor colours by it and the LSP layer starts a server by it, so they must
 * never disagree about what a file is.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  rs: "rust",
  go: "go",
  py: "python",
  cs: "csharp",
  java: "java",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  xml: "xml",
  sql: "sql",
  sh: "shell",
  ps1: "powershell",
};

export function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}
