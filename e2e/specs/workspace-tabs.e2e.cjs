/**
 * Several workspaces in one window, as tabs.
 *
 * Opening a second folder must not replace the first: it becomes a tab of its
 * own, the first keeps running behind it, and switching back brings the first
 * back exactly where it stood. A new tab appears only once its page has
 * painted - never as a blank window. Each tab is a window of its own, so the checks
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

/** Opens `folder` the way a person does: from Recent on the welcome screen. */
async function openFromRecent(folder) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
    localStorage.setItem("aime.locale", "en");
  }, folder);
  await browser.refresh();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes("recent"), {
    timeout: 30_000,
  });
  await (await $(`span=${path.basename(folder)}`)).click();
  const strip = await $('nav[aria-label="Workspaces"]');
  await strip.waitForExist({ timeout: 30_000, timeoutMsg: "no tab strip once a folder was open" });
}

/** Opens `folder` as a new tab and waits for it to come on screen, loaded. */
async function openTab(folder) {
  await browser.executeAsync((wanted, done) => {
    window.__TAURI_INTERNALS__.invoke("workspace_open", { folder: wanted }).then(done, done);
  }, folder);
  await browser.waitUntil(
    async () => {
      const { tabs, active } = await tabsNow();
      return tabs.some((tab) => tab.label === active && tab.folder === folder && !tab.loading);
    },
    { timeout: 60_000, interval: 250, timeoutMsg: `${folder} never came on screen as a tab of its own` },
  );
  return (await tabsNow()).active;
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
    await openFromRecent(first);

    const mine = (await tabsNow()).active;
    await browser.executeAsync((folder, done) => {
      window.__TAURI_INTERNALS__.invoke("workspace_open", { folder }).then(done, done);
    }, second);

    // A blank window never takes the screen: the new tab waits, loading, while
    // the first stays where it is.
    const loading = await tabsNow();
    assert.equal(loading.active, mine, "the new tab took the screen before its page had painted");
    assert.ok(
      loading.tabs.some((tab) => tab.folder === second && tab.loading),
      `the new tab is not shown loading: ${JSON.stringify(loading.tabs)}`,
    );

    // Once its page has painted it takes the first one's place.
    await browser.waitUntil(
      async () => {
        const { tabs, active } = await tabsNow();
        return (
          active !== mine && tabs.some((tab) => tab.label === active && tab.folder === second && !tab.loading)
        );
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "the second folder never came on screen as a tab of its own",
      },
    );
    const opened = await tabsNow();
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

  it("brings back the tabs a folder was open with when it is reopened after a restart", async () => {
    await openFromRecent(first);
    await openTab(second);

    // A new app, and the first folder reopened from Recent: the second comes
    // back beside it, loading behind it rather than taking the screen.
    await browser.reloadSession();
    await openFromRecent(first);
    await browser.waitUntil(
      async () => (await tabsNow()).tabs.some((tab) => tab.folder === second && !tab.loading),
      { timeout: 60_000, interval: 250, timeoutMsg: "the second folder did not come back as a tab" },
    );
    const back = await tabsNow();
    assert.deepEqual(
      back.tabs.map((tab) => tab.folder),
      [first, second],
      "the tabs came back in another order",
    );
    assert.equal(
      back.tabs.find((tab) => tab.folder === first)?.label,
      back.active,
      "the reopened folder is not on screen",
    );

    // Its x takes it out of what is remembered, and out of this run's traces.
    const brought = back.tabs.find((tab) => tab.folder === second)?.label;
    await browser.execute((label) => {
      void window.__TAURI_INTERNALS__.invoke("workspace_close", { label });
    }, brought);
    await browser.waitUntil(async () => (await tabsNow()).tabs.length === 1, {
      timeout: 20_000,
      timeoutMsg: "closing the brought-back tab left it in the strip",
    });
  });
});
