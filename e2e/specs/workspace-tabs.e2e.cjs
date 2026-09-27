/**
 * Several workspaces in one window, as tabs.
 *
 * Opening a second folder must not replace the first: it becomes a tab of its
 * own, the first keeps running behind it, and switching back brings the first
 * back exactly where it stood. A new tab appears only once its page has
 * painted - never as a blank window. Each tab is a webview of its own in the
 * window, so the checks go through the backend's own record of the window's
 * tabs, the page's own strip, and - for what must not leak between tabs - each
 * webview in turn.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resizeAppWindow } = require("../support/appWindow.cjs");

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

/** Runs the next commands in the webview of workspace `label`. */
async function inWorkspace(label) {
  for (const handle of await browser.getWindowHandles()) {
    await browser.switchToWindow(handle);
    const here = await browser.execute(() => window.__TAURI_INTERNALS__.metadata.currentWebview.label);
    if (here === label) return;
  }
  throw new Error(`no webview ${label} among the window handles`);
}

/**
 * Starts hearing, in the current webview, what the backend sends to one
 * workspace - with the app's own `listenHere`, so what is tested is what the
 * terminal, the file tree and the rest listen through.
 */
const hearHere = () =>
  browser.executeAsync((done) => {
    import("/src/lib/workspaceEvents.ts").then(
      async ({ listenHere }) => {
        const heard = { term: "", files: [] };
        window.__heard = heard;
        await listenHere("term:data", ({ payload }) => {
          heard.term += new TextDecoder().decode(new Uint8Array(payload.data));
        });
        await listenHere("fs:changed", ({ payload }) => {
          heard.files.push(...payload);
        });
        done(true);
      },
      (error) => done(String(error)),
    );
  });

/** A shell in `cwd` for the current workspace, told to print `marker`. */
const echoInTerminal = (cwd, marker) =>
  browser.executeAsync(
    (folder, text, done) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      invoke("term_create", { cwd: folder, cols: 80, rows: 24 }).then(
        async (termId) => {
          // ConPTY asks where the cursor is and waits for the answer xterm.js
          // would give; nothing prints until it gets one.
          await invoke("term_write", { termId, data: "\u001b[1;1R" });
          await invoke("term_write", { termId, data: `echo ${text}\r` });
          done(termId);
        },
        (error) => done(String(error)),
      );
    },
    cwd,
    marker,
  );

const heardHere = () => browser.execute(() => window.__heard);

const tabsNow = () =>
  browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke("workspace_tabs").then(done, (error) => done({ error: String(error) }));
  });

/**
 * The current webview's size and its window's client area, both in CSS
 * pixels, and the window it sits in - asked of the window itself, so a webview
 * that did not follow its window shows as a difference.
 */
const fitNow = () =>
  browser.executeAsync((done) => {
    const { invoke, metadata } = window.__TAURI_INTERNALS__;
    const label = metadata.currentWindow.label;
    Promise.all([
      invoke("plugin:window|inner_size", { label }),
      invoke("plugin:window|scale_factor", { label }),
    ]).then(
      ([size, scale]) =>
        done({
          window: label,
          page: [window.innerWidth, window.innerHeight],
          client: [Math.round(size.width / scale), Math.round(size.height / scale)],
        }),
      (error) => done({ error: String(error) }),
    );
  });

/**
 * Whether a page fills its window's client area. One pixel either way is the
 * rounding between the window's physical pixels and the page's CSS pixels.
 */
const fills = (fit) => fit.page.every((side, index) => Math.abs(side - fit.client[index]) <= 1);

/** Clicks a real element of the strip, in the current webview. */
async function clickInStrip(selector, button = "left") {
  const target = await $(`nav[aria-label="Workspaces"] ${selector}`);
  await target.waitForExist({ timeout: 10_000, timeoutMsg: `nothing in the strip matches ${selector}` });
  await target.click({ button });
}

describe("Workspace tabs", () => {
  const first = project("first");
  const second = project("second");
  const third = project("third");
  const fourth = project("fourth");

  after(() => {
    for (const dir of [first, second, third, fourth]) {
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

  it("keeps what one tab's terminal prints and one tab's folder does to that tab", async () => {
    await openFromRecent(third);
    const one = (await tabsNow()).active;
    const two = await openTab(fourth);

    await inWorkspace(one);
    assert.equal(await hearHere(), true);
    await inWorkspace(two);
    assert.equal(await hearHere(), true);

    await inWorkspace(one);
    const termOne = await echoInTerminal(third, "PRINTED_IN_ONE");
    await inWorkspace(two);
    const termTwo = await echoInTerminal(fourth, "PRINTED_IN_TWO");
    fs.writeFileSync(path.join(third, "written-in-one.txt"), "x\n");

    await inWorkspace(one);
    await browser.waitUntil(
      async () => {
        const heard = await heardHere();
        return (
          heard.term.includes("PRINTED_IN_ONE") &&
          heard.files.some((file) => file.endsWith("written-in-one.txt"))
        );
      },
      { timeout: 30_000, interval: 250, timeoutMsg: "the first tab never heard its own terminal and folder" },
    );
    await inWorkspace(two);
    await browser.waitUntil(async () => (await heardHere()).term.includes("PRINTED_IN_TWO"), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "the second tab never heard its own terminal",
    });

    // Each heard only its own.
    const heardByTwo = await heardHere();
    assert.ok(!heardByTwo.term.includes("PRINTED_IN_ONE"), "the first tab's terminal reached the second tab");
    assert.deepEqual(
      heardByTwo.files.filter((file) => file.endsWith("written-in-one.txt")),
      [],
      "a file changed in the first tab's folder was announced to the second tab",
    );
    await inWorkspace(one);
    assert.ok(
      !(await heardHere()).term.includes("PRINTED_IN_TWO"),
      "the second tab's terminal reached the first tab",
    );

    for (const [label, termId] of [
      [one, termOne],
      [two, termTwo],
    ]) {
      await inWorkspace(label);
      await browser.executeAsync((id, done) => {
        window.__TAURI_INTERNALS__.invoke("term_kill", { termId: id }).then(done, done);
      }, termId);
    }
    await inWorkspace(one);
    await browser.execute((label) => {
      void window.__TAURI_INTERNALS__.invoke("workspace_close", { label });
    }, two);
    await browser.waitUntil(async () => (await tabsNow()).tabs.length === 1, {
      timeout: 20_000,
      timeoutMsg: "closing the second tab left it in the strip",
    });
  });

  it("fits every tab to its window when the window changes size, the one parked beside it too", async () => {
    await openFromRecent(first);
    const parkedTab = (await tabsNow()).active;
    const shownTab = await openTab(second);
    const outer = await browser.executeAsync((done) => {
      const { invoke, metadata } = window.__TAURI_INTERNALS__;
      invoke("plugin:window|outer_size", { label: metadata.currentWindow.label }).then(done, done);
    });
    const before = await fitNow();

    try {
      resizeAppWindow(outer.width - 300, outer.height - 200);
      // The page on screen and the one parked beside it both follow, because
      // the window's resize moves them (`workspaces::layout`).
      for (const label of [shownTab, parkedTab]) {
        await inWorkspace(label);
        try {
          await browser.waitUntil(
            async () => {
              const fit = await fitNow();
              return fit.client[0] < before.client[0] && fills(fit);
            },
            { timeout: 10_000, interval: 200 },
          );
        } catch {
          throw new Error(`${label} did not follow its window: ${JSON.stringify(await fitNow())}`);
        }
      }
    } finally {
      resizeAppWindow(outer.width, outer.height);
    }
  });

  it("closes the tab on screen by its x, and the tab beside it takes its place", async () => {
    const { tabs, active } = await tabsNow();
    assert.equal(
      tabs.length,
      2,
      `the window should hold the two tabs of the previous case: ${JSON.stringify(tabs)}`,
    );
    const neighbour = tabs.find((tab) => tab.label !== active)?.label;

    await clickInStrip(`[data-workspace-tab="${active}"] button[title="Close this workspace"]`);
    await inWorkspace(neighbour);
    await browser.waitUntil(
      async () => {
        const now = await tabsNow();
        return now.tabs.length === 1 && now.active === neighbour;
      },
      { timeout: 20_000, interval: 250, timeoutMsg: "the neighbour never took the closed tab's place" },
    );
    assert.ok(
      (await $("body").getText()).includes("first.txt"),
      "the tab that came on screen lost its folder",
    );
    const handles = [];
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      handles.push(await browser.execute(() => window.__TAURI_INTERNALS__.metadata.currentWebview.label));
    }
    assert.ok(!handles.includes(active), `the closed tab's webview is still alive: ${handles}`);
  });

  it("takes a tab out into a window of its own from its right-click menu", async () => {
    await inWorkspace((await tabsNow()).active);
    const staying = (await tabsNow()).active;
    const leaving = await openTab(third);

    // From the tab on screen, the other tab's menu: the one taken out is not
    // the one the person is looking at.
    await clickInStrip(`[data-workspace-tab="${staying}"]`, "right");
    const item = await $("//*[@role='menuitem'][contains(., 'Open in a window of its own')]");
    await item.waitForExist({ timeout: 10_000, timeoutMsg: "the tab's menu offers no way to take it out" });
    await item.click();

    // Asked of the backend: the page's own idea of its window is fixed when the
    // page is made, and a webview moved to another window keeps the old name.
    await inWorkspace(staying);
    await browser.waitUntil(
      async () => {
        const own = await tabsNow();
        return own.tabs.length === 1 && own.tabs[0].label === staying;
      },
      { timeout: 20_000, interval: 250, timeoutMsg: "the tab never left its window" },
    );
    // A window of its own opens at the restore size (`window_cmds::IDEAL_RESTORE`,
    // parked off the desktop in an unattended run), and the tab fills it.
    const { page } = await fitNow();
    assert.ok(
      Math.abs(page[0] - 1280) <= 1 && Math.abs(page[1] - 800) <= 1,
      `the tab does not fill its new window: ${JSON.stringify(page)}`,
    );

    await inWorkspace(leaving);
    const left = await tabsNow();
    assert.deepEqual(
      left.tabs.map((tab) => tab.label),
      [leaving],
      "the tab taken out is still in the window it left",
    );
    assert.equal(left.active, leaving);

    // Close the window of its own through its last tab, as its x would.
    await inWorkspace(staying);
    await browser.execute((label) => {
      void window.__TAURI_INTERNALS__.invoke("workspace_close", { label });
    }, staying);
    await inWorkspace(leaving);
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
      timeout: 20_000,
      timeoutMsg: "closing the last tab of the window of its own left the window open",
    });
  });
});
