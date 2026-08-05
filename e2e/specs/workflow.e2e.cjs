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

/**
 * A repository whose new work is a whole folder rather than a loose file.
 *
 * This is the shape that hides files: `git status` collapses an untracked
 * directory into a single record ending in `/`, so a branch that adds a folder
 * shows up as one row no matter how many files it brought.
 */
function repositoryWithANewFolder() {
  const dir = project("newfolder");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "deep", "one.txt"), "one\n");
  fs.writeFileSync(path.join(dir, "src", "deep", "two.txt"), "two\n");
  fs.writeFileSync(path.join(dir, "README.md"), "changed\n");
  return dir;
}

/** Enough paths that they cannot reach git as one command line (~94 000 characters). */
const FILES_IN_THE_NEW_FOLDER = 2000;

/**
 * A repository whose new folder holds more paths than Windows lets a single
 * command line carry (32 767 characters), which is what staging it becomes now
 * that every file is listed instead of the folder.
 */
function repositoryWithMoreFilesThanACommandLine() {
  const dir = project("bulk");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  const vendor = path.join(dir, "vendor", "lib");
  fs.mkdirSync(vendor, { recursive: true });
  for (let n = 0; n < FILES_IN_THE_NEW_FOLDER; n += 1) {
    const name = `module_with_a_realistic_name_${String(n).padStart(4, "0")}.ts`;
    fs.writeFileSync(path.join(vendor, name), `export const value = ${n};\n`);
  }
  return dir;
}

/**
 * A repository whose C# file carries a UTF-8 byte order mark, the way Visual
 * Studio writes them - and one changed line that is deliberately not line 1.
 */
function repositoryWithAMarkedFile() {
  const dir = project("bom");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  const file = path.join(dir, "Program.cs");
  fs.writeFileSync(file, "\ufeffclass Program\n{\n    static void Main() {}\n}\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  fs.writeFileSync(file, "\ufeffclass Program\n{\n    static void Main() { Run(); }\n}\n");
  return dir;
}

/** A repository carrying one file nobody wants committed. */
function repositoryWithNoise() {
  const dir = project("ignore");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  fs.writeFileSync(path.join(dir, "debug.log"), "noise\n");
  return dir;
}

/** Height of the History section, 0 when a long Changes list has squeezed it out. */
const historyHeight = () =>
  browser.execute(() => {
    const header = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.toLowerCase().startsWith("history"),
    );
    return header ? Math.round(header.parentElement.getBoundingClientRect().height) : 0;
  });

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

  it("lists every file a new folder brought, not the folder", async () => {
    await open(repositoryWithANewFolder());
    await waitForText("README.md", "the repository never opened");
    await (await $('button[title="Git"]')).click();

    // Both files, by their full path - the collapsed record would have been a
    // single "src/" row with no name, nothing to diff and nothing to open.
    await waitForText("src/deep/one.txt", "a file inside a new folder never reached the Changes list");
    await waitForText("src/deep/two.txt", "only one file of the new folder was listed");
    // The tracked change still keeps its place next to them.
    await waitForText("README.md", "the modified file disappeared from the Changes list");
  });

  it("stages a folder with more paths than one command line holds", async () => {
    const dir = repositoryWithMoreFilesThanACommandLine();
    await open(dir);
    await (await $('button[title="Git"]')).click();

    // The Changes header only grows this button once git has reported files.
    const stageAll = await $('button[title="Stage"]');
    await stageAll.waitForExist({ timeout: 30_000, timeoutMsg: "the Changes list never filled" });

    // History keeps its place. Changes sizes itself from its content, so before
    // it had a floor, forty changed files were enough to push History - header
    // and all - out of the panel.
    const history = await historyHeight();
    assert.ok(history > 0, `a long Changes list squeezed History out of the panel (height ${history})`);

    // The commit box stays put while the list scrolls under it - two thousand
    // rows must not carry away the box you are typing in - and the scroll area
    // is the list itself, so the scrollbar does not run past the box.
    const scrolled = await browser.execute(() => {
      const box = document.querySelector('textarea[placeholder^="Commit message"]');
      const scroller = document.querySelector('[title$=".ts"]')?.closest(".overflow-y-auto");
      if (!box || !scroller) return null;
      const top = box.getBoundingClientRect().top;
      scroller.scrollTop = 400;
      return { top, scrollTop: scroller.scrollTop, holdsTheBox: scroller.contains(box) };
    });
    assert.ok(scrolled, "the commit box or the list's own scroll area was not found");
    assert.equal(scrolled.holdsTheBox, false, "the scroll area reaches past the commit box");
    assert.ok(scrolled.scrollTop > 0, "the Changes list did not scroll, so nothing was proven");
    const boxTop = await browser.execute(
      () => document.querySelector('textarea[placeholder^="Commit message"]').getBoundingClientRect().top,
    );
    assert.equal(Math.round(boxTop), Math.round(scrolled.top), "the commit box scrolled away with the list");

    // ...and typing in it stays typing. Measured in the page rather than through
    // the driver so the number is React's work alone: React flushes a discrete
    // input event before dispatchEvent returns, so the clock covers the whole
    // re-render. With two thousand rows this cost ~850 ms per character while
    // every row subscribed to the store and was rebuilt on each keystroke.
    const perKeystroke = await browser.execute(() => {
      const box = document.querySelector('textarea[placeholder^="Commit message"]');
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      const type = (text) => {
        setValue.call(box, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const KEYSTROKES = 5;
      type("warm up"); // the first character pays for anything still lazy
      const started = performance.now();
      for (let n = 0; n < KEYSTROKES; n += 1) type(`fix: measured keystroke ${n}`);
      const each = (performance.now() - started) / KEYSTROKES;
      return { each, arrived: box.value, rows: document.querySelectorAll('[title$=".ts"]').length };
    });
    console.log(
      `[workflow.e2e] a keystroke in the commit box cost ${perKeystroke.each.toFixed(1)} ms with ${perKeystroke.rows} rows listed`,
    );
    // The typing has to have reached React, or a fast number proves nothing.
    assert.equal(perKeystroke.arrived, "fix: measured keystroke 4", "the commit box never took the input");
    assert.ok(perKeystroke.rows > 100, `only ${perKeystroke.rows} rows were mounted while typing`);
    assert.ok(
      perKeystroke.each < 120,
      `a keystroke in the commit box cost ${Math.round(perKeystroke.each)} ms with ${perKeystroke.rows} rows listed`,
    );

    await stageAll.click();

    // git's own index is the judge. Sent as one command line, Windows refuses
    // to start the process at all ("The filename or extension is too long"),
    // so this passes only when the paths travel in batches.
    await browser.waitUntil(
      () =>
        git(dir, "diff", "--name-only", "--cached").split("\n").filter(Boolean).length ===
        FILES_IN_THE_NEW_FOLDER,
      { timeout: 60_000, timeoutMsg: "the new folder never reached the index" },
    );
  });

  /**
  /**
   * The editor hides the byte order mark; git prints the bytes a file really has.
   *
   * The patch view is where that shows, and why is worth writing down: Monaco
   * itself drops a mark sitting at the *start* of a model, so the side-by-side
   * diff comes out clean on its own. In a patch the mark sits after the line's
   * "+", where nothing recognises it, and it is drawn as a glyph in the middle of
   * the first added line. Both views are checked below; only the patch one turns
   * red without the fix.
   */
  it("shows a patch of a file with a byte order mark without drawing the mark", async () => {
    await open(repositoryWithAMarkedFile());
    await waitForText("Program.cs", "the repository never opened");
    await (await $('button[title="Git"]')).click();

    // The row itself opens the diff, the way clicking a change does.
    await (await $('button[title="Program.cs"]')).click();
    const readSides = () =>
      browser.execute(() => {
        const editor = document.querySelector(".monaco-diff-editor");
        if (!editor) return null;
        const firstLineOf = (selector) => {
          const pane = editor.querySelector(selector);
          const lines = pane ? [...pane.querySelectorAll(".view-line")] : [];
          // Monaco positions lines absolutely and renders them in any order, and
          // draws spaces as non-breaking ones. A byte order mark survives both,
          // which is what makes it worth looking for here.
          lines.sort((a, b) => Number.parseInt(a.style.top, 10) - Number.parseInt(b.style.top, 10));
          return lines.length > 0 ? lines[0].textContent.replaceAll("\u00a0", " ") : null;
        };
        return {
          head: firstLineOf(".original-in-monaco-diff-editor"),
          working: firstLineOf(".modified-in-monaco-diff-editor"),
        };
      });
    await browser.waitUntil(
      async () => {
        const sides = await readSides();
        return Boolean(sides?.head && sides.working);
      },
      { timeout: 30_000, timeoutMsg: "the diff view never rendered both sides" },
    );
    const sides = await readSides();
    // One side comes from git and the other from the editor, and line 1 is the
    // same line in both: whatever makes these differ is a change nobody made.
    assert.equal(sides.head, "class Program", `the HEAD side began with ${JSON.stringify(sides.head)}`);
    assert.equal(sides.working, sides.head, "line 1 differs between the two sides of the diff");

    // And the patch of the commit that brought the file in, opened from History.
    await (await $('button[title^="base - E2E"]')).click();
    // Waiting on the patch header rather than on the added line: that line reads
    // differently with and without the mark, and a timeout says less than an
    // assertion does.
    await waitForText("diff --git a/Program.cs", "the commit's patch never rendered");
    const patch = await browser.execute(() => {
      const lines = [...document.querySelectorAll(".view-line")];
      lines.sort((a, b) => Number.parseInt(a.style.top, 10) - Number.parseInt(b.style.top, 10));
      const text = lines.map((line) => line.textContent.replaceAll("\u00a0", " ")).join("\n");
      const added = text.split("\n").find((line) => line.startsWith("+") && line.includes("class Program"));
      return { added, glyphs: (text.match(/\ufffd/g) ?? []).length };
    });
    // Measured rather than assumed: a mark inside a patch line arrives on screen
    // as U+FFFD, the replacement character - the odd glyph in front of the code
    // that was reported. Monaco removes a mark only at the very start of a model,
    // which is why the side-by-side view above looked fine while this one did not.
    assert.equal(patch.glyphs, 0, `the patch view drew ${patch.glyphs} replacement characters`);
    assert.equal(patch.added, "+class Program", `the first added line read ${JSON.stringify(patch.added)}`);
  });

  it("gives History as much room as the user drags it, and remembers it", async () => {
    const dir = repositoryWithANewFolder();
    await open(dir);
    await (await $('button[title="Git"]')).click();
    await browser.waitUntil(async () => (await historyHeight()) > 0, {
      timeout: 30_000,
      timeoutMsg: "the Git panel never rendered History",
    });

    const before = await historyHeight();
    const handle = await $("[data-panel-resize-handle-id]");
    const grip = await browser.execute((bar) => {
      const box = bar.getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    }, handle);

    await browser
      .action("pointer")
      .move({ x: grip.x, y: grip.y })
      .down()
      .move({ x: grip.x, y: grip.y - 120, duration: 100 })
      .up()
      .perform();

    await browser.waitUntil(async () => (await historyHeight()) > before + 60, {
      timeout: 10_000,
      timeoutMsg: `dragging the divider up did not make History taller (it was ${before}px)`,
    });
    const dragged = await historyHeight();

    // Collapsing still works - the divider only exists while History is open.
    await (await $("button*=History")).click();
    await browser.waitUntil(async () => (await historyHeight()) < 40, {
      timeout: 10_000,
      timeoutMsg: "collapsing History left its list on screen",
    });
    await (await $("button*=History")).click();

    // And the size outlives a restart, like every other divider in the app.
    await open(dir);
    await (await $('button[title="Git"]')).click();
    await browser.waitUntil(async () => Math.abs((await historyHeight()) - dragged) < 20, {
      timeout: 30_000,
      timeoutMsg: `History forgot the size it was dragged to (${dragged}px)`,
    });
  });

  it("ignores an untracked file from the row it is on", async () => {
    const dir = repositoryWithNoise();
    await open(dir);
    await (await $('button[title="Git"]')).click();

    const row = await $('button[title="debug.log"]');
    await row.waitForExist({ timeout: 30_000, timeoutMsg: "the untracked file never reached Changes" });
    await row.click({ button: "right" });
    await (await $("button*=.gitignore")).click();

    // The project's own file, with a pattern anchored to that exact path.
    await browser.waitUntil(
      () => {
        const file = path.join(dir, ".gitignore");
        return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("/debug.log");
      },
      { timeout: 20_000, timeoutMsg: "the pattern never reached .gitignore" },
    );

    // And git agrees: the noise is gone from the list, .gitignore took its place.
    await browser.waitUntil(
      async () => {
        const body = await $("body").getText();
        return !body.includes("debug.log") && body.includes(".gitignore");
      },
      { timeout: 20_000, timeoutMsg: "the ignored file stayed in the Changes list" },
    );
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
