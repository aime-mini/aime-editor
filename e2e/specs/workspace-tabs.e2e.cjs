/**
 * Several workspaces in one window, as tabs.
 *
 * Opening a second folder must not replace the first: it becomes a tab of its
 * own, the first keeps running behind it, and switching back brings the first
 * back exactly where it stood. Each tab is a window of its own, so the checks
 * go through the backend's own record of the group and the page's own strip.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aime-${name}-`));
  fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  return dir;
}

const tabsNow = () =>
  browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke("workspace_tabs").then(done, (error) => done({ error: String(error) }));
  });

describe("Workspace tabs", () => {
  const first = project("first");
  const second = project("second");

  after(() => {
    for (const dir of [first, second]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows keeps a handle on a folder a window still has open.
      }
    }
  });

  it("opens a second folder as a tab beside the first, and switches back to it", async () => {
    await browser.execute((recent) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
      localStorage.setItem("aime.locale", "en");
    }, first);
    await browser.refresh();
    await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes("recent"), {
      timeout: 30_000,
    });
    await (await $(`span=${path.basename(first)}`)).click();
    const strip = await $('nav[aria-label="Workspaces"]');
    await strip.waitForExist({ timeout: 30_000, timeoutMsg: "no tab strip once a folder was open" });

    const mine = (await tabsNow()).active;
    await browser.execute((folder) => {
      void window.__TAURI_INTERNALS__.invoke("workspace_open", { folder });
    }, second);

    // The second tab's page opens its folder itself and names its tab after it.
    await browser.waitUntil(
      async () => {
        const { tabs } = await tabsNow();
        return tabs.length === 2 && tabs.some((tab) => tab.folder === second);
      },
      { timeout: 60_000, interval: 500, timeoutMsg: "the second folder never became a tab of its own" },
    );
    const opened = await tabsNow();
    assert.notEqual(opened.active, mine, "the new tab is not the one on screen");
    assert.equal(
      opened.tabs.find((tab) => tab.label === mine)?.folder,
      first,
      "the first workspace was replaced instead of kept",
    );

    await browser.execute((label) => {
      void window.__TAURI_INTERNALS__.invoke("workspace_switch", { label });
    }, mine);
    await browser.waitUntil(async () => (await tabsNow()).active === mine, {
      timeout: 20_000,
      timeoutMsg: "switching back never brought the first workspace back",
    });
    // Still the same page with the same folder: it kept running behind the other tab.
    assert.ok((await $("body").getText()).includes("first.txt"), "the first workspace lost its tree");
    const names = await browser.execute(() =>
      [...document.querySelectorAll("[data-workspace-tab]")].map((tab) => tab.textContent ?? ""),
    );
    assert.equal(names.length, 2, `the strip shows ${names.length} tabs`);
    assert.ok(
      names.some((name) => name.includes(path.basename(second))),
      `no tab named after the second folder: ${names}`,
    );

    // Close the second tab so the run leaves one window behind.
    await browser.execute((label) => {
      void window.__TAURI_INTERNALS__.invoke("workspace_close", { label });
    }, opened.active);
    await browser.waitUntil(async () => (await tabsNow()).tabs.length === 1, {
      timeout: 20_000,
      timeoutMsg: "closing the second tab left it in the strip",
    });
  });
});
