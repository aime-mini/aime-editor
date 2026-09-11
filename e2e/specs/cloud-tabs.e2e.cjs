/**
 * Which clouds get a tab, driven through the real window.
 *
 * Asked for 2026-09-09: the panel opened with a tab for all four vendors, and
 * most people use one or two. What has to hold is a chain, not a dialog: the
 * question is asked once, only the ticked clouds get a strip, a tab can be
 * closed from the strip, the plus brings one back, and a restart still shows
 * the same tabs. Every assertion here is anchored to the panel's own nav and
 * to the picker's dialog rather than to the text of the whole page, so a
 * cloud's name appearing somewhere else can never make this pass.
 *
 * Nothing is signed in or out here and no cloud is called on purpose: the
 * probes this leans on are the ones the panel already runs to fill its dots.
 */
const { strict: assert } = require("node:assert");
const { workspace } = require("../wdio.conf.cjs");

const CLOUD_BUTTON = 'button[title="Clouds - accounts, applications and what is running in them"]';
const TABS = 'nav[aria-label="Clouds"] > div';
const DIALOG = 'div[role="dialog"]';

/** The labels on the tab strip, in the order they are drawn. */
async function tabLabels() {
  return browser.execute((selector) => {
    return [...document.querySelectorAll(selector)].map((tab) => (tab.textContent ?? "").trim());
  }, TABS);
}

/** Whether the picker is on screen - by its own dialog, not by its words. */
async function pickerIsOpen() {
  return (await $(DIALOG)).isExisting();
}

/** One row of the picker, by the vendor's name. */
async function pickerRow(label) {
  const rows = await $$(`${DIALOG} label`);
  for (const row of rows) {
    if ((await row.getText()).includes(label)) return row;
  }
  throw new Error(`the picker has no row for ${label}`);
}

/** How many rows the picker has ticked, read from the checkboxes themselves. */
async function tickedCount() {
  return browser.execute((selector) => {
    return [...document.querySelectorAll(`${selector} input[type=checkbox]`)].filter((box) => box.checked)
      .length;
  }, DIALOG);
}

/** Confirms the picker: the button that says how many clouds will be shown. */
async function confirmPicker() {
  const buttons = await $$(`${DIALOG} button`);
  for (const button of buttons) {
    if ((await button.getText()).startsWith("Show ")) {
      await button.click();
      return;
    }
  }
  throw new Error("the picker has no button to confirm with");
}

/**
 * Opens the workspace from the recent list, which is how every spec here
 * enters: a reload drops the folder the app was launched with, and Open Folder
 * raises a native dialog no driver can click.
 */
async function openWorkspace() {
  await browser.waitUntil(async () => (await $("body").getText()).toUpperCase().includes("RECENT"), {
    timeout: 60_000,
    timeoutMsg: "the welcome screen never rendered",
  });
  await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
  await browser.waitUntil(async () => (await $(CLOUD_BUTTON)).isExisting(), {
    timeout: 60_000,
    timeoutMsg: "the status bar never offered the cloud panel",
  });
}

async function openPanel() {
  await (await $(CLOUD_BUTTON)).click();
  await browser.waitUntil(async () => (await $('nav[aria-label="Clouds"]')).isExisting(), {
    timeout: 30_000,
    timeoutMsg: "the cloud panel never opened",
  });
}

describe("Cloud tabs", () => {
  before(async () => {
    await browser.execute((recent) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
      localStorage.removeItem("aime.cloud.shown");
      localStorage.setItem("aime.locale", "en");
      localStorage.setItem("aime.theme", "dark");
    }, workspace);
    await browser.refresh();
    await openWorkspace();
  });

  after(async () => {
    // The choice is a preference of this machine's; leave none behind.
    await browser.execute(() => {
      localStorage.removeItem("aime.cloud.shown");
    });
  });

  it("asks which clouds to show, the first time the panel is opened", async () => {
    await openPanel();
    // The probes shell out to four CLIs before there is anything to choose
    // between, so the question arrives late by design.
    await browser.waitUntil(pickerIsOpen, {
      timeout: 90_000,
      timeoutMsg: "the panel never asked which clouds to show",
    });

    const rows = await $$(`${DIALOG} label`);
    assert.equal(rows.length, 4, "the picker does not offer every cloud");
    for (const label of ["Azure", "AWS", "Google Cloud", "Supabase"]) {
      await pickerRow(label);
    }
    // It starts as the panel stands, which is every cloud until an answer exists.
    assert.equal(await tickedCount(), 4, "the picker did not start from what the panel shows");
  });

  it("gives a tab to the ticked clouds and to nothing else", async () => {
    for (const label of ["AWS", "Supabase"]) {
      await (await pickerRow(label)).click();
    }
    assert.equal(await tickedCount(), 2, "unticking a row did not untick it");
    await confirmPicker();

    await browser.waitUntil(async () => (await tabLabels()).length === 2, {
      timeout: 15_000,
      timeoutMsg: `the strip did not come down to the two clouds ticked: ${JSON.stringify(await tabLabels())}`,
    });
    assert.deepEqual(await tabLabels(), ["Azure", "Google Cloud"]);
    assert.equal(await pickerIsOpen(), false, "the picker stayed open after the choice");
  });

  it("closes one tab from the strip, and the plus brings it back", async () => {
    await (await $(`${TABS}:first-child button`)).click();
    await browser.waitUntil(async () => (await tabLabels()).length === 1, {
      timeout: 15_000,
      timeoutMsg: `closing the tab did not remove it: ${JSON.stringify(await tabLabels())}`,
    });
    assert.deepEqual(await tabLabels(), ["Google Cloud"], "the wrong tab was closed");
    assert.equal(await pickerIsOpen(), false, "closing one tab of two asked the question again");

    await (await $('nav[aria-label="Clouds"] > button')).click();
    await browser.waitUntil(pickerIsOpen, {
      timeout: 15_000,
      timeoutMsg: "the plus did not reopen the picker",
    });
    // It reflects the strip as it now stands - one cloud, not the four it began with.
    assert.equal(await tickedCount(), 1, "the picker forgot what the strip is showing");

    await (await pickerRow("Azure")).click();
    await confirmPicker();
    await browser.waitUntil(async () => (await tabLabels()).length === 2, {
      timeout: 15_000,
      timeoutMsg: `the cloud ticked again did not come back: ${JSON.stringify(await tabLabels())}`,
    });
    assert.deepEqual(await tabLabels(), ["Azure", "Google Cloud"]);
  });

  it("still shows the same tabs after a restart, without asking again", async () => {
    await browser.refresh();
    await openWorkspace();
    await openPanel();

    // Long enough that the probes have answered: with an answer stored, that is
    // when a picker would wrongly reappear.
    await browser.waitUntil(async () => (await tabLabels()).length > 0, {
      timeout: 90_000,
      timeoutMsg: "the tab strip never came back",
    });
    assert.deepEqual(await tabLabels(), ["Azure", "Google Cloud"], "the choice did not survive the reload");
    assert.equal(await pickerIsOpen(), false, "the panel asked again after the choice was made");
  });
});
