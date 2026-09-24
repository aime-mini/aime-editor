/**
 * Dragging in the file tree, driven with real pointer events.
 *
 * The tree stopped using HTML5 drag-and-drop when Tauri's own drop was switched
 * on so that files dragged in from Explorer arrive with their paths (the two are
 * mutually exclusive in one window - see `stores/pathDrag.ts`). What replaced it
 * is a press, a move past a few pixels and a release, and every part of that
 * gesture is something a unit test cannot see: which row the pointer is over,
 * the label following it, the move landing on disk.
 *
 * WebDriver keeps a pressed button pressed between `perform()` calls, which is
 * what lets these tests look at the window in the middle of a drag.
 *
 * NOT covered, and not an oversight: a file dragged in from Explorer. That drop
 * is delivered by the operating system to Tauri, and no WebDriver can start an
 * OS-level drag.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * How far the pointer moves per event on its way.
 *
 * A hand on a mouse reports every few pixels. msedgedriver does not fill in a
 * `move` with a duration - it sends one event at the end - so a single move
 * would jump from the pressed row straight onto the target, and the target
 * would see the pointer arrive before the press had become a drag.
 */
const STEP_PX = 6;

const project = fs.mkdtempSync(path.join(os.tmpdir(), "aime-tree-drag-"));
const at = (...parts) => path.join(project, ...parts);

function writeFixture() {
  fs.writeFileSync(at("moved.js"), "export const moved = true;\n");
  fs.writeFileSync(at("notes.txt"), "a note that is only ever clicked\n");
  fs.writeFileSync(at("mention.txt"), "dragged into the prompt\n");
  fs.mkdirSync(at("docs"));
  fs.writeFileSync(at("docs", "guide.md"), "# Guide\n");
  fs.mkdirSync(at("src"));
  fs.writeFileSync(at("src", "main.js"), "console.log('main');\n");
}

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/**
 * The centre of a tree row, found by the name it shows.
 *
 * Anchored inside the tree: an open file's tab shows the same name, and a
 * pointer sent to the tab would be testing the tab strip.
 */
async function rowCentre(name) {
  const centre = await browser.execute((wanted) => {
    const tree = document.querySelector("div.select-none.overflow-y-auto");
    const label = [...(tree?.querySelectorAll("button span.truncate") ?? [])].find(
      (span) => span.textContent === wanted,
    );
    const row = label?.closest("button");
    if (!row) return null;
    const box = row.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }, name);
  assert.ok(centre, `no row named ${name} in the file tree`);
  return centre;
}

/** The centre of the tree's header - the project's own name, which is the root as a drop target. */
async function headerCentre() {
  return browser.execute(() => {
    const tree = document.querySelector("div.select-none.overflow-y-auto");
    const header = tree?.querySelector(":scope > div.uppercase");
    const box = header?.getBoundingClientRect();
    return box ? { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) } : null;
  });
}

/** What the window shows while a drag is under way. */
function dragMarks() {
  return browser.execute(() => {
    const ghost = document.querySelector("span.pointer-events-none.fixed");
    const target = document.querySelector("div.select-none.overflow-y-auto button.outline-accent");
    return {
      ghost: ghost?.textContent ?? null,
      target: target?.querySelector("span.truncate")?.textContent ?? null,
    };
  });
}

/** Presses on `from` and travels to `to` the way a hand does, leaving the button down. */
async function pressAndTravel(from, to) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / STEP_PX));
  let gesture = browser.action("pointer").move({ x: from.x, y: from.y }).down();
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
    gesture = gesture.move({ x, y });
  }
  await gesture.perform(true);
}

async function release(to) {
  await browser.action("pointer").move({ x: to.x, y: to.y }).up().perform();
}

async function drag(from, to) {
  await pressAndTravel(from, to);
  await release(to);
}

async function waitForDisk(check, message) {
  await browser.waitUntil(async () => check(), { timeout: 10_000, interval: 100, timeoutMsg: message });
}

/** Opens a folder row if it is closed, so the rows inside it can be reached. */
async function expand(folder, child) {
  const shown = await browser.execute(
    (name) =>
      [...document.querySelectorAll("div.select-none.overflow-y-auto button span.truncate")].some(
        (span) => span.textContent === name,
      ),
    child,
  );
  if (!shown) await (await $(`span=${folder}`)).click();
  await waitForText(child, `${folder} never showed ${child}`);
}

describe("Dragging in the file tree", () => {
  before(async () => {
    writeFixture();
    await browser.execute((recent) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
    }, project);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${path.basename(project)}`)).click();
    await waitForText("moved.js", "the project never opened");
  });

  after(() => {
    try {
      fs.rmSync(project, { recursive: true, force: true });
    } catch {
      /* Windows keeps a handle on the folder the app has open */
    }
  });

  it("moves a file into the folder it is dropped on, and shows the drag on its way", async () => {
    const from = await rowCentre("moved.js");
    const to = await rowCentre("docs");
    await pressAndTravel(from, to);
    let midway;
    try {
      midway = await dragMarks();
    } finally {
      // Released whatever happens: a pressed button outlives a failed
      // assertion and would turn the next test's click into a drag.
      await release(to);
    }

    // The gesture has to answer while it is happening: a pointer drag draws no
    // ghost of its own, and a drag with no feedback reads as one that failed.
    assert.equal(midway.ghost, "moved.js", "no label follows the pointer during the drag");
    assert.equal(midway.target, "docs", "the folder under the pointer is not marked as the drop target");

    await waitForDisk(() => fs.existsSync(at("docs", "moved.js")), "the file never arrived in docs");
    assert.ok(!fs.existsSync(at("moved.js")), "the file was copied, not moved");

    const after = await dragMarks();
    assert.equal(after.ghost, null, "the label stayed on screen after the drop");
    await expand("docs", "moved.js");
  });

  /**
   * Straight after a drop, on purpose. The drop used to leave the drag live -
   * the rows stop their release from bubbling, and the drag listened for it on
   * the way up - so this very click moved the file dropped a moment ago next
   * to the one being opened.
   */
  it("opens a file on a click that does not travel, even straight after a drop", async () => {
    await (await $("span=notes.txt")).click();
    await waitForText("a note that is only ever clicked", "a click on a file no longer opens it");
    assert.ok(fs.existsSync(at("notes.txt")), "a click moved the file");
    await browser.pause(500); // a move the click set off would be on disk by now
    assert.ok(fs.existsSync(at("docs", "moved.js")), "the click moved the file dropped before it");
    assert.equal((await dragMarks()).ghost, null, "a click left a drag label behind");
  });

  it("moves nothing when the drop lands on no target, and lets go of the drag", async () => {
    const from = await rowCentre("notes.txt");
    // The editor: not a folder, not a file row, not the prompt box.
    const editor = await browser.execute(() => {
      const box = document.querySelector(".monaco-editor")?.getBoundingClientRect();
      return box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null;
    });
    assert.ok(editor, "no editor on screen to drop onto");
    await drag(from, editor);

    await browser.waitUntil(async () => (await dragMarks()).ghost === null, {
      timeout: 5_000,
      timeoutMsg: "a drop outside every target left the label following the pointer",
    });
    assert.ok(fs.existsSync(at("notes.txt")), "a drop on nothing moved the file");
  });

  it("does not move a folder into itself", async () => {
    await expand("src", "main.js");
    await drag(await rowCentre("src"), await rowCentre("main.js"));
    // Dropping on a file means "next to it", and next to main.js is inside src.
    // Nothing is written for a refused move, so the check is that nothing
    // changed once the drop has certainly been handled.
    await browser.pause(1_000);
    assert.ok(fs.existsSync(at("src", "main.js")), "the folder was moved into itself");
    assert.ok(!fs.existsSync(at("src", "src")), "the folder was moved into itself");
  });

  it("brings a file back to the project's root when it is dropped on the project's name", async () => {
    const header = await headerCentre();
    assert.ok(header, "the tree has no header to drop onto");
    await drag(await rowCentre("moved.js"), header);
    await waitForDisk(() => fs.existsSync(at("moved.js")), "the file never came back to the root");
    assert.ok(!fs.existsSync(at("docs", "moved.js")), "the file was copied back, not moved");
  });

  it("turns a file dropped on the prompt box into an @ mention of its path", async () => {
    const prompt = await browser.execute(() => {
      const box = document.querySelector("textarea[placeholder]")?.getBoundingClientRect();
      return box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null;
    });
    assert.ok(prompt, "no prompt box on screen");
    await drag(await rowCentre("mention.txt"), prompt);

    const value = await browser.execute(() => document.querySelector("textarea[placeholder]")?.value ?? "");
    const mentioned = value.replaceAll("\\", "/");
    assert.ok(
      mentioned.includes(`@${at("mention.txt").replaceAll("\\", "/")}`),
      `the prompt box holds "${value}", not a mention of the dropped file`,
    );
    assert.ok(fs.existsSync(at("mention.txt")), "dropping on the prompt box moved the file");
  });
});
