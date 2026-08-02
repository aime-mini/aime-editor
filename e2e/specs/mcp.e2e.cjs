/**
 * The MCP dialog, measured rather than eyeballed.
 *
 * It broke once by growing two scrolling regions that fought over the dialog's
 * height until the form slid under the footer, and nothing in a unit test can
 * see that. These assertions compare real rectangles, so the same mistake
 * fails here instead of in a screenshot from a user.
 */
const { strict: assert } = require("node:assert");
const { workspace } = require("../wdio.conf.cjs");

/** CSS can upper-case what it renders, so matching ignores case. */
async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/** Where an element sits on screen, in page coordinates. */
async function boxOf(selector) {
  return browser.execute((css) => {
    const element = document.querySelector(css);
    if (!element) return null;
    const { top, bottom, left, right } = element.getBoundingClientRect();
    return { top, bottom, left, right };
  }, selector);
}

describe("MCP dialog", () => {
  before(async () => {
    await browser.execute((path) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await waitForText("RECENT");
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await waitForText("hello.ts", "the workspace never opened");

    await browser.keys(["Control", "k"]);
    await waitForText("Esc");
    await browser.keys(["MCP"]);
    await browser.keys(["Enter"]);
    await waitForText("Add server", "the MCP dialog never opened");
  });

  after(async () => {
    await browser.keys(["Escape"]);
  });

  it("keeps every part inside the dialog", async () => {
    // The dialog is the only element with this exact width class combination.
    const dialog = await boxOf(".fixed.inset-0.z-50 > div");
    const addButton = await browser.execute(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.trim().endsWith("Add server"),
      );
      if (!button) return null;
      const { top, bottom } = button.getBoundingClientRect();
      return { top, bottom };
    });

    assert.ok(dialog && addButton, "the dialog or its add button was not found");
    assert.ok(
      addButton.bottom <= dialog.bottom + 1,
      `the add button (${addButton.bottom}) hangs below the dialog (${dialog.bottom})`,
    );
    assert.ok(addButton.top >= dialog.top, "the add button sits above the dialog");
  });

  it("does not let the form collide with its explanation", async () => {
    const overlap = await browser.execute(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.trim().endsWith("Add server"),
      );
      const hint = [...document.querySelectorAll("p")].find((candidate) =>
        candidate.textContent?.includes("A URL is added as an HTTP server"),
      );
      if (!button || !hint) return null;
      const a = button.getBoundingClientRect();
      const b = hint.getBoundingClientRect();
      // Two boxes overlap when neither sits entirely above the other.
      return a.top < b.bottom && b.top < a.bottom;
    });

    assert.equal(overlap, false, "the add button overlaps the form's explanation");
  });

  it("swaps between the server list and the catalog instead of stacking them", async () => {
    // Matched by a distinctive word: the label carries an icon and an ampersand.
    await browser.execute(() => {
      [...document.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.includes("Browse"))
        ?.click();
    });
    await waitForText("Design", "the catalog never opened");

    // The form's explanation belongs to the list view; seeing it while the
    // catalog is open would mean both are stacked again.
    const body = (await $("body").getText()).toLowerCase();
    assert.ok(
      !body.includes("mcp servers give the ai new tools"),
      "the list view's own header is still on screen underneath the catalog",
    );

    await browser.execute(() => {
      [...document.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.includes("Back to my servers"))
        ?.click();
    });
    // Back on the list: the catalog's own headings are gone. Asserting on the
    // list's contents would depend on which servers this machine happens to
    // have, which is not what this test is about.
    await browser.waitUntil(
      async () => !(await $("body").getText()).toLowerCase().includes("issues & boards"),
      { timeout: 15_000, timeoutMsg: "the catalog stayed on screen after going back" },
    );
  });
});
