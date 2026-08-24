/**
 * The terminal, driven against the real window.
 *
 * The first shell of a session is the one that broke: it opened blank, with no
 * prompt and no path, and only a second tab ever spoke. Nothing below this can
 * be unit-tested - a PTY, an event bridge and xterm.js only meet in the app.
 */
const { strict: assert } = require("node:assert");
const { workspace } = require("../wdio.conf.cjs");

/** What xterm has actually painted, row by row (it renders into the DOM). */
async function screenText() {
  return browser.execute(() => document.querySelector(".xterm-rows")?.textContent ?? "");
}

/**
 * The same, for the tab in front of the user rather than the first one made.
 * Every pane stays mounted so switching tabs never kills a shell, so the first
 * `.xterm-rows` in the document is whichever tab was opened first - not the one
 * a task just started.
 */
async function activeScreenText() {
  return browser.execute(
    () =>
      [...document.querySelectorAll(".xterm-rows")].find((rows) => rows.offsetParent !== null)
        ?.textContent ?? "",
  );
}

/** Each painted row on its own, which is how a wrapped prompt becomes visible. */
async function screenRows() {
  return browser.execute(() =>
    [...document.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent ?? ""),
  );
}

/** Size of the box xterm ended up with, for when a failure needs explaining. */
async function paneGeometry() {
  return browser.execute(() => {
    const screen = document.querySelector(".xterm-screen");
    return {
      width: screen?.clientWidth ?? 0,
      height: screen?.clientHeight ?? 0,
      rows: document.querySelectorAll(".xterm-rows > div").length,
    };
  });
}

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

describe("Terminal", () => {
  before(async () => {
    await browser.execute((path) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await waitForText("hello.ts", "the workspace never opened");
  });

  it("the first shell of the session prints a prompt in the project folder", async () => {
    await browser.keys(["Control", "`"]);
    await browser.waitUntil(async () => (await $$(".xterm-rows")).length > 0, {
      timeout: 10_000,
      timeoutMsg: "the terminal pane never mounted",
    });

    // The shell is cold on first open, so the wait is generous; what is being
    // checked is that the prompt arrives at all, not how fast.
    const folder = workspace.split(/[\\/]/).pop();
    let painted = "";
    await browser
      .waitUntil(
        async () => {
          painted = await screenText();
          return painted.includes(folder);
        },
        { timeout: 30_000 },
      )
      .catch(async () => {
        const geometry = await paneGeometry();
        assert.fail(
          `the first terminal never printed its prompt. painted=${JSON.stringify(painted)} ` +
            `geometry=${JSON.stringify(geometry)}`,
        );
      });
  });

  /**
   * A regression guard on the width, not a proof of the fix: told twelve
   * columns - xterm's fallback grid, which is what a pane still 0x0 at mount
   * reports - PowerShell writes its prompt twelve characters at a time, and
   * whether it recovers when the pane is resized out from under it is up to
   * PSReadLine. Measured both ways with instrumentation; the deterministic
   * part, and what a reader cares about, is that the prompt is one legible row.
   */
  it("shows the prompt on one row, not wrapped by a grid that was never real", async () => {
    const rows = await screenRows();
    const promptRow = rows.find((row) => row.includes("PS "));
    assert.ok(promptRow, `no prompt on any row: ${JSON.stringify(rows)}`);
    assert.ok(
      promptRow.includes(workspace.split(/[\\/]/).pop()),
      `the prompt was wrapped across rows, so the shell was started narrow: ${JSON.stringify(rows)}`,
    );
  });

  /**
   * The caret marks a position without covering the cell. Measured rather than
   * eyeballed, because "too big" was the report and the block was in fact
   * exactly one cell - 7.15x15.33 here against VS Code's 7.7x16.5 at its
   * default 14px. What was wrong was its weight, not its size.
   */
  it("marks the caret with a bar, not a filled cell", async () => {
    // xterm paints a bar as an inset box-shadow inside a cell-sized element, so
    // the element's own width says nothing - what is painted is the shadow.
    //
    // The focus goes inside the wait on purpose: focusing once before it lands on
    // nothing when the terminal has not finished mounting, and then the cursor
    // never renders at all - which is how this test failed under load while
    // passing on its own.
    const caret = await browser.waitUntil(
      async () =>
        browser.execute(() => {
          document.querySelector(".xterm-helper-textarea")?.focus();
          const cursor = document.querySelector('[class*="xterm-cursor"]');
          if (!cursor) return null;
          const style = getComputedStyle(cursor);
          return { style: cursor.className, shadow: style.boxShadow, fill: style.backgroundColor };
        }),
      // Generous on purpose: what this test asserts is the caret's *shape*, not
      // how fast a PowerShell starts on a loaded machine. Measured, the spec
      // finishes in 6-9s when the box is idle and took 26s when it was not,
      // which is what made this the one flaky test in the suite.
      { timeout: 60_000, timeoutMsg: "the caret never appeared" },
    );
    assert.match(caret.style, /xterm-cursor-bar/, `the caret is not a bar: ${caret.style}`);
    assert.match(caret.shadow, /\b2px\b.*inset/, `the caret is not a 2px bar: ${caret.shadow}`);
    assert.match(
      caret.fill,
      /rgba\(0, 0, 0, 0\)|transparent/,
      `the caret filled its whole cell: ${caret.fill}`,
    );
  });

  it("runs a command and shows its output", async () => {
    // Keystrokes go to whatever holds focus, and xterm reads them through a
    // helper textarea of its own - the pane behind it takes no input.
    await browser.execute(() => {
      document.querySelector(".xterm-helper-textarea")?.focus();
    });
    await browser.keys("echo aime-terminal-lives");
    await browser.keys("Enter");

    let painted = "";
    await browser
      .waitUntil(
        async () => {
          painted = await screenText();
          // Twice: the echoed command line, then what the shell answered.
          return painted.split("aime-terminal-lives").length > 2;
        },
        { timeout: 20_000 },
      )
      .catch(() => {
        assert.fail(`the shell never answered a command. painted=${JSON.stringify(painted)}`);
      });
  });

  /**
   * A task belonging to one folder of a repository that builds nothing at its
   * root. Detection can hand back the right command and the right label and
   * still be useless if the shell starts in the wrong folder, and only the real
   * app can show that: the PTY's working directory is decided in Rust, passed
   * from a tab, put there by the tasks store.
   *
   * The proof is behavioural rather than a reading of the prompt: `npm test`
   * started at the root would find no package.json at all, so the marker the
   * script prints can only appear if the shell really is inside `api`.
   */
  it("runs a folder's own task inside that folder", async () => {
    await (await $('button[title="Run a task (build / test / run)"]')).click();
    const task = await $("button=api · npm test");
    await task.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "the play menu did not offer the task of the folder below the root",
    });
    await task.click();

    let painted = "";
    await browser
      .waitUntil(
        async () => {
          painted = await activeScreenText();
          return painted.includes("the api suite ran here");
        },
        { timeout: 60_000 },
      )
      .catch(() => {
        assert.fail(`the task did not run in its own folder. painted=${JSON.stringify(painted)}`);
      });
  });
});
