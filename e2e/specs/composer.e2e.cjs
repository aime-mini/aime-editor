/**
 * The AI composer: project-aware starters and `@` file mentions.
 *
 * Both only exist once React, the Rust file walk and the real project meet, so
 * this is the only place they can be checked. No prompt is ever sent - the
 * suite must stay free and must not need a signed-in CLI.
 */
const { strict: assert } = require("node:assert");
const { workspace } = require("../wdio.conf.cjs");

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

// Monaco keeps a hidden textarea of its own for IME input; the composer is
// the one with a placeholder.
const composer = () => $("textarea[placeholder]");

describe("AI composer", () => {
  before(async () => {
    await browser.execute((path) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await waitForText("hello.ts", "the workspace never opened");
  });

  it("suggests the open file, by name, once one is open", async () => {
    // Nothing open yet: the project-level starter is what there is to offer.
    await waitForText("what does this project do", "the empty panel offered nothing");

    await (await $("span=hello.ts")).click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("Explain hello.ts"), {
      timeout: 30_000,
      timeoutMsg: "the starters never noticed the open file",
    });
  });

  it("offers a README to a project that has none", async () => {
    await waitForText("write a readme", "a project without a README was not offered one");
  });

  it("opens a file picker on @ and puts the path in the message", async () => {
    const box = await composer();
    await box.click();
    await browser.keys(["@", "n", "o", "t", "e"]);

    // The picker lists the file, not the folder.
    await waitForText("notes.md", "the @ picker never listed the match");
    await browser.keys(["Enter"]);

    await browser.waitUntil(async () => (await (await composer()).getValue()).includes("@notes.md"), {
      timeout: 5_000,
      timeoutMsg: "choosing a file did not put its path in the message",
    });
    const value = await (await composer()).getValue();
    assert.ok(value.endsWith(" "), "the path should be followed by a space to type after");
  });

  it("does not open a picker for an @ inside a word", async () => {
    const box = await composer();
    await box.clearValue();
    await box.click();
    await browser.keys("mail me@no".split(""));
    // The picker is a list rendered above the box; nothing should appear.
    const suggestions = await $$("ul.absolute button");
    assert.equal(suggestions.length, 0, "an email address opened the file picker");
    await box.clearValue();
  });
});
