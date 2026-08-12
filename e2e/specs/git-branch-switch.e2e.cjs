/**
 * Switching branches under the app: the panel must follow, not freeze.
 *
 * A checkout that rewrites hundreds of files makes the watcher fire burst
 * after burst while the checkout is still running; every burst used to start
 * four more git processes, and the panel could be left on the old branch until
 * the app was restarted. The checkout here runs outside the app — the same
 * shape as a user switching branches in a terminal.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-branches-"));
const FILES = 300;

function git(...args) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

// Two branches that disagree on every file, so a checkout rewrites all of them.
git("init", "-b", "main");
git("config", "user.email", "e2e@aime.test");
git("config", "user.name", "Aime E2E");
for (let i = 0; i < FILES; i += 1) {
  fs.writeFileSync(path.join(repo, `file-${i}.txt`), `main content ${i}\n`);
}
git("add", ".");
git("commit", "-m", "main state");
git("checkout", "-b", "feature");
for (let i = 0; i < FILES; i += 1) {
  fs.writeFileSync(path.join(repo, `file-${i}.txt`), `feature content ${i}\n`);
}
git("add", ".");
git("commit", "-m", "feature state");
git("checkout", "main");

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

async function waitForBranch(name) {
  await browser
    .waitUntil(
      async () => {
        const body = await $("body").getText();
        return body.includes(name);
      },
      { timeout: 20_000 },
    )
    .catch(async () => {
      const body = await $("body").getText();
      assert.fail(`the app never showed branch "${name}". body=${JSON.stringify(body.slice(0, 400))}`);
    });
}

describe("Git panel across an external branch switch", () => {
  before(async () => {
    await browser.execute((folder) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
    }, repo);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${path.basename(repo)}`)).click();
    await waitForText("file-0.txt", "the workspace never opened");
    await waitForBranch("main");
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("follows a checkout to the other branch and back without a restart", async () => {
    git("checkout", "feature");
    await waitForBranch("feature");

    git("checkout", "main");
    await waitForBranch("main");

    // The worktree is clean on both sides, so a panel that settled correctly
    // reports no pending changes — a stale status would still list hundreds.
    const clean = await browser.waitUntil(
      async () => {
        const files = await browser.execute(() => {
          const panel = document.body.textContent ?? "";
          return !/file-\d+\.txt\s*M/.test(panel);
        });
        return files;
      },
      { timeout: 10_000, timeoutMsg: "the panel kept listing changes on a clean worktree" },
    );
    assert.ok(clean);
  });
});
