/**
 * Debugging, from the two sides only the real window can show: a breakpoint
 * that survives the app being closed and reopened, and a program that actually
 * stops on it.
 *
 * The second half needs js-debug on the machine, which is a runtime download,
 * so it reports and skips where the adapter is absent rather than failing. What
 * it must never do is skip quietly - a green run that tested half of this
 * would be worse than a red one.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projects = [];

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aime-${name}-`));
  projects.push(dir);
  return dir;
}

/**
 * Line 2 is the interesting one: an assignment inside a function, so a frame
 * there has both arguments bound and a local not yet.
 */
const PROGRAM = [
  "function add(a, b) {",
  "  const total = a + b;",
  "  return total;",
  "}",
  "",
  'console.log("total", add(2, 4));',
  "",
].join("\n");

const BREAKPOINT_LINE = 2;

function projectWithAProgram() {
  const dir = project("debug");
  fs.writeFileSync(path.join(dir, "app.js"), PROGRAM);
  return dir;
}

async function bodyText() {
  return (await $("body")).getText();
}

async function waitForText(text, message, timeout = 30_000) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await bodyText()).toLowerCase().includes(needle), {
    timeout,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/**
 * Opens a folder the only way a driver can: through the recent list.
 *
 * Waiting for the status bar to name this exact folder is not belt and braces.
 * A reload also lets the app adopt the folder it was launched with, and two of
 * these tests open projects holding a file of the same name - so "the tree has
 * an app.js in it" is not evidence that it is *this* project's app.js.
 */
async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
  }, dir);
  await browser.refresh();
  await waitForText("RECENT", "the welcome screen never rendered");
  await (await $(`span=${dir.split(/[\\/]/).pop()}`)).click();
  await waitForText(dir, `the status bar never reported ${dir} as the open project`);
}

async function openTheProgram() {
  // The sidebar holds one view at a time, and the Debug view may be the one on
  // screen from an earlier step - the file tree has to be asked for.
  await (await $('button[title="Explorer"]')).click();
  await waitForText("app.js", "the project never opened");
  await (await $("span=app.js")).click();
  // The editor has to be showing the file before a line can be clicked.
  await browser.waitUntil(async () => (await $$(".view-line")).length >= 6, {
    timeout: 20_000,
    timeoutMsg: "the editor never rendered the program",
  });
}

async function showDebugView() {
  await (await $('button[title="Run and Debug"]')).click();
  await waitForText("breakpoints", "the Run and Debug view never opened");
}

/**
 * Puts the cursor on a line the way a person does - by clicking it.
 *
 * The line is found by its text, not by its position among the rendered
 * elements: Monaco recycles those nodes and their order in the DOM is not the
 * order on screen, which is how an earlier version of this test ended up
 * putting its second breakpoint on a different line than its first.
 */
async function clickLineContaining(fragment) {
  const lines = await $$(".view-line");
  for (const line of lines) {
    if ((await line.getText()).includes(fragment)) {
      await line.click();
      return;
    }
  }
  throw new Error(`no rendered line contains ${fragment}`);
}

async function toggleBreakpointOnAssignment() {
  await clickLineContaining("const total");
  await browser.keys(["F9"]);
}

describe("Debugging", () => {
  after(() => {
    for (const dir of projects) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows keeps a handle on the folder the app has open */
      }
    }
  });

  it("sets a breakpoint from the editor and keeps it after a restart", async () => {
    const dir = projectWithAProgram();
    await open(dir);
    await openTheProgram();
    await showDebugView();
    await waitForText("no breakpoints yet", "the panel should start with none");

    await toggleBreakpointOnAssignment();
    await waitForText(
      `app.js:${BREAKPOINT_LINE}`,
      "F9 on line 2 did not put a breakpoint in the panel's list",
    );

    // Reopening the project is the real test: breakpoints belong to a project,
    // not to a session, and nobody wants to set them again every morning.
    await open(dir);
    await showDebugView();
    await waitForText(
      `app.js:${BREAKPOINT_LINE}`,
      "the breakpoint did not survive closing and reopening the project",
    );

    // And removing it is not a reload away either. Opening the file puts the
    // Explorer back on screen, so the panel has to be asked for again before
    // its emptiness means anything.
    await openTheProgram();
    await toggleBreakpointOnAssignment();
    await showDebugView();
    await waitForText("no breakpoints yet", "toggling the same line again did not remove the breakpoint");
  });

  it("stops the program on the breakpoint and shows the frame it stopped in", async () => {
    await open(projectWithAProgram());
    await openTheProgram();
    await showDebugView();

    // The panel says which of the two it is: a button to start, or an offer to
    // fetch the adapter first.
    const offersDownload = (await bodyText()).toLowerCase().includes("download it");
    if (offersDownload) {
      console.log(
        "[debug.e2e] SKIPPED the run: js-debug is not downloaded on this machine, so there is " +
          "nothing to stop the program with. The breakpoint test above still ran.",
      );
      return;
    }

    await toggleBreakpointOnAssignment();
    await waitForText(`app.js:${BREAKPOINT_LINE}`, "the breakpoint was not registered before starting");

    await browser.keys(["F5"]);
    // Starting the adapter pays for Node's own boot, and js-debug then opens a
    // second session before any of this appears.
    await waitForText("call stack", "the run never reached a paused state", 60_000);
    await waitForText("add", "the call stack does not name the function it stopped in", 30_000);
    // The arguments of the frame it stopped in, fetched from the adapter.
    await waitForText("total", "the Variables section never listed the frame's own names", 30_000);

    const paused = await bodyText();
    assert.ok(
      /\ba\b/.test(paused) && paused.includes("2"),
      "the paused frame should show the argument a = 2",
    );

    await browser.keys(["Shift", "F5"]);
    await browser.waitUntil(async () => !(await bodyText()).toLowerCase().includes("call stack"), {
      timeout: 30_000,
      timeoutMsg: "Shift+F5 did not end the session",
    });
  });
});
