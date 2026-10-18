import MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import katex from "@vscode/markdown-it-katex";
import { full as emoji } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import githubAlerts from "markdown-it-github-alerts";
import taskLists from "markdown-it-task-lists";
import "katex/dist/katex.min.css";

/**
 * A Markdown *file*, rendered the way the places it is usually read render it.
 *
 * A repository's README is written for GitHub, so GitHub's dialect is the
 * standard it is held to (reported 2026-10-16: the preview "is not quite
 * right"): tables, task lists, footnotes, `> [!NOTE]` alerts, emoji
 * shortcodes, `$math$`, Mermaid diagrams, front matter, and the HTML a README
 * centres its logo with. markdown-it is the parser VS Code's preview is built
 * on; the plugins are the ones the user's own Markdown viewer uses.
 *
 * Not for the chat: an answer is redrawn on every frame while it streams, with
 * a caret inside its last block, and `lib/markdown.ts` - a model the component
 * builds elements from - is what makes that cheap and unable to inject
 * anything. A file is rendered once, to HTML that `MarkdownDocument` cleans
 * with DOMPurify before it reaches the page.
 *
 * Loaded on demand (`import()`), so the parser, KaTeX and their CSS cost the
 * app nothing until a document is first previewed.
 */

/** The language a fenced block names, which is the first word of its info string. */
function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

const md = new MarkdownIt({ html: true, linkify: true })
  .use(taskLists, { enabled: false })
  .use(footnote)
  .use(emoji)
  .use(githubAlerts)
  .use(katex, { throwOnError: false });

/** YAML between two `---` lines at the very top of the file. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const renderFence = md.renderer.rules.fence;
/**
 * A Mermaid block becomes a placeholder the component turns into a diagram;
 * every other block keeps its language as `data-lang`, which is what the
 * component colours it by.
 */
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const language = fenceLanguage(token.info);
  if (language === "mermaid") {
    // Percent-encoded: DOMPurify drops an attribute holding `-->`, which is
    // how half of all diagrams draw an arrow.
    return `<div class="md-mermaid" data-source="${encodeURIComponent(token.content)}"></div>\n`;
  }
  if (language !== "") token.attrSet("data-lang", language);
  return renderFence === undefined
    ? self.renderToken(tokens, index, options)
    : renderFence(tokens, index, options, env, self);
};

md.core.ruler.push("heading_ids", headingIds);

/**
 * The document as HTML - not yet cleaned, which the caller must do before
 * showing it. Front matter is metadata, not prose: GitHub draws it as a table
 * above the text.
 */
export function renderMarkdownDocument(source: string): string {
  const front = FRONT_MATTER.exec(source);
  if (front === null) return md.render(source);
  return frontMatterTable(front[1]) + md.render(source.slice(front[0].length));
}

/**
 * GitHub's anchor for a heading: lower case, punctuation dropped, spaces as
 * hyphens - letters of every script kept, so a Vietnamese heading links too.
 */
export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
  return slug === "" ? "section" : slug;
}

/** Gives every heading the id GitHub would, numbering repeats, so `#section` links land. */
function headingIds(state: StateCore): void {
  const used = new Map<string, number>();
  state.tokens.forEach((token, index) => {
    if (token.type !== "heading_open") return;
    const text = (state.tokens[index + 1]?.children ?? [])
      .filter((child) => child.type === "text" || child.type === "code_inline")
      .map((child) => child.content)
      .join("");
    const slug = slugify(text);
    const seen = used.get(slug) ?? 0;
    used.set(slug, seen + 1);
    token.attrSet("id", seen === 0 ? slug : `${slug}-${String(seen)}`);
  });
}

/** `key: value` front matter as a two-column table; anything more elaborate stays as written. */
function frontMatterTable(yaml: string | undefined): string {
  const lines = (yaml ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return "";
  const escape = md.utils.escapeHtml;
  if (!lines.every((line) => /^[\w.-]+\s*:/.test(line))) {
    return `<pre class="md-front-matter"><code>${escape(lines.join("\n"))}</code></pre>\n`;
  }
  const rows = lines.map((line) => {
    const colon = line.indexOf(":");
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    return `<tr><th>${escape(line.slice(0, colon).trim())}</th><td>${escape(value)}</td></tr>`;
  });
  return `<table class="md-front-matter"><tbody>${rows.join("")}</tbody></table>\n`;
}
