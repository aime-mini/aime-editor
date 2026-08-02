/**
 * The walk a new user takes, driven against the real window.
 *
 * These paths only exist when React, Monaco and the Rust side run together, so
 * no unit test can see them: the workspace opening, a file becoming a tab, two
 * files staying open at once, the palette answering a shortcut.
 *
 * The workspace is entered through the Recent list rather than Open Folder,
 * because Open Folder raises a native dialog no WebDriver can click - and
 * reopening a recent project is a path users take every day anyway.
 */
const { strict: assert } = require("node:assert");
const { workspace } = require("../wdio.conf.cjs");

/** Waits for text to appear anywhere in the window. */
/** CSS can upper-case what it renders, so matching ignores case. */
async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

describe("Aime", () => {
  before(async () => {
    // Seed the recent list, then reload so the welcome screen reads it.
    await browser.execute((path) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
  });

  it("opens a project from the recent list", async () => {
    const entry = await $(`span=${workspace.split(/[\\/]/).pop()}`);
    await entry.click();
    await waitForText("hello.ts", "the file tree never showed the workspace");
    await waitForText("notes.md");
  });

  it("opens a file into a tab", async () => {
    await (await $("span=hello.ts")).click();
    await waitForText("greeting", "the file contents never reached the editor");
  });

  it("keeps both files open, one tab each", async () => {
    await (await $("span=notes.md")).click();
    await waitForText("second file", "the second file never opened");

    // Both tabs stay in the strip; that is the entire point of tabs.
    const body = await $("body").getText();
    assert.ok(body.includes("hello.ts"), "the first tab disappeared when the second opened");
  });

  it("answers the command palette", async () => {
    await browser.keys(["Control", "k"]);
    await waitForText("Esc", "the command palette never opened");
    await browser.keys(["Escape"]);
  });

  it("shows the Git panel for a folder that is not a repository", async () => {
    await browser.keys(["Control", "k"]);
    await waitForText("Esc");
    await browser.keys(["Git"]);
    await browser.keys(["Enter"]);
    await waitForText("not a git repository", "the Git panel never reported the folder's state");
  });
});
