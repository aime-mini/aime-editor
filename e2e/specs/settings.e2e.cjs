/**
 * Settings and the ghost-text switch, driven against the real window.
 *
 * Neither can be unit-tested: one is a keyboard shortcut reaching a modal, the
 * other a status-bar chip whose whole job is to make an invisible mode visible.
 * No AI call is made here - the modes are checked, not the model, so the suite
 * stays free and works on a machine with no CLI signed in.
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

/**
 * One cloud's row in the settings page, by the label it carries.
 *
 * Anchored to the row rather than read off the page: an install URL or an
 * account name found anywhere in the body would satisfy a page-wide search,
 * and a check that cannot tell those apart proves nothing about the row.
 */
async function cloudRow(label) {
  return browser.execute((name) => {
    const rows = [...document.querySelectorAll("div.flex.items-center")];
    const row = rows.find((candidate) => {
      const own = candidate.querySelector("span");
      return own !== null && own.textContent === name;
    });
    return row?.textContent ?? "";
  }, label);
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

  it("lists every cloud, and gives each row its own next step", async () => {
    // Runs while the page is already open, and leaves it open: the test after
    // this one is the one that closes it.
    await browser.waitUntil(async () => (await $$("div.fixed.inset-0.z-50")).length > 0, {
      timeout: 5_000,
      timeoutMsg: "the settings page is not open",
    });

    // The rows arrive late on purpose: each probe shells out to a cloud CLI and
    // two of them ask the cloud who you are over the network. Waiting on the
    // row rather than on a timer is what keeps this from being flaky on a slow
    // link - and the panel says "looking" until then, which is the honest state.
    await browser.waitUntil(async () => (await cloudRow("Azure")) !== "", {
      timeout: 60_000,
      timeoutMsg: "the cloud rows never arrived",
    });

    // The feature's whole promise is that connecting never involves handing
    // Aime a secret, so the page has to say so where a reader will see it.
    const page = await browser.execute(
      () => document.querySelector("div.fixed.inset-0.z-50")?.textContent ?? "",
    );
    assert.match(page, /never asks for a key/, "the page does not say Aime asks for no key");

    // Four rows, and none of them blank: a row that knows nothing to offer is
    // the one failure mode here that looks like a working panel.
    for (const label of ["Azure", "AWS", "Google Cloud", "Supabase"]) {
      const row = await cloudRow(label);
      assert.ok(row.includes(label), `no row for ${label}`);
      assert.ok(row.replace(label, "").trim().length > 0, `the ${label} row offers nothing: "${row}"`);
    }

    // Machine-independent on purpose: this machine has the Azure and AWS CLIs
    // and not the other two, so what is asserted is the shape of each answer
    // rather than which clouds happen to be installed here.
    const gcp = await cloudRow("Google Cloud");
    assert.ok(
      /gcloud|cloud\.google\.com/.test(gcp),
      `the Google Cloud row says nothing about its CLI: "${gcp}"`,
    );
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
