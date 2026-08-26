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
const { fill } = require("../support/fields.cjs");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-branches-"));
const FILES = 300;

/** git's own lock, held for a few milliseconds at a time. */
const LOCK_ATTEMPTS = 5;
const LOCK_WAIT_MS = 200;
/** A synchronous pause: these fixtures run before any test, outside the event loop. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * git in a repository the app is watching too.
 *
 * Aime refreshes its Git panel by running git, so a checkout from here can meet
 * an `index.lock` that refresh is holding - measured 2026-08-26, one run in
 * three. That collision is worth another try; anything else is a real failure
 * and is thrown as one.
 */
function gitIn(cwd, ...args) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync("git", args, { cwd, stdio: "pipe" });
      return;
    } catch (error) {
      const said = String(error.stderr ?? "");
      if (attempt >= LOCK_ATTEMPTS || !said.includes("index.lock")) throw error;
      pause(LOCK_WAIT_MS);
    }
  }
}

function git(...args) {
  gitIn(repo, ...args);
}

/** The branch a repository is standing on right now, straight from git. */
const currentBranch = (cwd) => execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();

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

// And a branch that exists only on a remote, the way a teammate's work does in
// a fresh clone: a local "remote" repository, pushed to, then fetched from -
// nothing ever checked out. The branch menu must still offer it.
const remote = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-remote-"));
execFileSync("git", ["init", "--bare", "-q", remote], { stdio: "pipe" });
git("remote", "add", "origin", remote);
git("push", "-q", "origin", "main");
git("branch", "team/only-on-remote", "main");
git("push", "-q", "origin", "team/only-on-remote");
git("branch", "-D", "team/only-on-remote");
git("fetch", "-q", "origin");

/**
 * A repository the size a team actually produces. Measured on this machine
 * (2026-08-26): the user's own repositories carry 22 and 109 local branches and
 * 20 and 1678 remote-tracking ones, so this fixture is built to the larger of
 * those - a menu that only works for a handful of branches is not a menu that
 * works.
 *
 * The refs are written with `update-ref --stdin`, which is one git call for all
 * of them: creating 1700 branches one command at a time costs a minute of every
 * run, and writing under refs/remotes is exactly what a fetch does anyway.
 */
const crowded = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-crowded-"));
const LOCAL_BRANCHES = 100;
const REMOTE_ONLY_BRANCHES = 1600;
/** Late in the list on purpose: it can only be reached by scrolling or typing. */
const DEEP_BRANCH = "feature/branch-0057";
/**
 * A guard against a tenfold regression, not a target. Measured 2026-08-26 at
 * 1705 branches: the menu opens in ~3s, of which ~2.3s is `git_branches` -
 * `%(refname:short)` makes git disambiguate every ref against every other one.
 * Bringing that down is the next piece of work on this menu.
 */
const MENU_BUDGET_MS = 8000;

gitIn(crowded, "init", "-b", "main");
gitIn(crowded, "config", "user.email", "e2e@aime.test");
gitIn(crowded, "config", "user.name", "Aime E2E");
fs.writeFileSync(path.join(crowded, "crowded.txt"), "one file, a thousand branches" + String.fromCharCode(10));
gitIn(crowded, "add", ".");
gitIn(crowded, "commit", "-m", "first");

const firstCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: crowded }).toString().trim();
const number = (i) => String(i).padStart(4, "0");
const refs = [
  ...Array.from({ length: LOCAL_BRANCHES }, (_, i) => `create refs/heads/feature/branch-${number(i)} ${firstCommit}`),
  ...Array.from(
    { length: REMOTE_ONLY_BRANCHES },
    (_, i) => `create refs/remotes/origin/team/theirs-${number(i)} ${firstCommit}`,
  ),
];
execFileSync("git", ["update-ref", "--stdin"], {
  cwd: crowded,
  input: refs.join(String.fromCharCode(10)) + String.fromCharCode(10),
  stdio: "pipe",
});

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

/** Seeds the recent list with a folder and opens it, the way a user would. */
async function openFolder(dir) {
  await browser.execute((folder) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
  }, dir);
  await browser.refresh();
  await waitForText("RECENT", "the welcome screen never rendered");
  await (await $(`span=${path.basename(dir)}`)).click();
}

/**
 * Opens the branch menu and measures it against the window it has to fit in.
 * A list is only on screen if it is inside the viewport, and only usable if
 * what does not fit can be scrolled to.
 */
async function openBranchMenu() {
  // A menu left open by an earlier assertion would swallow the next click.
  await browser.keys("Escape");
  await browser.waitUntil(async () => !(await $('[role="menu"]').isExisting()), {
    timeout: 5_000,
    timeoutMsg: "a menu stayed open after Escape",
  });
  await (await $('button[title="Git"]')).click();
  const startedAt = Date.now();
  await (await $('button[title="Switch branch"]')).click();
  const measured = await browser.waitUntil(
    async () => {
      const box = await browser.execute(() => {
        const el = document.querySelector('[role="menu"]');
        // The popup keeps the filter box; the group of entries under it is what
        // scrolls, so that is where reachability has to be measured.
        const list = el?.querySelector('[role="group"]');
        if (!el || !list) return null;
        const rect = el.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          viewport: window.innerHeight,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          items: el.querySelectorAll('[role="menuitem"]').length,
        };
      });
      return box && box.items > 0 ? box : false;
    },
    // Polled tightly: the interval is the error bar on how long this took.
    { timeout: 20_000, interval: 50, timeoutMsg: "the branch menu never opened" },
  );
  return { ...measured, elapsed: Date.now() - startedAt };
}

describe("Git panel across an external branch switch", () => {
  before(async () => {
    await openFolder(repo);
    await waitForText("file-0.txt", "the workspace never opened");
    await waitForBranch("main");
  });

  after(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on the folder the app has open; the temp sweep
      // gets what this could not.
    }
  });

  it("offers the branches that exist only on the remote, and checks one out as tracking", async () => {
    // The user's own report: a clone showed nothing but the current branch,
    // because the menu listed local branches and a clone has exactly one.
    await (await $('button[title="Git"]')).click();
    await (await $('button[title="Switch branch"]')).click();
    await waitForText("team/only-on-remote", "the remote-only branch never appeared in the menu");

    // Picking it must create a real local branch tracking the remote one - the
    // assertion is against git itself, not against the label on screen.
    await (await $("button*=team/only-on-remote")).click();
    await browser.waitUntil(
      () =>
        execFileSync("git", ["branch", "--show-current"], { cwd: repo }).toString().trim() ===
        "team/only-on-remote",
      { timeout: 20_000, timeoutMsg: "picking the remote branch did not check it out locally" },
    );
    const upstream = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "team/only-on-remote@{upstream}"],
      { cwd: repo },
    )
      .toString()
      .trim();
    assert.equal(upstream, "origin/team/only-on-remote", "the new local branch tracks nothing");

    // Back to main so the next test starts where it expects to.
    git("checkout", "main");
    await waitForBranch("main");
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

/**
 * The report this is here for (2026-08-26): "clicking git branch shows no list
 * of branches, only the current one". The menu was one column with no height of
 * its own, so on a repository with more branches than fit the window the code
 * meant to keep the menu inside the viewport pushed the whole list off the top
 * of the screen - and what was left on screen was its tail: the actions, and no
 * branches.
 */
describe("The branch menu on a repository a team has been working in", () => {
  before(async () => {
    await openFolder(crowded);
    await waitForText("crowded.txt", "the crowded repository never opened");
    await waitForBranch("main");
  });

  after(() => {
    try {
      fs.rmSync(crowded, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on the folder the app has open; the temp sweep
      // gets what this could not.
    }
  });

  it("puts every branch inside the window, however many there are", async () => {
    const expected = LOCAL_BRANCHES + 1 + REMOTE_ONLY_BRANCHES;
    const menu = await openBranchMenu();
    console.log(`[git-branch-switch.e2e] ${menu.items} entries, menu open in ${menu.elapsed} ms`);
    assert.ok(menu.items >= expected, `the menu offered ${menu.items} entries where ${expected} branches exist`);
    assert.ok(
      menu.elapsed <= MENU_BUDGET_MS,
      `the menu took ${menu.elapsed} ms to open with ${menu.items} entries`,
    );
    assert.ok(
      menu.top >= 0 && menu.bottom <= menu.viewport + 1,
      `the menu sat outside the window: top ${menu.top}, bottom ${menu.bottom}, window ${menu.viewport}`,
    );
    assert.ok(
      menu.scrollHeight > menu.clientHeight,
      "a list taller than the window has to scroll, or every branch below the fold is unreachable",
    );
  });

  it("narrows a long list to the branch that was typed, and checks it out", async () => {
    await openBranchMenu();
    await fill(await $('[role="menu"] input'), DEEP_BRANCH);
    await browser.waitUntil(async () => (await $$('[role="menu"] [role="menuitem"]')).length === 1, {
      timeout: 20_000,
      timeoutMsg: "typing a whole branch name left more than that one branch on the list",
    });

    await (await $('[role="menu"] [role="menuitem"]')).click();
    await browser
      .waitUntil(() => currentBranch(crowded) === DEEP_BRANCH, { timeout: 30_000 })
      .catch(() => {
        assert.fail(`picking ${DEEP_BRANCH} left the repository on ${currentBranch(crowded)}`);
      });
  });
});
