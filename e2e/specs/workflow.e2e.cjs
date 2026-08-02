/**
 * The three workflows that only exist when Rust, git and the window meet:
 * resolving a merge conflict, running a project's own task, and being offered
 * a language server that is not installed.
 *
 * Each gets a throwaway project built here rather than a fixture checked in -
 * a conflict has to be made by git to be a real conflict, and a task has to be
 * a real command for its exit code to mean anything.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projects = [];

/** A fresh folder, removed when the suite ends. */
function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aime-${name}-`));
  projects.push(dir);
  return dir;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repository stopped mid-merge, with one file in conflict. */
function repositoryInConflict() {
  const dir = project("conflict");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, "greeting.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  git(dir, "checkout", "-b", "theirs");
  fs.writeFileSync(path.join(dir, "greeting.txt"), "hello from theirs\n");
  git(dir, "commit", "-am", "theirs");

  git(dir, "checkout", "main");
  fs.writeFileSync(path.join(dir, "greeting.txt"), "hello from ours\n");
  git(dir, "commit", "-am", "ours");

  try {
    git(dir, "merge", "theirs");
  } catch {
    // A conflicting merge exits non-zero; the markers below are the real check.
  }
  assert.ok(
    fs.readFileSync(path.join(dir, "greeting.txt"), "utf8").includes("<<<<<<<"),
    "the merge was supposed to leave a conflict",
  );
  return dir;
}

/**
 * A project whose test command really fails, with a code of its own.
 *
 * Failure is the interesting half: an interactive shell does not exit after a
 * task, so Aime has the shell print the code and reads it back. A passing task
 * would prove the command ran; a failing one proves the code survived the trip
 * and reached the user as an offer to fix it.
 */
function projectWithAFailingTask() {
  const dir = project("task");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "aime-e2e-task",
      scripts: { test: "node -e \"console.log('7 failed'); process.exit(3)\"" },
    }),
  );
  return dir;
}

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/** Opens a folder the only way a driver can: through the recent list. */
async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
  }, dir);
  await browser.refresh();
  await waitForText("RECENT", "the welcome screen never rendered");
  await (await $(`span=${dir.split(/[\\/]/).pop()}`)).click();
}

describe("Workflows", () => {
  after(() => {
    for (const dir of projects) {
      // Best effort: Windows keeps a handle on the folder the app has open.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the temp directory outlives the run; the OS clears it */
      }
    }
  });

  it("resolves a merge conflict and stages the result", async () => {
    const dir = repositoryInConflict();
    await open(dir);
    await waitForText("greeting.txt", "the repository never opened");

    await (await $("span=greeting.txt")).click();
    // The editor refuses to pretend a conflicted file is ordinary text.
    await waitForText("merge conflicts", "no conflict banner appeared for a conflicted file");
    await (await $("button*=Resolve")).click();

    await waitForText("keep ours", "the resolver never showed the two sides");
    await (await $("button*=Keep ours")).click();
    // The save button counts the blocks left; at zero it writes the file.
    await (await $("button*=Save & mark resolved")).click();

    await browser.waitUntil(
      () => fs.readFileSync(path.join(dir, "greeting.txt"), "utf8").trim() === "hello from ours",
      { timeout: 10_000, timeoutMsg: "the resolved file was never written" },
    );
    const staged = git(dir, "diff", "--name-only", "--cached");
    assert.ok(staged.includes("greeting.txt"), "resolving should stage the file, as git itself expects");
  });

  it("runs the project's own task and brings its exit code back", async () => {
    await open(projectWithAFailingTask());
    await waitForText("package.json", "the project never opened");

    // Tasks are reached from the palette, where a keyboard-driven user looks;
    // the status bar menu runs the same store action.
    await browser.keys(["Control", "k"]);
    await browser.keys("npm".split(""));
    await waitForText("run task: npm test", "the palette never offered the detected task");
    await browser.keys(["Enter"]);

    // The banner is the whole chain in one line: the command ran, the shell
    // printed its code, Aime read it back and said so.
    await waitForText("npm test failed with exit code 3", "a failing task did not report its exit code");
    // A failure the user can act on, not just read.
    await waitForText("fix with ai", "a failed task offered no way forward");
  });

  // Go, because its server is the one Aime cannot install quietly (it needs
  // the Go toolchain), so the offer is still exercised on a machine where the
  // npm-installable servers are already there. Nothing is installed here -
  // clicking through would run a real install.
  it("offers the missing language server for the file in front of the user", async () => {
    const dir = project("go");
    fs.writeFileSync(path.join(dir, "main.go"), "package main\n\nfunc main() {}\n");
    await open(dir);
    await waitForText("main.go", "the project never opened");

    await (await $("span=main.go")).click();
    await waitForText("no completions for go", "no server was offered for a Go file");
    await waitForText("gopls", "the offer did not name the server to install");
  });
});
