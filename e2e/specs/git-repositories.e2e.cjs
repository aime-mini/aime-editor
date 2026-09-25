/**
 * A workspace that is not one repository.
 *
 * The user's own layout (measured 2026-09-25 on `C:\Projects\IODM`): a product
 * folder holding `Backend`, `Frontend/Front end` - two levels down, with a space
 * in its name - and a third repository beside them. Opened as it is, Aime used
 * to answer "not a git repository"; a folder opened from inside a repository
 * got git's paths read against the wrong root, so the tree marked the wrong
 * files and staging reached for files that were not there. This rebuilds that
 * layout in a throwaway folder and checks every answer against git itself.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fill } = require("../support/fields.cjs");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-repos-"));
const product = path.join(base, "IODM");
const backend = path.join(product, "Backend");
const frontend = path.join(product, "Frontend", "Front end");
/** A folder with no repository anywhere above or below it. */
const loose = path.join(base, "loose-notes");

const NEWLINE = String.fromCharCode(10);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** A repository with one commit, and one file changed since. */
function repository(root, file) {
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "e2e@aime.test");
  git(root, "config", "user.name", "Aime E2E");
  fs.writeFileSync(path.join(root, file), `first${NEWLINE}`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(root, file), `first${NEWLINE}changed${NEWLINE}`);
}

repository(backend, "api/main.rs");
repository(frontend, "src/app.ts");
fs.mkdirSync(path.join(product, "docs"), { recursive: true });
fs.writeFileSync(path.join(product, "docs", "readme.md"), `not in any repository${NEWLINE}`);
fs.mkdirSync(loose, { recursive: true });
fs.writeFileSync(path.join(loose, "todo.md"), `a folder git has never seen${NEWLINE}`);

async function waitForText(text, message, timeout = 30_000) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout,
    timeoutMsg: `${message} (looked for "${text}")`,
  });
}

/** Seeds the recent list with a folder and opens it, the way a user would. */
async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
  }, dir);
  await browser.refresh();
  await waitForText("recent", "the welcome screen never rendered");
  await (await $(`span=${path.basename(dir)}`)).click();
}

const showGit = async () => (await $('button[title="Git"]')).click();
const showTree = async () => (await $('button[title="Explorer"]')).click();

/** The badge the tree shows beside a row, by the row's name; null when it has none. */
const badgeOf = (name) =>
  browser.execute((wanted) => {
    for (const row of document.querySelectorAll("button")) {
      const label = row.querySelector(":scope > span.truncate");
      if (label?.textContent === wanted) return row.querySelector(":scope > span.font-mono")?.textContent ?? null;
    }
    return null;
  }, name);

async function waitForBadge(name, expected) {
  await browser
    .waitUntil(async () => (await badgeOf(name)) === expected, { timeout: 20_000 })
    .catch(async () => {
      assert.fail(`the tree marks "${name}" with ${String(await badgeOf(name))}, not ${expected}`);
    });
}

/** Clicks a tree row by its name. */
const clickRow = async (name) => (await $(`span=${name}`)).click();

/** The repository chips: label, and whether it is the one on screen. */
const chips = () =>
  browser.execute(() =>
    [...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((tab) => ({
      text: (tab.textContent ?? "").trim(),
      selected: tab.getAttribute("aria-selected") === "true",
    })),
  );

async function chooseRepository(label) {
  await (await (await $('[role="tablist"]')).$(`button*=${label}`)).click();
  await browser.waitUntil(async () => (await chips()).some((chip) => chip.selected && chip.text.startsWith(label)), {
    timeout: 10_000,
    timeoutMsg: `the ${label} chip never became the one on screen`,
  });
}

/** Whether the panel lists a change, by the path git names it with. */
const panelLists = async (relative) => (await $(`button[title="${relative}"]`)).isExisting();

const commitBox = () => $("textarea");

describe("A folder holding several repositories", () => {
  before(async () => {
    await open(product);
    await waitForText("docs", "the product folder never opened");
  });

  after(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on the folder the app has open; the temp sweep
      // gets what this could not.
    }
  });

  it("finds each repository, two levels down included, and offers one chip per repository", async () => {
    await showGit();
    await browser
      .waitUntil(async () => (await chips()).length === 2, { timeout: 20_000 })
      .catch(async () => {
        assert.fail(`the panel shows these chips: ${JSON.stringify(await chips())}`);
      });
    const labels = (await chips()).map((chip) => chip.text);
    assert.ok(labels.some((text) => text.startsWith("Backend")), `no Backend chip: ${labels.join(" | ")}`);
    assert.ok(
      labels.some((text) => text.startsWith("Frontend/Front end")),
      `no chip for the repository two levels down: ${labels.join(" | ")}`,
    );
  });

  it("marks the changes of every repository in the tree, and the folders above them", async () => {
    await showTree();
    await waitForBadge("Backend", "●");
    await waitForBadge("Frontend", "●");
    await clickRow("Frontend");
    await waitForBadge("Front end", "●");
    await clickRow("Front end");
    await clickRow("src");
    await waitForBadge("app.ts", "M");
    // A folder outside every repository is nobody's change.
    assert.equal(await badgeOf("docs"), null, "the tree marked a folder no repository holds");
  });

  it("stages and commits in the repository chosen, and only there", async () => {
    await showGit();
    await chooseRepository("Backend");
    await browser.waitUntil(() => panelLists("api/main.rs"), {
      timeout: 10_000,
      timeoutMsg: "the Backend chip did not show Backend's change",
    });
    assert.equal(await panelLists("src/app.ts"), false, "the Frontend's change showed under Backend");

    await (await $('button[title="Stage"]')).click();
    await browser.waitUntil(() => git(backend, "diff", "--cached", "--name-only") === "api/main.rs", {
      timeout: 10_000,
      timeoutMsg: "staging from the panel never reached Backend's index",
    });
    await fill(await commitBox(), "fix: the backend");
    await (await $("button*=Commit")).click();
    await browser.waitUntil(() => git(backend, "log", "-1", "--format=%s") === "fix: the backend", {
      timeout: 10_000,
      timeoutMsg: "the commit never landed in Backend",
    });
    assert.equal(git(frontend, "log", "-1", "--format=%s"), "first", "the Frontend got a commit it was never given");
    assert.equal(git(frontend, "status", "--porcelain"), "M src/app.ts", "the Frontend's change was touched");
  });

  it("follows the file in front to its repository, and names it in the status bar", async () => {
    await showTree();
    await clickRow("app.ts");
    await showGit();
    await browser
      .waitUntil(async () => (await chips()).some((chip) => chip.selected && chip.text.startsWith("Frontend")), {
        timeout: 10_000,
      })
      .catch(async () => {
        assert.fail(`opening a Frontend file left the panel on ${JSON.stringify(await chips())}`);
      });
    await browser.waitUntil(() => panelLists("src/app.ts"), {
      timeout: 10_000,
      timeoutMsg: "the panel followed the file but does not list its change",
    });
    const footer = await (await $("footer")).getText();
    assert.ok(footer.includes("Frontend/Front end"), `the status bar does not name the repository: ${footer}`);
  });

  it("keeps the message typed for one repository while another is shown", async () => {
    await fill(await commitBox(), "feat: half-written for the frontend");
    await chooseRepository("Backend");
    assert.equal(await (await commitBox()).getValue(), "", "Backend's box showed the Frontend's message");
    await chooseRepository("Frontend");
    assert.equal(await (await commitBox()).getValue(), "feat: half-written for the frontend");
  });
});

describe("A folder opened from inside a repository", () => {
  before(async () => {
    await open(path.join(frontend, "src"));
    await waitForText("app.ts", "the folder inside the repository never opened");
  });

  it("marks the file git reports, and stages it where git keeps it", async () => {
    await waitForBadge("app.ts", "M");
    await showGit();
    // Named the way git names it - from the repository's root, not from here.
    await browser.waitUntil(() => panelLists("src/app.ts"), {
      timeout: 10_000,
      timeoutMsg: "the panel did not list the change of the repository around the folder",
    });
    await (await $('button[title="Stage"]')).click();
    await browser.waitUntil(() => git(frontend, "diff", "--cached", "--name-only") === "src/app.ts", {
      timeout: 10_000,
      timeoutMsg: `staging reached ${git(frontend, "diff", "--cached", "--name-only") || "nothing"}`,
    });
  });
});

describe("A folder with no repository", () => {
  before(async () => {
    await open(loose);
    await waitForText("todo.md", "the loose folder never opened");
  });

  it("offers to make one, and shows it once made", async () => {
    await showGit();
    const init = await $("button=Initialize repository");
    await init.waitForExist({ timeout: 10_000, timeoutMsg: "the panel offered no way to start a repository" });
    await init.click();
    await browser.waitUntil(() => fs.existsSync(path.join(loose, ".git")), {
      timeout: 10_000,
      timeoutMsg: "Initialize made no repository",
    });
    await browser.waitUntil(() => panelLists("todo.md"), {
      timeout: 10_000,
      timeoutMsg: "the new repository never showed its untracked file",
    });
  });
});
