import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { editor as monacoEditor, languages as monacoLanguages } from "monaco-editor";
import { translate, useT } from "../i18n";
import { linkTarget, localPicture } from "../lib/documentLinks";
import { failedTo, loggedAs } from "../stores/notices";
import { monacoThemeOf, useTheme, type Theme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";
import { Waiting } from "./Waiting";

/** How long "Copied" stays on a code block's button. */
const COPIED_MS = 1_500;

/** The attribute a local picture's path waits in until its bytes are loaded. */
const LOCAL_SRC = "data-local-src";

/** Picture types by extension, for the blob a picture's bytes become. */
const PICTURE_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/**
 * A cleaner of its own, so its hook touches no one else's DOMPurify. A local
 * picture's `src` is parked in `LOCAL_SRC` on the way through: left in place,
 * the webview would ask the dev server for `images/logo.png` and draw a broken
 * picture before the real one could be loaded.
 */
const purifier = DOMPurify(window);
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "IMG") return;
  const src = node.getAttribute("src");
  if (src === null || /^(?:https?|data|blob):/i.test(src)) return;
  node.setAttribute(LOCAL_SRC, src);
  node.removeAttribute("src");
});

function clean(html: string): string {
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_ATTR: ["data-source", "data-lang", LOCAL_SRC],
  });
}

/**
 * A Markdown file, read: GitHub's dialect (`lib/markdownDocument.ts`), its code
 * coloured by the editor's own tokenizer and theme, its diagrams drawn, its
 * pictures loaded from beside it, and its links followed where they point - an
 * anchor scrolls, a web address opens in the browser, a file opens in a tab.
 *
 * The HTML is cleaned by DOMPurify before it is set: a document can carry any
 * markup, and none of it may run.
 */
export function MarkdownDocument({ text, path }: { text: string; path: string }) {
  const t = useT();
  const theme = useTheme((s) => s.theme);
  const [html, setHtml] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // One object per document, not per render: React 19 sets `innerHTML` again
  // whenever this prop is a new object, which wiped the coloured code, the
  // pictures and the diagrams each time anything above redrew (measured).
  const markup = useMemo(() => (html === null ? null : { __html: html }), [html]);

  useEffect(() => {
    let stale = false;
    import("../lib/markdownDocument")
      .then(({ renderMarkdownDocument }) => {
        if (!stale) setHtml(clean(renderMarkdownDocument(text)));
      })
      .catch(loggedAs("markdown-preview"));
    return () => {
      stale = true;
    };
  }, [text]);

  // What the markup cannot do by itself, done once it is on the page - and
  // again for a new theme, since the colours and the diagrams depend on it.
  useEffect(() => {
    const element = root.current;
    if (element === null || html === null) return;
    let stale = false;
    const isStale = () => stale;
    addCopyButtons(element);
    colorCode(element, theme, isStale);
    const releasePictures = loadPictures(element, path, isStale);
    drawDiagrams(element, theme, isStale).catch(loggedAs("mermaid"));
    return () => {
      stale = true;
      releasePictures();
    };
  }, [html, path, theme]);

  const follow = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    const target = linkTarget(path, href);
    if (target.kind === "anchor") {
      root.current?.querySelector(`[id="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: "start" });
    } else if (target.kind === "external") {
      openUrl(target.url).catch(failedTo(translate("notice.openLink", { url: target.url })));
    } else {
      useWorkspace
        .getState()
        .openFile(target.path)
        .catch(failedTo(translate("notice.openLink", { url: target.path })));
    }
  };

  if (markup === null) return <Waiting label={t("markdown.rendering")} />;
  return (
    <div
      // A fresh element per theme: the colours of the code are baked into its
      // markup, and redrawing it from the clean HTML is simpler than undoing them.
      key={theme}
      ref={root}
      onClick={follow}
      className="markdown-doc"
      // Cleaned by DOMPurify in `clean`; see the component's comment.
      dangerouslySetInnerHTML={markup}
    />
  );
}

/** A Copy button on every code block, shown on hover. */
function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (code === null) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-copy";
    button.textContent = translate("markdown.copy");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      navigator.clipboard
        .writeText(code.innerText)
        .then(() => {
          button.textContent = translate("markdown.copied");
          window.setTimeout(() => {
            button.textContent = translate("markdown.copy");
          }, COPIED_MS);
        })
        .catch(failedTo(translate("markdown.copy")));
    });
    pre.appendChild(button);
  }
}

/**
 * Colours each fenced block with the editor's own tokenizer, so a snippet in a
 * README looks exactly as the file it came from does in a tab.
 */
function colorCode(root: HTMLElement, theme: Theme, isStale: () => boolean): void {
  // Monaco colours by its one global theme, which an editor sets when it
  // mounts; a preview opened before any editor would otherwise get the default
  // light one - dark blue on the dark theme's background (measured).
  monacoEditor.setTheme(monacoThemeOf(theme));
  const known = monacoLanguages.getLanguages();
  for (const code of root.querySelectorAll<HTMLElement>("code[data-lang]")) {
    const named = (code.dataset.lang ?? "").toLowerCase();
    const language = known.find(
      (candidate) =>
        candidate.id === named ||
        candidate.aliases?.some((alias) => alias.toLowerCase() === named) === true ||
        candidate.extensions?.includes(`.${named}`) === true,
    );
    if (language === undefined) continue;
    monacoEditor
      // The fence's own last newline would come back as an empty last line.
      .colorize((code.textContent ?? "").replace(/\n$/, ""), language.id, { tabSize: 4 })
      .then((colored) => {
        // Monaco's own output: its tokens, escaped, as spans.
        if (!isStale()) code.innerHTML = colored;
      })
      .catch(loggedAs("markdown-colorize"));
  }
}

/** Loads the pictures that live beside the document; the release revokes their blobs. */
function loadPictures(root: HTMLElement, documentPath: string, isStale: () => boolean): () => void {
  const urls: string[] = [];
  for (const picture of root.querySelectorAll<HTMLImageElement>(`img[${LOCAL_SRC}]`)) {
    const file = localPicture(documentPath, picture.getAttribute(LOCAL_SRC) ?? "");
    if (file === null) continue;
    const type = PICTURE_TYPES[file.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
    invoke<ArrayBuffer>("read_image", { path: file })
      .then((bytes) => {
        if (isStale()) return;
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        urls.push(url);
        picture.src = url;
      })
      .catch(loggedAs("markdown-picture"));
  }
  return () => {
    for (const url of urls) URL.revokeObjectURL(url);
  };
}

/** How many diagrams this window has drawn, for the ids Mermaid needs to be unique. */
let diagramCount = 0;

/**
 * Draws the Mermaid blocks. Mermaid is large, so it is only fetched for a
 * document that has a diagram; `strict` keeps a diagram's labels from carrying
 * markup or scripts of their own.
 */
async function drawDiagrams(root: HTMLElement, theme: Theme, isStale: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".md-mermaid")];
  if (blocks.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
  });
  for (const block of blocks) {
    if (isStale()) return;
    diagramCount += 1;
    try {
      const { svg } = await mermaid.render(
        `aime-diagram-${String(diagramCount)}`,
        decodeURIComponent(block.dataset.source ?? ""),
      );
      // Mermaid's own SVG, its labels sanitised under `strict`.
      if (!isStale()) block.innerHTML = svg;
    } catch (error: unknown) {
      block.classList.add("md-mermaid-error");
      block.textContent = translate("markdown.diagramFailed", { reason: String(error) });
    }
  }
}
