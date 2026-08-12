/**
 * What a chat message is allowed to do to the panel it lives in.
 *
 * A tool call carries a command, and commands are long: `PowerShell · cd
 * C:\Projects\...` drew straight past the right edge of the panel, because the
 * chip was capped at a fixed 13rem the panel never agreed to. Nothing but a
 * laid-out browser can see that - jsdom has no geometry - so it is measured
 * here, against the real window.
 *
 * The conversation is planted through the app's own session store rather than
 * by running a turn: the suite must stay free and must not need a signed-in CLI.
 */
const { strict: assert } = require("node:assert");
const { workspace } = require("../wdio.conf.cjs");

const LONG_COMMAND =
  "cd C:\\Projects\\IODM-Shop\\IODM.Shop.Api\\src\\Services\\Catalog && dotnet build --configuration Release";
/** Roughly the window the screenshot of this bug was taken in. */
const NARROW_WINDOW = { width: 900, height: 800 };
/** No spaces at all: the case a bubble cannot wrap its way out of. */
const UNBREAKABLE_PATH = `C:\\Projects\\IODM-Shop\\${"segment".repeat(20)}\\file.cs`;
/** A backslash is CSS's own escape character, so a Windows path is doubled. */
const TOOL_CHIP = `span[title="${LONG_COMMAND.replaceAll("\\", "\\\\")}"]`;

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/**
 * How far the conversation reaches past the box that scrolls it.
 *
 * The measurement is anchored on the message list itself, found from the chip
 * inside it, because that box is the edge a reader sees: content wider than it
 * is either clipped or only reachable by scrolling sideways through a chat.
 * A pixel of slack absorbs sub-pixel rounding in the layout engine.
 */
async function overflowingTheMessageList() {
  return browser.execute((selector) => {
    const chip = document.querySelector(selector);
    const list = chip?.closest(".overflow-y-auto");
    if (!list) return { found: false, over: 0, culprits: [] };
    const edge = list.getBoundingClientRect().right;
    const culprits = [...list.querySelectorAll("*")]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.right > edge + 1)
      .map(({ element, box }) => ({
        what: `${element.tagName.toLowerCase()}.${String(element.className)}`.slice(0, 90),
        by: Math.round(box.right - edge),
      }));
    return { found: true, over: list.scrollWidth - list.clientWidth, culprits };
  }, TOOL_CHIP);
}

describe("Chat layout", () => {
  before(async () => {
    // The panel restores the newest conversation of the selected CLI, so this
    // is planted under the default provider, through the command the app
    // itself saves with.
    await browser.execute(
      (path, command, longPath) => {
        localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
        window.__aimeSessionPlanted = false;
        void window.__TAURI_INTERNALS__.invoke("save_ai_sessions", {
          rootPath: path,
          sessions: {
            version: 1,
            sessions: [
              {
                localId: "chat-layout",
                sessionId: null,
                title: "chat layout",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                totalCostUsd: 0,
                providerId: "claude",
                messages: [
                  { role: "user", parts: [{ kind: "text", text: longPath }] },
                  {
                    role: "assistant",
                    parts: [
                      { kind: "text", text: "Final sweep with parameters supplied:" },
                      { kind: "tool", name: "PowerShell", detail: command },
                    ],
                  },
                ],
              },
            ],
          },
        }).then(() => {
          window.__aimeSessionPlanted = true;
        });
      },
      workspace,
      LONG_COMMAND,
      UNBREAKABLE_PATH,
    );
    await browser.waitUntil(async () => browser.execute(() => window.__aimeSessionPlanted === true), {
      timeout: 10_000,
      timeoutMsg: "the conversation was never written to the session store",
    });
    // A narrow window is the whole point: the AI panel takes a share of it, and
    // a chip that insists on a fixed 13rem only draws past the edge once the
    // panel is narrower than the chip. This is the window the bug was seen in.
    await browser.setWindowSize(NARROW_WINDOW.width, NARROW_WINDOW.height);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await waitForText("hello.ts", "the workspace never opened");
    await waitForText("final sweep", "the planted conversation never reached the panel");
  });

  it("keeps a long tool command inside the message list", async () => {
    const overflow = await overflowingTheMessageList();
    assert.ok(overflow.found, "the planted tool chip was never rendered");
    assert.deepEqual(
      { over: overflow.over, culprits: overflow.culprits },
      { over: 0, culprits: [] },
      "chat content reached outside the box that scrolls it",
    );
  });

  it("still shows the command, shortened rather than clipped away", async () => {
    // The whole command stays reachable on hover even when the panel is too
    // narrow to print it - shortening is not the same as losing it.
    const chip = await $(TOOL_CHIP);
    assert.ok(await chip.isDisplayed(), "the tool chip vanished instead of being shortened");
    assert.ok(
      (await chip.getText()).includes("PowerShell"),
      "the chip no longer says which tool ran",
    );
  });
});
