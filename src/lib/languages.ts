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
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  java: "java",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  xml: "xml",
  sql: "sql",
  sh: "shell",
  ps1: "powershell",
};

/** Files that are known by name rather than by extension. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "plaintext",
};

export function languageOf(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName) return byName;
  const ext = name.split(".").pop() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}
