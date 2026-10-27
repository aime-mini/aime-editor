/**
 * Close the folder, open it again: the terminal must come back with a prompt.
 *
 * What actually broke here was a listener race, not layout: term:data was
 * subscribed only after term_create returned, and a warm PowerShell on a busy
 * reopen prints its entire prompt into that gap — a Tauri event nobody listens
 * to is dropped, so the pane stayed blank forever. The proof was instrumented
 * (created id:3 at t=10722, first chunk t=10724, listener ready t=10745, then
 * silence) against a heavy real repository; this scratch workspace cannot force
 * that timing, so this spec is the regression net, not the proof.
 */
const { strict: assert } = require("node:assert");
const { workspace } = require("../wdio.conf.cjs");

const folder = workspace.split(/[\\/]/).pop();

async function screenText() {
  return browser.execute(() => document.querySelector(".xterm-rows")?.textContent ?? "");
}

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

async function waitForPrompt(where) {
  let painted = "";
  await browser
    .waitUntil(
      async () => {
        painted = await screenText();
        return painted.includes(folder);
      },
      { timeout: 30_000 },
    )
    .catch(() => {
      assert.fail(`no prompt ${where}. painted=${JSON.stringify(painted)}`);
    });
}

async function closeFolderFromTree() {
  await browser.execute(() => {
    const close = document.querySelector('button[title="Close Folder"]');
    if (!(close instanceof HTMLElement)) throw new Error("no Close Folder button");
    close.click();
  });
}

describe("Terminal after closing and reopening the folder", () => {
  before(async () => {
    await browser.execute((path) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${folder}`)).click();
    await waitForText("hello.ts", "the workspace never opened");
  });

  it("prints a prompt again after every close/reopen cycle", async () => {
    // First open: known-good since the session-start fix.
    await browser.keys(["Control", "`"]);
    await browser.waitUntil(async () => (await $$(".xterm-rows")).length > 0, {
      timeout: 10_000,
      timeoutMsg: "the terminal pane never mounted",
    });
    await waitForPrompt("on first open");

    // Reopened panes mount together with the whole workbench (the layout store
    // survives the welcome screen), and each cycle leaves PowerShell warmer —
    // the two ingredients of the race. Three cycles keep the spec honest
    // without pretending to be the instrumented proof.
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await closeFolderFromTree();
      await waitForText("RECENT", `the welcome screen never came back (cycle ${cycle})`);
      await (await $(`span=${folder}`)).click();
      await waitForText("hello.ts", `the workspace never reopened (cycle ${cycle})`);
      await browser.waitUntil(async () => (await $$(".xterm-rows")).length > 0, {
        timeout: 10_000,
        timeoutMsg: `the terminal pane never remounted (cycle ${cycle})`,
      });
      await waitForPrompt(`after reopen cycle ${cycle}`);
    }
  });
});
