/**
 * A Markdown file read in its Preview, held to what a dedicated Markdown
 * viewer shows.
 *
 * What only the running app can show: the document cleaned and on the page,
 * its code coloured by Monaco, its picture loaded from beside it through Rust,
 * its diagram drawn by Mermaid, its links followed - and none of the markup a
 * hostile file carries running. The renderer's own output is unit-tested in
 * `lib/markdownDocument.test.ts`.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { workspace } = require("../wdio.conf.cjs");

const DOCUMENT = "GUIDE.md";
const ICON = path.join(__dirname, "..", "..", "src-tauri", "icons", "128x128.png");

const SOURCE = `---
title: "Shop API"
---

<p align="center"><img src="images/logo.png" width="64" alt="logo"></p>

# Shop API

See [setup](docs/setup.md), jump to [Install](#install), or visit [GitHub](https://github.com).

> [!WARNING]
> The \`main\` branch deploys to production.

<img src="missing.png" onerror="window.__pwned = 'onerror'">
<script>window.__pwned = 'script'</script>

## Install

\`\`\`ts
export const total = (prices: number[]) => prices.reduce((a, b) => a + b, 0);
\`\`\`

- [x] Orders
- [ ] Refunds

$E = mc^2$

\`\`\`mermaid
graph LR
  Client --> API --> DB[(Orders)]
\`\`\`
`;

/** What the preview holds, read in one round trip off the elements that carry it. */
function preview() {
  return browser.execute(() => {
    const doc = document.querySelector(".markdown-doc");
    const picture = doc?.querySelector('img[alt="logo"]');
    return {
      shown: doc !== null,
      frontMatter: doc?.querySelector(".md-front-matter th")?.textContent ?? null,
      picture: picture ? { loaded: picture.src.startsWith("blob:"), width: picture.naturalWidth } : null,
      alert: doc?.querySelector(".markdown-alert-warning") !== null,
      colouredTokens: doc?.querySelectorAll('pre code span[class^="mtk"]').length ?? 0,
      copyButtons: doc?.querySelectorAll(".md-copy").length ?? 0,
      checkboxes: doc?.querySelectorAll(".task-list-item-checkbox").length ?? 0,
      math: doc?.querySelector(".katex") !== null,
      diagram: doc?.querySelector(".md-mermaid svg") !== null,
      scripts: doc?.querySelectorAll("script").length ?? 0,
      handlers: doc?.querySelectorAll("[onerror]").length ?? 0,
      pwned: window.__pwned ?? null,
      scrolled: doc?.parentElement?.scrollTop ?? 0,
    };
  });
}

async function until(predicate, message) {
  let seen = null;
  await browser
    .waitUntil(
      async () => {
        seen = await preview();
        return predicate(seen);
      },
      { timeout: 30_000, interval: 150 },
    )
    .catch(() => {
      assert.fail(`${message} - the preview held ${JSON.stringify(seen)}`);
    });
  return seen;
}

describe("A Markdown file in its Preview", () => {
  before(async () => {
    fs.mkdirSync(path.join(workspace, "images"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.copyFileSync(ICON, path.join(workspace, "images", "logo.png"));
    fs.writeFileSync(path.join(workspace, "docs", "setup.md"), "# Setup\n\nRun it.\n");
    fs.writeFileSync(path.join(workspace, DOCUMENT), SOURCE);

    await browser.execute((folder) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await browser.waitUntil(async () => (await $("body").getText()).includes("RECENT"), {
      timeout: 30_000,
      timeoutMsg: "the welcome screen never rendered",
    });
    await (await $(`span=${path.basename(workspace)}`)).click();
    await (await $(`span=${DOCUMENT}`)).waitForExist({ timeout: 30_000 });
    await (await $(`span=${DOCUMENT}`)).click();
    const previewButton = await $("button*=Preview");
    if (await previewButton.isExisting()) await previewButton.click();
  });

  after(() => {
    for (const made of [DOCUMENT, "images", "docs"]) {
      fs.rmSync(path.join(workspace, made), { recursive: true, force: true });
    }
  });

  it("reads the document the way GitHub does", async () => {
    const shown = await until(
      (p) => p.diagram && p.colouredTokens > 0 && p.picture?.loaded === true,
      "the document never finished drawing",
    );
    assert.equal(shown.frontMatter, "title", "front matter is not a table");
    assert.ok(shown.picture.width > 0, "the picture beside the document did not load");
    assert.ok(shown.alert, "> [!WARNING] is not an alert");
    assert.equal(shown.copyButtons, 1, "the code block has no Copy button");
    assert.equal(shown.checkboxes, 2, "the task list has no checkboxes");
    assert.ok(shown.math, "the formula was not typeset");
  });

  it("runs none of the markup a document carries", async () => {
    const shown = await preview();
    assert.equal(shown.scripts, 0, "a <script> reached the page");
    assert.equal(shown.handlers, 0, "an onerror handler reached the page");
    assert.equal(shown.pwned, null, `markup from the document ran: ${String(shown.pwned)}`);
  });

  it("follows an anchor within the document, and a relative link to its file", async () => {
    await (await $(".markdown-doc a[href='#install']")).click();
    await until((p) => p.scrolled > 0, "the anchor did not scroll to its heading");

    await (await $(".markdown-doc a[href='docs/setup.md']")).click();
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll(".markdown-doc h1")].some((h) => h.textContent === "Setup"),
        ),
      { timeout: 15_000, timeoutMsg: "the linked file did not open" },
    );
  });
});
