/**
 * Settings and the ghost-text switch, driven against the real window.
 *
 * Neither can be unit-tested: one is a keyboard shortcut reaching a modal, the
 * other a status-bar chip whose whole job is to make an invisible mode visible.
 * No AI call is made here - the modes are checked, not the model, so the suite
 * stays free and works on a machine with no CLI signed in.
 */
const { workspace } = require("../wdio.conf.cjs");

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/** The stored preferences, as the app itself would read them back. */
async function storedSettings() {
  return browser.execute(() => JSON.parse(localStorage.getItem("aime.settings") ?? "{}"));
}

/** Font size the editor is painting with, not the one it stored. */
async function renderedFontSize() {
  return browser.execute(() => {
    const line = document.querySelector(".monaco-editor .view-line");
    return line ? getComputedStyle(line).fontSize : "";
  });
}

describe("Settings", () => {
  before(async () => {
    await browser.execute((path) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
      localStorage.removeItem("aime.settings");
    }, workspace);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await waitForText("hello.ts", "the workspace never opened");

    // A file has to be open: half of what this checks is the editor obeying.
    // Waiting on the painted lines, not on the text - Monaco renders late.
    await (await $("span=hello.ts")).click();
    await browser.waitUntil(async () => (await $$(".monaco-editor .view-line")).length > 0, {
      timeout: 30_000,
      timeoutMsg: "the editor never rendered the file",
    });
  });

  it("opens on Ctrl+, and shows every group", async () => {
    await browser.keys(["Control", ","]);
    await waitForText("appearance", "Ctrl+, never opened the settings page");
    for (const group of ["editor", "advanced"]) {
      await waitForText(group, `the ${group} group is missing`);
    }
  });

  it("applies a change to the editor immediately and remembers it", async () => {
    // 18 is the largest offered font size; picking it proves the row is live.
    await (await $("button=18")).click();
    await browser.waitUntil(async () => (await storedSettings()).fontSize === 18, {
      timeout: 5_000,
      timeoutMsg: "the font size was never stored",
    });

    // Stored is not applied: the editor itself has to be painting at 18px.
    await browser.waitUntil(async () => (await renderedFontSize()) === "18px", {
      timeout: 5_000,
      timeoutMsg: "the editor kept its old font size",
    });
  });

  it("closes on Escape", async () => {
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => (await $$("div.fixed.inset-0.z-50")).length === 0, {
      timeout: 5_000,
      timeoutMsg: "Escape left the settings page open",
    });
  });

  it("cycles the ghost-text mode from the status bar", async () => {
    const modeOf = async () => (await storedSettings()).inlineAi;
    await browser.waitUntil(async () => (await modeOf()) === "manual", {
      timeout: 5_000,
      timeoutMsg: "ghost text should start on the asked-for-it mode",
    });

    // Selected by its title: "Auto" alone also matches the model and effort
    // chips, and this is the only button offering to switch a mode.
    const chip = () => $('button[title*="click to switch to"]');
    await (await chip()).click();
    await browser.waitUntil(async () => (await modeOf()) === "auto", {
      timeout: 5_000,
      timeoutMsg: "clicking the chip never switched the mode",
    });
    await (await chip()).click();
    await browser.waitUntil(async () => (await modeOf()) === "off", {
      timeout: 5_000,
      timeoutMsg: "the mode never reached off",
    });
  });

  it("offers the AI suggestion in the editor's own menu", async () => {
    await (await $(".monaco-editor .view-line")).click({ button: "right" });
    await waitForText("suggest code here", "the AI suggestion is missing from the context menu");
    await browser.keys(["Escape"]);
  });
});
