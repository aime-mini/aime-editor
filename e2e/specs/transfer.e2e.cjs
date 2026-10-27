/**
 * Changing machines: a transfer pack (`src-tauri/src/transfer.rs`).
 *
 * A project's chat and memory are packed on one machine and received on
 * another, where the project sits at a different path and is only cloned
 * later. The "other machine" is this one with the pack imported before the
 * clone exists: the project waits, and the clone - opened at a path the pack
 * never saw - is recognised by its history and takes the chat and the memory.
 * The native file dialogs cannot be driven here, so the pack is made and read
 * through the same commands the Settings buttons call; the buttons themselves
 * are checked to be there.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONVERSATION = "Moved conversation about rivers";
const NOTE = "rivers-memory.md";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aime-transfer-"));
const origin = path.join(scratch, "origin", "shop");
const clone = path.join(scratch, "elsewhere", "shop-again");
const pack = path.join(scratch, "pack.zip");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** A repository with one commit, and a clone of it under a different name elsewhere. */
function makeRepositories() {
  fs.mkdirSync(origin, { recursive: true });
  fs.writeFileSync(path.join(origin, "README.md"), "# shop\n");
  git(origin, "init", "-b", "main");
  git(origin, "config", "user.email", "e2e@aime.test");
  git(origin, "config", "user.name", "Aime E2E");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "first");
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  git(path.dirname(clone), "clone", "--quiet", origin, path.basename(clone));
}

const invoke = (command, args) =>
  browser.executeAsync(
    (name, params, done) => {
      window.__TAURI_INTERNALS__.invoke(name, params).then(done, (error) => done({ error: String(error) }));
    },
    command,
    args,
  );

const tabsNow = () => invoke("workspace_tabs", {});

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
  await browser.waitUntil(async () => (await $("body").getText()).includes("README.md"), {
    timeout: 30_000,
    timeoutMsg: `${folder} never opened`,
  });
}

/** Opens `folder` as a new tab and switches to its webview once it is on screen. */
async function openAsTab(folder) {
  await invoke("workspace_open", { folder });
  let label = null;
  await browser.waitUntil(
    async () => {
      const { tabs, active } = await tabsNow();
      label = active;
      return tabs.some((tab) => tab.label === active && tab.folder === folder && !tab.loading);
    },
    { timeout: 60_000, interval: 250, timeoutMsg: `${folder} never came on screen as a tab` },
  );
  for (const handle of await browser.getWindowHandles()) {
    await browser.switchToWindow(handle);
    const here = await browser.execute(() => window.__TAURI_INTERNALS__.metadata.currentWebview.label);
    if (here === label) return;
  }
  throw new Error(`no webview for ${label}`);
}

describe("Changing machines", () => {
  before(makeRepositories);

  after(async () => {
    const { tabs } = await tabsNow();
    for (const tab of tabs.slice(1)) await invoke("workspace_close", { label: tab.label });
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on a folder a window still has open.
    }
  });

  it("offers the pack in Settings, both ways", async () => {
    await openFromRecent(origin);
    await (await $('button[title="Settings"]')).click();
    const exportButton = await $('[data-transfer="export"]');
    await exportButton.waitForExist({ timeout: 10_000, timeoutMsg: "Settings has no export button" });
    assert.ok(await $('[data-transfer="import"]').isExisting(), "Settings has no import button");
    await browser.keys("Escape");
  });

  it("packs a project's chat and memory, and a clone opened elsewhere takes them", async () => {
    // What the old machine knew: one conversation, one memory note.
    const conversation = {
      localId: "moved-1",
      sessionId: null,
      title: CONVERSATION,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      totalCostUsd: 0,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Tell me about rivers." }] },
        { role: "assistant", parts: [{ kind: "text", text: "Rivers run downhill." }] },
      ],
      providerId: "claude",
    };
    const saved = await invoke("save_ai_sessions", {
      rootPath: origin,
      sessions: { version: 1, sessions: [conversation] },
    });
    assert.equal(saved?.error, undefined, `could not seed the chat: ${saved?.error}`);
    fs.mkdirSync(path.join(origin, ".aime", "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(origin, ".aime", "memory", NOTE),
      "---\nname: rivers\n---\nRivers run downhill.\n",
    );

    const exported = await invoke("transfer_export", { roots: [origin], target: pack });
    assert.deepEqual(exported, { projects: 1, chats: 1, memories: 1, transcripts: 0, transcriptsMissing: 0 });
    assert.ok(fs.existsSync(pack), "no pack was written");

    // The new machine, before the clone exists: nothing matches, so it waits.
    const imported = await invoke("transfer_import", { archive: pack, candidates: [] });
    assert.deepEqual(imported.pending, ["shop"], JSON.stringify(imported));
    assert.deepEqual(imported.adopted, []);

    // The clone opens at a path the pack never saw, and is known by its history.
    await openAsTab(clone);
    await browser.waitUntil(() => fs.existsSync(path.join(clone, ".aime", "memory", NOTE)), {
      timeout: 20_000,
      timeoutMsg: "the memory note did not reach the clone",
    });
    const notice = await $('[data-notice="told"]');
    await notice.waitForExist({ timeout: 10_000, timeoutMsg: "nobody was told the project came back" });
    assert.ok((await notice.getText()).includes("shop"), await notice.getText());

    const store = await invoke("load_ai_sessions", { rootPath: clone });
    assert.equal(store?.sessions?.[0]?.title, CONVERSATION, `the clone's chats: ${JSON.stringify(store)}`);
    await (await $('button[title="Previous sessions"]')).click();
    const item = await $(`//*[@role='menuitem'][contains(., '${CONVERSATION}')]`);
    await item.waitForExist({
      timeout: 10_000,
      timeoutMsg: "the old conversation is not in the clone's history",
    });
    await browser.keys("Escape");
  });
});
