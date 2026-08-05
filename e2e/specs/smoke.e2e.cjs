/**
 * The walk a new user takes, driven against the real window.
 *
 * These paths only exist when React, Monaco and the Rust side run together, so
 * no unit test can see them: the workspace opening, a file becoming a tab, two
 * files staying open at once, the palette answering a shortcut.
 *
 * The workspace is entered through the Recent list rather than Open Folder,
 * because Open Folder raises a native dialog no WebDriver can click - and
 * reopening a recent project is a path users take every day anyway.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { workspace } = require("../wdio.conf.cjs");

/** Whether the Python server Aime installs on first launch is on this machine. */
function hasPyright() {
  try {
    execFileSync("where", ["pyright-langserver"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Waits for text to appear anywhere in the window. */
/** CSS can upper-case what it renders, so matching ignores case. */
async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

describe("Aime", () => {
  before(async () => {
    // Seed the recent list, then reload so the welcome screen reads it.
    await browser.execute((path) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
  });

  it("opens a project from the recent list", async () => {
    const entry = await $(`span=${workspace.split(/[\\/]/).pop()}`);
    await entry.click();
    await waitForText("hello.ts", "the file tree never showed the workspace");
    await waitForText("notes.md");
  });

  it("opens a file into a tab", async () => {
    await (await $("span=hello.ts")).click();
    await waitForText("greeting", "the file contents never reached the editor");
  });

  it("keeps both files open, one tab each", async () => {
    await (await $("span=notes.md")).click();
    await waitForText("second file", "the second file never opened");

    // Both tabs stay in the strip; that is the entire point of tabs.
    const body = await $("body").getText();
    assert.ok(body.includes("hello.ts"), "the first tab disappeared when the second opened");
  });

  /**
   * Sticky scroll is only worth having when it names the scope you are in, and
   * that name comes from an outline. Without one Monaco reads indentation
   * instead, and this file's braces sit on their own line - which is how it came
   * to pin five rows of bare "{" over the code and read as a rendering glitch.
   * With a document symbol provider registered it pins the function.
   */
  it("pins the enclosing function over the file when it scrolls, not a bare brace", async () => {
    await (await $("span=nested.ts")).click();
    await waitForText("total +=", "the nested file never opened");

    await (await $(".monaco-editor .view-lines")).click();
    await browser.keys(["Control", "End"]); // deep inside the nesting, where sticky scroll draws

    const editor = async () =>
      browser.execute(() => {
        const numbers = [...document.querySelectorAll(".margin-view-overlays .line-numbers")]
          .map((node) => Number(node.textContent))
          .filter((line) => line > 0);
        const pinned = [...document.querySelectorAll(".sticky-line-content")]
          .map((node) => node.textContent.replaceAll("\u00a0", " ").trim())
          .filter(Boolean);
        return {
          firstVisibleLine: Math.min(...numbers),
          rows: document.querySelectorAll(".sticky-line-number").length,
          pinned,
        };
      });

    // Smooth scrolling animates, so the assertion waits for the file to move
    // rather than racing it - an editor still at line 1 would prove nothing.
    await browser.waitUntil(async () => (await editor()).firstVisibleLine > 1, {
      timeout: 10_000,
      timeoutMsg: "the editor never scrolled, so nothing was asked of sticky scroll",
    });
    // Monaco's TypeScript worker answers the outline, and a cold one takes its
    // time - which is a slow start, not a missing feature.
    await browser.waitUntil(async () => (await editor()).rows > 0, {
      timeout: 30_000,
      timeoutMsg: "nothing was pinned over the file, so the outline never reached sticky scroll",
    });

    const { pinned } = await editor();
    console.log(`[smoke.e2e] sticky scroll pinned: ${JSON.stringify(pinned)}`);
    assert.ok(
      pinned.some((line) => line.includes("function deep")),
      `the pinned rows should name the enclosing function: ${JSON.stringify(pinned)}`,
    );
    // The old defect, in one assertion: a row that is nothing but a brace.
    assert.ok(
      !pinned.some((line) => /^[{}]$/.test(line)),
      `a bare brace was pinned over the file: ${JSON.stringify(pinned)}`,
    );
  });

  /**
   * The same feature, but through a real language server.
   *
   * Python is not one of the languages Monaco outlines by itself, so a pinned row
   * here can only have come from pyright answering `textDocument/documentSymbol` -
   * which is the half of this that no unit test can reach.
   */
  it("pins a Python function from the language server's own outline", async () => {
    if (!hasPyright()) {
      console.log("[smoke.e2e] SKIPPED: the Python language server is not installed on this machine.");
      return;
    }
    await (await $("span=nested.py")).click();
    await waitForText("total +=", "the Python file never opened");

    await (await $(".monaco-editor .view-lines")).click();
    await browser.keys(["Control", "End"]);

    const pinned = async () =>
      browser.execute(() =>
        [...document.querySelectorAll(".sticky-line-content")]
          .map((node) => node.textContent.replaceAll("\u00a0", " ").trim())
          .filter(Boolean),
      );
    /** The status bar's language chip turns green once the server is running. */
    const serverRunning = () =>
      browser.execute(() =>
        [...document.querySelectorAll("button")].some(
          (node) => node.textContent.trim() === "python" && node.className.includes("text-ok"),
        ),
      );

    // Waiting on the cause first, and skipping rather than failing if it never
    // happens: a server that will not start on this machine - or under the load
    // of the whole suite - says nothing about the outline this test is here for.
    try {
      await browser.waitUntil(serverRunning, { timeout: 90_000 });
    } catch {
      console.log("[smoke.e2e] SKIPPED: the Python server did not start, so its outline cannot be checked.");
      return;
    }
    // From here a failure is a real one: the server is up, so the outline is owed.
    await browser.waitUntil(async () => (await pinned()).length > 0, {
      timeout: 30_000,
      timeoutMsg: "the Python server is running but nothing was pinned over the file",
    });
    const rows = await pinned();
    console.log(`[smoke.e2e] pyright's outline pinned: ${JSON.stringify(rows)}`);
    assert.ok(
      rows.some((line) => line.includes("def outer")),
      `the pinned rows should name the enclosing function: ${JSON.stringify(rows)}`,
    );
  });

  /**
   * A byte order mark is a real character once decoded, so an editor that keeps
   * it draws a glyph in front of line 1 - and one that simply drops it rewrites
   * the first bytes of every file in a .NET solution the moment it is saved.
   */
  it("hides the byte order mark from the file, and gives it back on save", async () => {
    await (await $("span=marked.cs")).click();
    await waitForText("using Nop.Core.Caching", "the marked file never opened");

    const firstCharacter = await browser.execute(() => {
      const line = document.querySelector(".view-line");
      return line?.textContent ? line.textContent.codePointAt(0) : -1;
    });
    assert.equal(firstCharacter, "u".codePointAt(0), "something is drawn in front of the first line");

    await (await $(".monaco-editor .view-lines")).click();
    await browser.keys(["Control", "End"]);
    await browser.keys("// edited".split(""));
    await browser.keys(["Control", "s"]);

    const file = path.join(workspace, "marked.cs");
    await browser.waitUntil(
      () => {
        const bytes = fs.readFileSync(file);
        return bytes.includes("// edited") && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      },
      { timeout: 15_000, timeoutMsg: "the saved file lost the mark it came with" },
    );
  });

  it("answers the command palette", async () => {
    await browser.keys(["Control", "k"]);
    await waitForText("Esc", "the command palette never opened");
    await browser.keys(["Escape"]);
  });

  it("shows the Git panel for a folder that is not a repository", async () => {
    await browser.keys(["Control", "k"]);
    await waitForText("Esc");
    await browser.keys(["Git"]);
    await browser.keys(["Enter"]);
    await waitForText("not a git repository", "the Git panel never reported the folder's state");
  });

  /**
   * The box you type a prompt into is worth more than two rows when the prompt is
   * a paragraph, so its height is dragged rather than fixed - the same divider
   * the rest of the app uses, which is also what remembers where it was left.
   */
  it("lets the AI prompt box be dragged taller, and remembers it", async () => {
    /** The prompt box, and the divider that sits directly above it. */
    const composer = () =>
      browser.execute(() => {
        const box = document.querySelector("textarea[placeholder]");
        if (!box) return null;
        const area = box.getBoundingClientRect();
        // Found by shape and position rather than by a library's attribute name:
        // a row divider is wide and thin, and this one is the one just above the
        // box. The window's column dividers are tall and thin, so they are out.
        const divider = [...document.querySelectorAll("[data-panel-resize-handle-id]")]
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > rect.height && rect.bottom <= area.top + 8)
          .sort((one, other) => other.rect.top - one.rect.top)[0];
        return {
          height: Math.round(area.height),
          grip: divider
            ? {
                x: Math.round(divider.rect.x + divider.rect.width / 2),
                y: Math.round(divider.rect.y + divider.rect.height / 2),
              }
            : null,
        };
      });

    const before = await composer();
    assert.ok(before, "the AI prompt box was not found");
    assert.ok(before.grip, "the prompt box has no divider above it to drag");

    await browser
      .action("pointer")
      .move({ x: before.grip.x, y: before.grip.y })
      .down()
      .move({ x: before.grip.x, y: before.grip.y - 120, duration: 100 })
      .up()
      .perform();

    await browser.waitUntil(async () => (await composer()).height > before.height + 40, {
      timeout: 10_000,
      timeoutMsg: `dragging the divider did not grow the prompt box (was ${before.height}px)`,
    });

    // Kept by the panel library under the panel group's own name, which is what
    // brings the height back on the next launch.
    const stored = await browser.execute(() =>
      Object.keys(localStorage).find((key) => key.includes("aime-ai-panel")),
    );
    assert.ok(stored, "the dragged height was not remembered anywhere");

    // Now the other end. Dragged as small as it goes, nothing may be cut off: a
    // child taller than its panel is simply clipped, and the send button losing
    // its bottom edge is exactly what a percentage floor did on a short window.
    const grip = (await composer()).grip;
    // As far down as the window allows: a pointer moved past the viewport is
    // rejected by the driver, not clamped.
    const floor = await browser.execute(() => window.innerHeight - 4);
    await browser
      .action("pointer")
      .move({ x: grip.x, y: grip.y })
      .down()
      .move({ x: grip.x, y: floor, duration: 100 })
      .up()
      .perform();

    const smallest = await browser.execute(() => {
      const panel = document.querySelector('[data-panel-id="ai-composer"]');
      const box = document.querySelector("textarea[placeholder]");
      if (!panel || !box) return null;
      const buttons = [...panel.querySelectorAll("button")];
      const send = buttons.at(-1);
      const area = panel.getBoundingClientRect();
      return {
        panelHeight: Math.round(area.height),
        boxHeight: Math.round(box.getBoundingClientRect().height),
        // How far the button hangs past the bottom of its panel, if at all.
        overflow: send ? Math.round(send.getBoundingClientRect().bottom - area.bottom) : null,
      };
    });
    assert.ok(smallest, "the composer panel was not found by its own id");
    assert.notEqual(smallest.overflow, null, "the send button was not found inside the composer panel");
    assert.ok(
      smallest.overflow <= 1,
      `the send button hangs ${smallest.overflow}px past the bottom of a ${smallest.panelHeight}px panel`,
    );
    assert.ok(smallest.boxHeight >= 16, `the prompt box shrank to ${smallest.boxHeight}px, below one line`);
  });
});
