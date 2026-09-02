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
/**
 * Far past the point the menu stops rendering rows, so the only way to it is to
 * type it. Remote-only, so picking it also has to check it out as a local
 * branch that tracks it.
 */
const DEEP_BRANCH = "origin/team/theirs-1500";
const DEEP_BRANCH_LOCAL = "team/theirs-1500";
/** What `ContextMenu` puts in the DOM at once - the rest is behind the filter. */
const MENU_RENDER_CAP = 200;
/**
 * A guard against a regression, not a target - the number this run prints is
 * the one to read. Measured 2026-08-27 over 1705 branches, on the same harness
 * that measured ~3000ms the day before: runs gave 1265 to 2316ms, the low ones
 * warm. Nearly all of it is `git_branches` on a debug build - see
 * BRANCH_LISTING_BUDGET_MS - and that call took ~2300ms before
 * `%(refname:short)` left its format.
 */
const MENU_BUDGET_MS = 5000;
/**
 * The one call the whole menu waits on, measured on its own so a collapse in it
 * cannot hide inside the menu's total - which also carries WebDriver's own
 * round-trips and a cold first open.
 *
 * Every number here is from a **debug** binary, which is what e2e runs and is
 * most of what it costs: the identical code, timed standalone over the same 1701
 * refs on 2026-08-27, took 232-262ms compiled release and 868-1868ms compiled
 * debug (parse 3ms, serialising the 110KB answer 17ms - neither matters). In the
 * app the same call best-of-five came to 1280-1366ms, against 163-250ms on a
 * one-branch repository: ~200ms is the fixed cost of a call, the rest scales
 * with the number of refs.
 *
 * So this budget is a net for a collapse, not a ruler: the spread across runs is
 * already 1280-2117ms, and a budget tight enough to notice a 20% regression
 * would flake every other run. The narrow guard is a Rust unit test instead -
 * `never_asks_git_to_shorten_ref_names` - which states the rule directly.
 */
const BRANCH_LISTING_BUDGET_MS = 3000;
const BRANCH_LISTING_ROUNDS = 3;

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
// Refs written by hand are not enough to check one out as tracking: without a
// remote configured git answers "starting point is not a branch" (measured
// 2026-08-27). A clone has that configuration; this fixture gets it too. The
// URL is never contacted - only its refspec is read - so the repository stands
// in for its own remote.
gitIn(crowded, "remote", "add", "origin", crowded);

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
          text: el.textContent ?? "",
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

  it("lists a thousand branches in a time a menu can be opened on", async () => {
    const times = await browser.execute(
      async (root, rounds) => {
        const measured = [];
        for (let i = 0; i < rounds; i += 1) {
          const startedAt = performance.now();
          await window.__TAURI_INTERNALS__.invoke("git_branches", { root });
          measured.push(Math.round(performance.now() - startedAt));
        }
        return measured;
      },
      crowded,
      BRANCH_LISTING_ROUNDS,
    );
    console.log(`[git-branch-switch.e2e] git_branches over IPC: ${times.join(", ")} ms`);
    const best = Math.min(...times);
    assert.ok(
      best <= BRANCH_LISTING_BUDGET_MS,
      `listing ${LOCAL_BRANCHES + REMOTE_ONLY_BRANCHES + 1} branches took ${best} ms at best (${times.join(", ")})`,
    );
  });

  it("puts every branch inside the window, however many there are", async () => {
    const expected = LOCAL_BRANCHES + 1 + REMOTE_ONLY_BRANCHES;
    const menu = await openBranchMenu();
    console.log(`[git-branch-switch.e2e] ${menu.items} rows rendered, menu open in ${menu.elapsed} ms`);
    assert.ok(
      menu.elapsed <= MENU_BUDGET_MS,
      `the menu took ${menu.elapsed} ms to open over ${expected} branches`,
    );
    assert.ok(
      menu.top >= 0 && menu.bottom <= menu.viewport + 1,
      `the menu sat outside the window: top ${menu.top}, bottom ${menu.bottom}, window ${menu.viewport}`,
    );
    assert.ok(
      menu.scrollHeight > menu.clientHeight,
      "a list taller than the window has to scroll, or every branch below the fold is unreachable",
    );

    // The actions are what a menu is opened for as often as the list is; below
    // a thousand branches they would be past the last row that gets rendered.
    assert.ok(menu.text.includes("New branch"), `the actions are not on the menu: ${menu.text.slice(0, 120)}`);

    // Rendered rows are capped - and what is not rendered is accounted for, in
    // a line that says how much of the list the filter box still reaches.
    assert.ok(
      menu.items > LOCAL_BRANCHES && menu.items <= MENU_RENDER_CAP,
      `${menu.items} rows rendered: the local branches must all fit, the cap must still hold`,
    );
    const rest = /(\d+) more/.exec(menu.text);
    assert.ok(rest, `the menu never said how many entries it left out: ${menu.text.slice(-200)}`);
    assert.ok(
      menu.items + Number(rest[1]) >= expected,
      `${menu.items} rows plus ${rest[1]} more do not account for ${expected} branches`,
    );
  });

  it("narrows a long list to a branch no scroll would reach, and checks it out", async () => {
    await openBranchMenu();
    await fill(await $('[role="menu"] input'), DEEP_BRANCH);
    await browser.waitUntil(async () => (await $$('[role="menu"] [role="menuitem"]')).length === 1, {
      timeout: 20_000,
      timeoutMsg: "typing a whole branch name left more than that one branch on the list",
    });

    await (await $('[role="menu"] [role="menuitem"]')).click();
    await browser
      .waitUntil(() => currentBranch(crowded) === DEEP_BRANCH_LOCAL, { timeout: 30_000 })
      .catch(() => {
        assert.fail(`picking ${DEEP_BRANCH} left the repository on ${currentBranch(crowded)}`);
      });
    const upstream = execFileSync("git", ["rev-parse", "--abbrev-ref", `${DEEP_BRANCH_LOCAL}@{upstream}`], {
      cwd: crowded,
    })
      .toString()
      .trim();
    assert.equal(upstream, DEEP_BRANCH, "the branch reached by typing tracks nothing");
  });
});
