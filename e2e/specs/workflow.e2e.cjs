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

/** Where the one change lives - far enough down that line 1 shows nothing of it. */
const DEEP_CHANGE_LINE = 150;

/**
 * A repository whose only change sits deep in a long file.
 *
 * This is the shape that makes a diff look empty: open it at line 1 and both
 * sides read the same for a screenful, with the change 150 rows below.
 */
function repositoryWithADeepChange() {
  const dir = project("deepdiff");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  const lines = Array.from({ length: 200 }, (_, n) => `const value${String(n)} = ${String(n)};`);
  const file = path.join(dir, "long.ts");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  lines[DEEP_CHANGE_LINE - 1] = "const valueDeep = 999;";
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return dir;
}

/**
 * Two files git calls changed that a diff editor is happy to draw as unchanged:
 * one whose change only moved whitespace, and one whose change is in the index
 * while the worktree matches HEAD exactly.
 */
function repositoryWithInvisibleChanges() {
  const dir = project("invisible");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, "indent.js"), "function run() {\nreturn 1;\n}\n");
  fs.writeFileSync(path.join(dir, "staged.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  fs.writeFileSync(path.join(dir, "indent.js"), "function run() {\n    return 1;\n}\n");
  fs.writeFileSync(path.join(dir, "staged.txt"), "two\n");
  git(dir, "add", "staged.txt");
  fs.writeFileSync(path.join(dir, "staged.txt"), "one\n");
  return dir;
}

/**
 * A repository with one tracked file, one untracked file and a whole untracked
 * folder - the three answers the tree's ignore entry has to give.
 */
function repositoryWithThingsToIgnore() {
  const dir = project("toignore");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  fs.writeFileSync(path.join(dir, "debug.log"), "noise\n");
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "build", "out.js"), "built\n");
  return dir;
}

/** A repository with a whole ignored folder and one ignored file beside it. */
function repositoryWithIgnoredFiles() {
  const dir = project("ignored");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\nsecret.log\n");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "bundle.js"), "built\n");
  fs.writeFileSync(path.join(dir, "secret.log"), "noise\n");
  return dir;
}

/** A repository whose work is on the shelf rather than in the worktree. */
function repositoryWithAStash() {
  const dir = project("stash");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E");
  git(dir, "config", "user.email", "e2e@example.com");
  fs.writeFileSync(path.join(dir, "greeting.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  fs.writeFileSync(path.join(dir, "greeting.txt"), "hello again\n");
  git(dir, "stash", "push", "-m", "shelved greeting");
  return dir;
}

/** `#8b919d` as the browser reports it, so a colour can be compared at all. */
function rgbOf(hex) {
  const [, r, g, b] = /^#(\w\w)(\w\w)(\w\w)$/.exec(hex.trim());
  return `rgb(${String(parseInt(r, 16))}, ${String(parseInt(g, 16))}, ${String(parseInt(b, 16))})`;
}

/** Height of the History section, 0 when a long Changes list has squeezed it out. */
const historyHeight = () =>
  browser.execute(() => {
    const header = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.toLowerCase().startsWith("history"),
    );
    return header ? Math.round(header.parentElement.getBoundingClientRect().height) : 0;
  });

/**
 * Whether a context menu is on screen. It lays a sheet over the whole window to
 * catch the click that dismisses it, and that sheet swallows the next
 * right-click - so both tests below have to wait for it in both directions.
 */
const menuIsOpen = () => browser.execute(() => Boolean(document.querySelector(".fixed.inset-0.z-50")));

/**
 * Clicks the menu's .gitignore entry, scoped to the menu itself: as soon as one
 * pattern has been written the file tree has a row called `.gitignore` too, and
 * that row is what a window-wide text match finds.
 */
async function clickIgnoreEntry() {
  const menu = await $(".fixed.inset-0.z-50");
  await (await menu.$("button*=.gitignore")).click();
}

/** Right-clicks a tree row and hands back the labels its menu offers. */
async function menuFor(name) {
  await (await $(`span=${name}`)).click({ button: "right" });
  await browser.waitUntil(menuIsOpen, {
    timeout: 10_000,
    timeoutMsg: `right-clicking ${name} opened no menu`,
  });
  return browser.execute(() =>
    [...document.querySelectorAll(".fixed.inset-0.z-50 button")].map((button) => button.textContent.trim()),
  );
}

async function closeMenu() {
  await browser.keys(["Escape"]);
  await browser.waitUntil(async () => !(await menuIsOpen()), {
    timeout: 10_000,
    timeoutMsg: "the context menu would not close",
  });
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
    await clickIgnoreEntry();

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

  /**
   * The complaint this came from was "sometimes I click a change and there is no
   * change on screen". Two halves, both here: a diff that opens where the change
   * is, and a diff that is still true a minute later.
   */
  it("opens a diff on the change, and keeps up with the file while it is open", async () => {
    const dir = repositoryWithADeepChange();
    await open(dir);
    await (await $('button[title="Git"]')).click();
    const row = await $('button[title="long.ts"]');
    await row.waitForExist({ timeout: 30_000, timeoutMsg: "the changed file never reached Changes" });
    await row.click();

    /**
     * Line numbers the worktree side is showing. Asking for the range rather
     * than for a scroll position is what makes this stable: the editor scrolls
     * smoothly, so any single reading can land mid-flight.
     */
    const visibleLines = () =>
      browser.execute(() => {
        const pane = document.querySelector(".modified-in-monaco-diff-editor");
        return pane
          ? [...pane.querySelectorAll(".line-numbers")]
              .map((node) => Number(node.textContent))
              .filter((line) => line > 0)
          : [];
      });

    await browser.waitUntil(async () => (await visibleLines()).includes(DEEP_CHANGE_LINE), {
      timeout: 30_000,
      // Without `revealFirstDiff` this is exactly what fails: the view sits on
      // line 1 with 149 identical rows between it and the change.
      timeoutMsg: `the change on line ${DEEP_CHANGE_LINE} never came on screen`,
    });
    const shown = await visibleLines();
    console.log(
      `[workflow.e2e] the diff came to rest on lines ${Math.min(...shown)}-${Math.max(...shown)}; the change is on ${DEEP_CHANGE_LINE}`,
    );

    // The file moves on under the open diff - which is what editing it does, and
    // what the agent writing to it does.
    const later = fs
      .readFileSync(path.join(dir, "long.ts"), "utf8")
      .replace("const valueDeep = 999;", "const valueDeep = 777;");
    fs.writeFileSync(path.join(dir, "long.ts"), later);
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(
            () => document.querySelector(".modified-in-monaco-diff-editor")?.textContent ?? "",
          )
        ).includes("777"),
      { timeout: 30_000, timeoutMsg: "the open diff still showed the file as it was when it opened" },
    );
  });

  /**
   * The other half of "no change on screen": changes a diff editor draws as
   * nothing at all. Monaco ignores trimmed whitespace by default, so the
   * re-indented file below comes out clean unless it is told otherwise - and
   * when the two sides really are identical, the view has to say so rather than
   * leave the user looking for a change that is not on the screen.
   */
  it("shows a change that only moved whitespace, and admits when there is none", async () => {
    const dir = repositoryWithInvisibleChanges();
    await open(dir);
    await (await $('button[title="Git"]')).click();

    const indent = await $('button[title="indent.js"]');
    await indent.waitForExist({ timeout: 30_000, timeoutMsg: "the re-indented file never reached Changes" });
    await indent.click();

    /** Lines Monaco has marked as changed on the worktree side. */
    const markedLines = () =>
      browser.execute(() => document.querySelectorAll(".modified-in-monaco-diff-editor .line-insert").length);
    await browser.waitUntil(async () => (await markedLines()) > 0, {
      timeout: 30_000,
      timeoutMsg: "the diff hid a change that only moved whitespace",
    });
    assert.ok(
      !(await $("body").getText()).toLowerCase().includes("same text as head"),
      "a file with a real change was reported as identical to HEAD",
    );

    // And the file whose change is in the index: the two sides are the same text,
    // and saying so is the point - the alternative is two identical panes.
    await (await $('button[title="staged.txt"]')).click();
    await waitForText("same text as head", "an empty diff said nothing about being empty");
  });

  it("greys out what git ignores, a whole folder at a time", async () => {
    const dir = repositoryWithIgnoredFiles();
    await open(dir);
    await waitForText("secret.log", "the tree never listed the ignored file");

    /** The colour the tree draws one row in, by the name on that row. */
    const colourOf = (name) =>
      browser.execute((label) => {
        const row = [...document.querySelectorAll("button")].find(
          (button) => button.querySelector("span")?.textContent === label,
        );
        return row ? getComputedStyle(row).color : null;
      }, name);

    const muted = rgbOf(
      await browser.execute(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--text-muted"),
      ),
    );
    /**
     * Waits for one row to be drawn in the muted colour.
     *
     * A wait rather than a read: the tree greys a row when the ignored list
     * arrives, and the list arrives in its own pass. Reading once turned this
     * into the suite's flakiest assertion - it passed on an idle machine and
     * failed on a busy one, with a different row each time.
     */
    const waitForMuted = (name, message) =>
      browser.waitUntil(async () => (await colourOf(name)) === muted, {
        timeout: 30_000,
        timeoutMsg: message,
      });

    await waitForMuted("secret.log", `the ignored file was not drawn in the muted colour (${muted})`);
    const tracked = await colourOf("README.md");
    assert.notEqual(tracked, muted, "a tracked file was greyed out along with the ignored ones");
    await waitForMuted("dist", "an ignored folder kept the colour of a real one");

    // What is inside an ignored folder is ignored too, and git never listed those
    // files - the folder was collapsed into one entry, and the row inherits.
    await (await $("span=dist")).click();
    await waitForText("bundle.js", "the ignored folder never opened");
    await waitForMuted("bundle.js", "a file inside an ignored folder was drawn as part of the repository");
  });

  /**
   * Ignoring from the tree, where a folder is something you can actually click -
   * the Changes list only ever shows files. The entry has to know what it would
   * accomplish: git ignores nothing it already tracks, so a tracked file must
   * not be offered a button that does nothing.
   */
  it("adds a file or a whole folder to .gitignore from the tree", async () => {
    const dir = repositoryWithThingsToIgnore();
    const gitignore = () => {
      const file = path.join(dir, ".gitignore");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    };
    await open(dir);
    await waitForText("debug.log", "the tree never listed the untracked file");

    // A tracked file: ignoring it would change nothing, so it is not offered.
    const tracked = await menuFor("README.md");
    assert.ok(
      !tracked.some((label) => label.includes(".gitignore")),
      `a tracked file was offered .gitignore: ${JSON.stringify(tracked)}`,
    );
    await closeMenu();

    // The untracked file.
    await menuFor("debug.log");
    await clickIgnoreEntry();
    await browser.waitUntil(async () => !(await menuIsOpen()), {
      timeout: 10_000,
      timeoutMsg: "the menu stayed open after its entry was clicked",
    });
    await browser.waitUntil(() => gitignore().includes("/debug.log"), {
      timeout: 20_000,
      timeoutMsg: "the file never reached .gitignore",
    });

    // And the folder, which is the case the Changes list could never offer.
    await menuFor("build");
    await clickIgnoreEntry();
    await browser.waitUntil(async () => !(await menuIsOpen()), {
      timeout: 10_000,
      timeoutMsg: "the menu stayed open after the folder's entry was clicked",
    });
    await browser.waitUntil(() => gitignore().includes("/build/"), {
      timeout: 20_000,
      // The trailing slash is git's own way of saying "the directory called
      // this", and it is what leaves a file named `build` tracked.
      timeoutMsg: `the folder never reached .gitignore as a folder: ${JSON.stringify(gitignore())}`,
    });

    // git agrees, which is the only opinion that counts here.
    const ignored = git(dir, "check-ignore", "-v", "debug.log", "build/out.js");
    assert.ok(ignored.includes("debug.log"), `git does not ignore the file: ${ignored}`);
    assert.ok(ignored.includes("build/out.js"), `git does not ignore the folder's contents: ${ignored}`);

    // And the tree says so without being asked again: both rows are grey now.
    const colourOf = (name) =>
      browser.execute((label) => {
        const row = [...document.querySelectorAll("button")].find(
          (button) => button.querySelector("span")?.textContent === label,
        );
        return row ? getComputedStyle(row).color : null;
      }, name);
    const muted = rgbOf(
      await browser.execute(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--text-muted"),
      ),
    );
    const waitForMutedRow = (name, message) =>
      browser.waitUntil(async () => (await colourOf(name)) === muted, {
        timeout: 30_000,
        timeoutMsg: message,
      });
    await waitForMutedRow("debug.log", "the file stayed black after being ignored");
    await waitForMutedRow("build", "the folder stayed black after being ignored");
  });

  /**
   * The other half of the same wish. A file git already tracks cannot be ignored
   * by a pattern alone - git reads it and skips it - so the tree offers to untrack
   * it as well, and says what that costs: the file stays, the next commit deletes
   * it for everyone else.
   */
  it("untracks a tracked file before ignoring it, and leaves it on disk", async () => {
    const dir = repositoryWithThingsToIgnore();
    await open(dir);
    await waitForText("README.md", "the tree never listed the tracked file");

    const labels = await menuFor("README.md");
    assert.ok(
      labels.some((label) => label.includes("Stop tracking")),
      `a tracked file was offered no way to stop tracking it: ${JSON.stringify(labels)}`,
    );
    const menu = await $(".fixed.inset-0.z-50");
    await (await menu.$("button*=Stop tracking")).click();

    // Not silently: the consequence is spelled out before anything happens.
    await waitForText("next commit deletes it", "no warning about what untracking costs");
    assert.equal(
      git(dir, "ls-files", "README.md").trim(),
      "README.md",
      "the file left the index before the warning was accepted",
    );
    await (await $("button=OK")).click();

    // The pattern is the second half of the action, so it is what to wait for:
    // the index entry is already gone by the time it is written.
    const gitignore = path.join(dir, ".gitignore");
    await browser.waitUntil(
      () => fs.existsSync(gitignore) && fs.readFileSync(gitignore, "utf8").includes("/README.md"),
      { timeout: 20_000, timeoutMsg: "the pattern never reached .gitignore" },
    );
    assert.equal(git(dir, "ls-files", "README.md").trim(), "", "git still tracks the file");
    assert.ok(fs.existsSync(path.join(dir, "README.md")), "untracking deleted the user's file");
    // And git agrees it is ignored now, which it would not be while tracked.
    assert.ok(
      git(dir, "check-ignore", "-v", "README.md").includes("README.md"),
      "git does not ignore the file it just stopped tracking",
    );
  });

  it("gives the stash a height of its own, draggable and foldable", async () => {
    await open(repositoryWithAStash());
    await (await $('button[title="Git"]')).click();
    await waitForText("shelved greeting", "the stash never appeared in the Git panel");

    /**
     * The stash section and the divider that sizes it.
     *
     * Found through the panel's own id rather than by counting dividers: the
     * workbench has four of its own, and which of the six on screen belongs to
     * the Git panel is not something a global query can say.
     */
    const stashSection = () =>
      browser.execute(() => {
        const panel = document.querySelector('[data-panel-id="git-stash"]');
        const bar = panel?.previousElementSibling;
        const grip = bar?.getBoundingClientRect();
        return {
          height: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
          hasDivider: Boolean(bar?.hasAttribute("data-panel-resize-handle-id")),
          grip: grip
            ? { x: Math.round(grip.x + grip.width / 2), y: Math.round(grip.y + grip.height / 2) }
            : null,
        };
      });

    const before = await stashSection();
    assert.ok(before.height > 0, "the stash never got a section of its own");
    assert.ok(
      before.hasDivider,
      "the stash section has no divider above it, so its height cannot be dragged",
    );

    await browser
      .action("pointer")
      .move({ x: before.grip.x, y: before.grip.y })
      .down()
      .move({ x: before.grip.x, y: before.grip.y - 120, duration: 100 })
      .up()
      .perform();

    await browser.waitUntil(async () => (await stashSection()).height > before.height + 60, {
      timeout: 10_000,
      timeoutMsg: `dragging the divider above the stash did not make it taller (it was ${before.height}px)`,
    });
    console.log(
      `[workflow.e2e] the stash went from ${before.height}px to ${(await stashSection()).height}px`,
    );

    // And it folds, so a shelf of old work costs one line when it is not wanted.
    await (await $("button*=Stash (1)")).click();
    await browser.waitUntil(async () => !(await $("body").getText()).includes("shelved greeting"), {
      timeout: 10_000,
      timeoutMsg: "folding the stash heading left the list on screen",
    });
    // Folded it is a heading under the panels rather than a panel of its own, so
    // the divider that used to size it goes with it.
    assert.equal((await stashSection()).height, 0, "a folded stash kept the panel it no longer fills");
    await (await $("button*=Stash (1)")).click();
    await waitForText("shelved greeting", "the stash list never came back");
  });

  /**
   * Auto save, both ways round in one test: the second half is the negative
   * control, and it has to be, because "the file was written" proves nothing
   * unless not writing it is also observable.
   */
  it("saves a file a second after the typing stops, and stops when told to", async () => {
    const dir = project("autosave");
    const file = path.join(dir, "greeting.txt");
    fs.writeFileSync(file, "hello\n");
    await open(dir);
    await (await $("span=greeting.txt")).click();
    await waitForText("hello", "the file never opened");

    // Ctrl+End lands after the file's own trailing newline, so what is typed
    // becomes a line of its own - the words are what this checks, not the shape.
    await (await $(".monaco-editor .view-lines")).click();
    await browser.keys(["Control", "End"]);
    await browser.keys("world".split(""));
    await browser.waitUntil(() => fs.readFileSync(file, "utf8").includes("world"), {
      timeout: 15_000,
      timeoutMsg: "auto save never wrote the file",
    });

    // Switched off, the same keystrokes must reach the disk only on Ctrl+S.
    await browser.execute(() => {
      localStorage.setItem("aime.settings", JSON.stringify({ autoSave: false }));
    });
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never came back");
    await (await $(`span=${path.basename(dir)}`)).click();
    await (await $("span=greeting.txt")).click();
    await waitForText("world", "the file never reopened");

    await (await $(".monaco-editor .view-lines")).click();
    await browser.keys(["Control", "End"]);
    await browser.keys("again".split(""));
    await browser.pause(4_000); // four times the delay auto save would have used
    assert.ok(
      !fs.readFileSync(file, "utf8").includes("again"),
      "the file was saved with auto save switched off",
    );

    await browser.keys(["Control", "s"]);
    await browser.waitUntil(() => fs.readFileSync(file, "utf8").includes("again"), {
      timeout: 10_000,
      timeoutMsg: "Ctrl+S no longer saves",
    });
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

  /**
   * The opposite gap: a server that IS installed and dies. Killing the running
   * pyright from outside is a real crash as far as Aime can tell - the pipe
   * closes with no shutdown request - and the banner has to go from silence to
   * an offer, because "installed but broken" used to be the one case with
   * nothing on screen at all.
   */
  it("offers AI when an installed language server stops working", async () => {
    try {
      execFileSync("where", ["pyright-langserver"], { stdio: "ignore" });
    } catch {
      console.log("[workflow.e2e] SKIPPED: the Python language server is not installed on this machine.");
      return;
    }
    const dir = project("lsp-crash");
    fs.writeFileSync(path.join(dir, "crash.py"), "value = 1\n");
    await open(dir);
    await waitForText("crash.py", "the project never opened");
    await (await $("span=crash.py")).click();

    // The cause first: the chip must be green before a kill proves anything.
    // Skipping rather than failing if it never starts, as the smoke spec does:
    // a server that cannot start here says nothing about the crash banner.
    const serverRunning = () =>
      browser.execute(() =>
        [...document.querySelectorAll("button")].some(
          (node) => node.textContent.trim() === "python" && node.className.includes("text-ok"),
        ),
      );
    try {
      await browser.waitUntil(serverRunning, { timeout: 90_000 });
    } catch {
      console.log("[workflow.e2e] SKIPPED: pyright never reached running on this machine.");
      return;
    }

    // The crash itself. Measured, not assumed: the `pyright-langserver.cmd`
    // shim runs `node …\node_modules\pyright\langserver.index.js`, so the node
    // process that must die never has "pyright-langserver" on its command line
    // - matching the shim's full name kills only the cmd.exe wrapper and the
    // server sails on. "pyright" reaches both. $PID keeps the killer from
    // matching its own command line.
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'pyright' " +
        "-and $_.ProcessId -ne $PID } | ForEach-Object " +
        "{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ]);

    await waitForText(
      "is installed but not working",
      "a crashed language server never produced the offer banner",
    );
    await waitForText("pyright-langserver", "the offer did not name the server that died");
    await waitForText("let ai set it up", "the banner offered no way forward");
  });
});
