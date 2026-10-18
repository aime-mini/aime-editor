import { describe, expect, it } from "vitest";
import { renderMarkdownDocument, slugify } from "./markdownDocument";

describe("a Markdown file, rendered the way GitHub reads it", () => {
  it("draws tables and task lists", () => {
    const html = renderMarkdownDocument("| a | b |\n|---|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n");
    expect(html).toContain("<table>");
    expect(html).toContain('style="text-align:right"');
    expect(html).toMatch(/<input class="task-list-item-checkbox" checked="" disabled="" type="checkbox">/);
    expect(html).toMatch(/<input class="task-list-item-checkbox" disabled="" type="checkbox">/);
  });

  it("turns `> [!NOTE]` into an alert, and footnotes into notes at the end", () => {
    const html = renderMarkdownDocument("> [!WARNING]\n> Mind the gap.\n\nText[^1].\n\n[^1]: The note.\n");
    expect(html).toContain('class="markdown-alert markdown-alert-warning"');
    expect(html).toContain('class="footnotes"');
    expect(html).toContain("The note.");
  });

  it("gives headings GitHub's anchors, numbering repeats, in any script", () => {
    const html = renderMarkdownDocument("# Getting Started!\n## Cài đặt\n## Getting Started\n");
    expect(html).toContain('<h1 id="getting-started">');
    expect(html).toContain('<h2 id="cài-đặt">');
    expect(html).toContain('<h2 id="getting-started-1">');
  });

  it("leaves a Mermaid block for the diagram and marks other blocks with their language", () => {
    const html = renderMarkdownDocument("```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst a = 1 < 2;\n```\n");
    expect(html).toContain(
      `<div class="md-mermaid" data-source="${encodeURIComponent("graph TD; A-->B\n")}"></div>`,
    );
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain("const a = 1 &lt; 2;");
  });

  it("draws front matter as a table, math with KaTeX, and emoji from shortcodes", () => {
    const html = renderMarkdownDocument('---\ntitle: "Aime"\nversion: 1\n---\n\n$E = mc^2$ :rocket:\n');
    expect(html).toContain('<table class="md-front-matter"><tbody><tr><th>title</th><td>Aime</td></tr>');
    expect(html).toContain('class="katex"');
    expect(html).toContain("🚀");
  });

  it("keeps the HTML a README is written with - cleaning it is the caller's job", () => {
    expect(renderMarkdownDocument('<p align="center"><img src="logo.png"></p>\n')).toContain(
      '<p align="center"><img src="logo.png"></p>',
    );
  });
});

describe("slugify", () => {
  it("falls back to a name for a heading with no letters", () => {
    expect(slugify("!!!")).toBe("section");
  });
});
