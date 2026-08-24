/**
 * Opening a commit from the history.
 *
 * It used to be `git show --stat --patch` poured into one editor: a stat block
 * nobody can click, then every file's patch concatenated. This proves the
 * thing that replaced it — the files a commit touched, as a list you can open
 * one at a time — against a real repository with a real multi-file commit.
 *
 * The repository is created here and thrown away here.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * A repository whose last commit touches four files in four different ways -
 * added, modified, deleted and renamed - because a list that only handles
 * "modified" is a list that fails on the first real commit.
 */
function repository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aime-commit-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };

  write("readme.md", "# sample\n");
  write("src/kept.ts", ["export const kept = 1;", "export const other = 2;", ""].join("\n"));
  write("src/doomed.ts", "export const doomed = true;\n");
  write("src/old-name.ts", ["export function greet() {", '  return "hello";', "}", ""].join("\n"));
  git("init", "-b", "main");
  git("config", "user.email", "probe@example.com");
  git("config", "user.name", "Probe");
  git("add", ".");
  git("commit", "-m", "first");

  // The commit under test.
  write("src/kept.ts", ["export const kept = 42;", "export const other = 2;", ""].join("\n"));
  write("src/added.ts", ["export const added = true;", "export const also = 1;", ""].join("\n"));
  fs.rmSync(path.join(dir, "src", "doomed.ts"));
  fs.renameSync(path.join(dir, "src", "old-name.ts"), path.join(dir, "src", "new-name.ts"));
  git("add", "-A");
  git("commit", "-m", "Rework the cart\n\nThe body of the message, which the header has to show.");

  // And a merge on top, because git prints no patch for one unless it is told
  // which parent to read it against - while `--numstat` happily lists the files
  // it brought in. A viewer that does not know that lists rows which all open
  // blank, and rows that lie are worse than no rows.
  git("checkout", "-b", "side", "HEAD~1");
  write("src/from-side.ts", ["export const fromSide = 7;", ""].join("\n"));
  git("add", "-A");
  git("commit", "-m", "Add the side file");
  git("checkout", "main");
  git("merge", "--no-ff", "side", "-m", "Merge the side branch");
  return dir;
}

async function waitForText(text, message, timeout = 30_000) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout,
    timeoutMsg: `${message} (looked for "${text}")`,
  });
}

async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
    localStorage.setItem("aime.theme", "dark");
  }, dir);
  await browser.refresh();
  await waitForText("recent", "the welcome screen never rendered");
  await (await $(`span=${dir.split(/[\\/]/).pop()}`)).click();
}

/** The file rows of the commit view, in the order they are listed. */
const listedFiles = () =>
  browser.execute(() =>
    [...document.querySelectorAll("nav button")].map((row) => (row.textContent ?? "").trim()),
  );

describe("Commit view", () => {
  let repo = "";

  before(async () => {
    repo = repository();
    await open(repo);
    await waitForText("readme.md", "the sample never opened");

    // Into the history: the Git tab, then the commit at the top of the log.
    await (await $('button[title="Git"]')).click();
    await waitForText("rework the cart", "the history never listed the commit");
    await (await $("span*=Rework the cart")).click();
  });

  after(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on the folder the app has open.
    }
  });

  it("says who wrote it and why, not only its hash", async () => {
    await waitForText("rework the cart", "the commit's subject was not shown");
    await waitForText("probe", "the author was not shown");
    await waitForText("the body of the message", "the message body was dropped");
  });

  it("lists every file the commit touched, however it touched them", async () => {
    await browser.waitUntil(async () => (await listedFiles()).length >= 4, {
      timeout: 20_000,
      timeoutMsg: `the file list never appeared: ${JSON.stringify(await listedFiles())}`,
    });
    const rows = (await listedFiles()).join(" | ");

    assert.ok(rows.includes("added.ts"), `the added file is missing: ${rows}`);
    assert.ok(rows.includes("kept.ts"), `the modified file is missing: ${rows}`);
    assert.ok(rows.includes("doomed.ts"), `the deleted file is missing: ${rows}`);
    // A rename is listed under the name it now has - that is the one to open.
    assert.ok(rows.includes("new-name.ts"), `the renamed file is missing: ${rows}`);

    // And each row carries how much of it moved, which is the whole reason to
    // scan a list rather than a wall of patch.
    assert.ok(/\+\d/.test(rows), `no line counts in the list: ${rows}`);
  });

  it("opens the patch of whichever file is clicked, and only that one", async () => {
    // The first file opens by itself; another one is a click away.
    const rows = await $$("nav button");
    let opened = false;
    for (const row of rows) {
      if ((await row.getText()).includes("added.ts")) {
        await row.click();
        opened = true;
        break;
      }
    }
    assert.ok(opened, "no row for the added file");

    await waitForText("export const added", "the clicked file's patch never appeared");
    // The point of the change: one file's patch, not every file's at once.
    const page = await $("body").getText();
    assert.equal(
      page.includes("export const doomed"),
      false,
      "the deleted file's patch is on screen too, so this is still one long patch",
    );
  });

  it("opens a renamed file as the rename it was, rather than as an empty pane", async () => {
    // `--numstat` spells a rename as ONE field reading `old => new`, so the row
    // was named after that sentence, git was asked for a file called that,
    // matched nothing, and the pane came up blank. The row test above passed
    // through all of it, because the sentence contains the new name.
    const rows = await listedFiles();
    assert.ok(
      !rows.some((row) => row.includes("=>")),
      `a row is named after a sentence rather than after a file: ${rows.join(" | ")}`,
    );

    await clickRow("new-name.ts");
    await waitForText("rename from src/old-name.ts", "the renamed file's patch never arrived");
    await waitForText("rename to src/new-name.ts", "the patch did not say where it went");
  });

  it("reads a merge against the branch it was merged into, instead of showing nothing", async () => {
    await (await $("span*=Merge the side branch")).click();
    await waitForText("from-side.ts", "the merge listed none of the files it brought in");

    await clickRow("from-side.ts");
    await waitForText("export const fromSide", "every row of the merge opened blank");
  });
});

/** Clicks the file row whose name contains this, and says so if there is none. */
async function clickRow(name) {
  for (const row of await $$("nav button")) {
    if ((await row.getText()).includes(name)) {
      await row.click();
      return;
    }
  }
  assert.fail(`no row for ${name}: ${(await listedFiles()).join(" | ")}`);
}
