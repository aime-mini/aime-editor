// Bundle Monaco locally (NO CDN — a desktop app must work fully offline)
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// monaco-editor >= 0.53 uses an exports map — specifiers no longer carry the `esm/vs` prefix
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// Monaco ships no diff/patch grammar — register a small Monarch one for the
// commit-patch view (git show output).
monaco.languages.register({ id: "aime-diff" });
monaco.languages.setMonarchTokensProvider("aime-diff", {
  tokenizer: {
    root: [
      [/^(diff --git|index |new file|deleted file|similarity|rename (from|to)).*$/, "diff.meta"],
      [/^(---|\+\+\+).*$/, "diff.file"],
      [/^@@.*$/, "diff.hunk"],
      [/^\+.*$/, "diff.add"],
      [/^-.*$/, "diff.del"],
      [/^(commit\s+[0-9a-f]+).*$/, "diff.meta"],
      [/^(Author:|Date:).*$/, "diff.meta"],
    ],
  },
});

monaco.editor.defineTheme("aime-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "diff.add", foreground: "6bc46d" },
    { token: "diff.del", foreground: "f47067" },
    { token: "diff.hunk", foreground: "b083f0" },
    { token: "diff.file", foreground: "daaa3f" },
    { token: "diff.meta", foreground: "8b919d" },
  ],
  colors: {
    "editor.background": "#16181d",
    "editor.lineHighlightBackground": "#1c1f26",
    "editorLineNumber.foreground": "#4a505c",
  },
});

monaco.editor.defineTheme("aime-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "diff.add", foreground: "1a7f37" },
    { token: "diff.del", foreground: "cf222e" },
    { token: "diff.hunk", foreground: "8250df" },
    { token: "diff.file", foreground: "9a6700" },
    { token: "diff.meta", foreground: "6b7280" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.lineHighlightBackground": "#f2f4f8",
    "editorLineNumber.foreground": "#9aa1ac",
  },
});

loader.config({ monaco });

export { monaco };
