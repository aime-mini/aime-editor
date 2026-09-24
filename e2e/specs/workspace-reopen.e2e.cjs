/**
 * A workspace reopened the way it was left, across a real close of the app.
 *
 * The close is the one a person makes: WM_CLOSE, which is what the X and
 * Alt+F4 send, so the window goes through the same held close that writes the
 * workspace's state before it lets go (`session/closing.rs`). WebDriver's own
 * close-window would end the webview underneath Tauri and prove nothing.
 *
 * Windows only, like the rest of this suite: tauri-driver drives WebView2.
 */
const { strict: assert } = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const project = fs.mkdtempSync(path.join(os.tmpdir(), "aime-reopen-"));
const at = (...parts) => path.join(project, ...parts);
const CART = at("src", "cart.ts");
const PRICE = at("src", "price.ts");
/** Deep enough that the line it was left on is off the first screen. */
const LEFT_ON_LINE = 90;
const TYPED = "// typed a moment before the window closed";

/** Where the app keeps each workspace's state (`session/mod.rs`). */
const STATE_DIR = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor", "workspaces");

function writeFixture() {
  fs.mkdirSync(at("src"));
  const lines = Array.from({ length: 120 }, (_, index) => `export const line${index + 1} = ${index + 1};`);
  fs.writeFileSync(CART, `${lines.join("\n")}\n`);
  fs.writeFileSync(PRICE, "export const price = 1;\n");
}

async function waitForText(text, message, timeout = 30_000) {
  const needle = text.toLowerCase();
  await browser.waitUntil(
    async () => {
      try {
        return (await $("body").getText()).toLowerCase().includes(needle);
      } catch {
        return false; // the page is still being replaced
      }
    },
    { timeout, timeoutMsg: message ?? `never saw "${text}"` },
  );
}

/**
 * Opens the project the only way a driver can - through the recent list - with
 * auto save off, so text typed stays unsaved: that text is what the close has
 * to carry over, and auto save would write it to the file first.
 */
async function openProject() {
  await browser.waitUntil(
    async () =>
      browser
        .execute(() => {
          try {
            return localStorage.length >= 0;
          } catch {
            return false;
          }
        })
        .catch(() => false),
    { timeout: 60_000, timeoutMsg: "the editor window never took over from the greeting" },
  );
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
    localStorage.setItem("aime.settings", JSON.stringify({ autoSave: false }));
  }, project);
  await browser.refresh();
  await waitForText("RECENT", "the welcome screen never rendered");
  await (await $(`span=${path.basename(project)}`)).click();
  await waitForText(project, "the project never opened");
}

/** Rows the file tree shows, by name - anchored in the tree, not read off the page. */
function treeRows() {
  return browser.execute(() =>
    [...document.querySelectorAll("div.select-none.overflow-y-auto button span.truncate")].map(
      (span) => span.textContent,
    ),
  );
}

/** The editor tab strip, in order, by file name - each tab carries its path as its title. */
function tabStrip() {
  return browser.execute(() =>
    [...document.querySelectorAll("div.overflow-x-auto.pt-1 > div[title]")].map((tab) =>
      (tab.getAttribute("title") ?? "").split(/[\\/]/).pop(),
    ),
  );
}

/** Where the cursor of the editor on screen is, as Monaco itself reports it. */
function cursorLine() {
  return browser.executeAsync((done) => {
    import("/src/lib/monacoAccess.ts")
      .then((module) => {
        done(module.activeEditor()?.getPosition()?.lineNumber ?? null);
      })
      .catch(() => {
        done(null);
      });
  });
}

/**
 * Readies a WM_CLOSE for the window of the app this run started - the one
 * whose parent is this run's driver, never an Aime the user has open - and
 * sends it the moment `fire` is called.
 *
 * Armed ahead of time because PowerShell takes half a second to start, longer
 * than the delay before the app writes on its own: a close sent from a cold
 * start would find everything already written and prove nothing about the
 * close itself. Armed, the message goes out within a few milliseconds.
 */
async function armTheClose() {
  const name = `${path.basename(project)}-close`;
  const script = path.join(os.tmpdir(), `${name}.ps1`);
  const signal = path.join(os.tmpdir(), `${name}.go`);
  fs.rmSync(signal, { force: true });
  fs.writeFileSync(
    script,
    [
      "Add-Type -Namespace Aime -Name User32 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool PostMessage(System.IntPtr window, uint message, System.IntPtr w, System.IntPtr l);'",
      // The Edge driver is kept under a name per version (msedgedriver-edge153.exe).
      "$drivers = @(Get-Process | Where-Object { $_.Name -eq 'tauri-driver' -or $_.Name -like 'msedgedriver*' } | ForEach-Object { $_.Id })",
      "$app = Get-CimInstance Win32_Process -Filter \"Name='ai-mini-editor.exe'\" | Where-Object { $drivers -contains $_.ParentProcessId } | Select-Object -First 1",
      'if (-not $app) { throw "no app started by this run (drivers: $drivers)" }',
      "$window = (Get-Process -Id $app.ProcessId).MainWindowHandle",
      'Write-Output "armed $($app.ProcessId)"',
      `while (-not (Test-Path '${signal}')) { Start-Sleep -Milliseconds 5 }`,
      "[void][Aime.User32]::PostMessage($window, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero)",
    ].join("\n"),
  );
  const shell = spawn("powershell", ["-NoProfile", "-File", script], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  shell.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const pid = await new Promise((resolve, reject) => {
    shell.stdout.on("data", (chunk) => {
      const armed = /armed (\d+)/.exec(String(chunk));
      if (armed) resolve(Number(armed[1]));
    });
    shell.on("exit", () => {
      reject(new Error(`the close could not be armed: ${errors}`));
    });
  });
  const posted = new Promise((resolve) => shell.on("exit", resolve));
  return {
    pid,
    /** Sends the WM_CLOSE, and resolves once it has gone out. */
    fire: async () => {
      fs.writeFileSync(signal, "");
      await posted;
      fs.rmSync(script, { force: true });
      fs.rmSync(signal, { force: true });
    },
  };
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes the app the way a person does, waits for it to be gone, and starts it
 * again. `armed` is a close readied before the last keystroke, for a test that
 * needs the close to follow it at once.
 */
async function restartTheApp(armed) {
  const close = armed ?? (await armTheClose());
  const firedAt = Date.now();
  await close.fire();
  await browser.waitUntil(async () => !isRunning(close.pid), {
    timeout: 10_000,
    interval: 20,
    timeoutMsg: "the window did not close on WM_CLOSE",
  });
  console.log(`[workspace-reopen] WM_CLOSE to gone: ${Date.now() - firedAt} ms`);
  await browser.reloadSession();
  await openProject();
}

describe("A workspace reopened after the app was closed", () => {
  before(async () => {
    writeFixture();
    await openProject();
  });

  after(() => {
    for (const leftover of [project, ...stateFilesOfThisProject()]) {
      try {
        fs.rmSync(leftover, { recursive: true, force: true });
      } catch {
        /* Windows keeps a handle on the folder the app has open */
      }
    }
  });

  function stateFilesOfThisProject() {
    const prefix = path.basename(project).toLowerCase();
    return fs.existsSync(STATE_DIR)
      ? fs
          .readdirSync(STATE_DIR)
          .filter((name) => name.startsWith(prefix))
          .map((name) => path.join(STATE_DIR, name))
      : [];
  }

  it("comes back with its tabs, the file in front, unsaved text, cursor and open folders", async () => {
    await (await $("span=src")).click();
    await waitForText("cart.ts", "the src folder never opened in the tree");
    await (await $("span=cart.ts")).click();
    await browser.waitUntil(async () => (await $$(".view-line")).length > 5, {
      timeout: 20_000,
      timeoutMsg: "the editor never rendered cart.ts",
    });
    // Ctrl+G is Monaco's own go-to-line: the cursor moves the way a person moves it.
    await (await $(".monaco-editor .view-lines")).click();
    await browser.keys(["Control", "g"]);
    await browser.keys(String(LEFT_ON_LINE).split(""));
    await browser.keys(["Enter"]);
    await browser.waitUntil(async () => (await cursorLine()) === LEFT_ON_LINE, {
      timeout: 5_000,
      timeoutMsg: "go-to-line did not move the cursor",
    });

    await (await $("span=price.ts")).click();
    await waitForText("export const price", "price.ts never opened");
    await (await $(".monaco-editor .view-lines")).click();
    await browser.keys(["Control", "End"]);
    const close = await armTheClose();
    await browser.keys(TYPED.split(""));
    // Closed at once, well inside the delay before the app writes on its own:
    // only the held close can carry the last keystrokes over.
    await restartTheApp(close);

    await waitForText(TYPED, "the unsaved text did not come back");
    assert.deepEqual(await tabStrip(), ["cart.ts", "price.ts"], "the tabs did not come back in their order");
    assert.equal(
      fs.readFileSync(PRICE, "utf8"),
      "export const price = 1;\n",
      "the unsaved text was written to the file",
    );
    assert.ok(
      await browser.execute(() => document.querySelector('span[title^="Unsaved"]') !== null),
      "the text came back without its unsaved dot",
    );
    assert.ok((await treeRows()).includes("cart.ts"), "the src folder came back closed");

    await (await $("span=cart.ts")).click();
    await browser.waitUntil(async () => (await cursorLine()) === LEFT_ON_LINE, {
      timeout: 10_000,
      timeoutMsg: `cart.ts did not open at line ${LEFT_ON_LINE}`,
    });
    // At the line, not only with the cursor on it: it is on screen.
    await waitForText(`export const line${LEFT_ON_LINE} =`, "the line it was left on is not on screen");
  });

  it("keeps the unsaved text when the file changed meanwhile, and gives it up only when asked", async () => {
    await restartTheApp(); // price.ts still holds the unsaved text from the last test
    fs.writeFileSync(PRICE, "export const price = 42; // changed while Aime was closed\n");
    await restartTheApp();

    await (await $("span=price.ts")).click();
    await waitForText("changed on disk while Aime was closed", "no word that the file changed meanwhile");
    await waitForText(TYPED, "the unsaved text was dropped because the file changed");

    await (await $("button=Use the file on disk")).click();
    await waitForText("changed while Aime was closed", "the file on disk did not replace the unsaved text");
    assert.ok(
      await browser.execute(() => document.querySelector('span[title^="Unsaved"]') === null),
      "the file on disk is shown as unsaved",
    );
  });
});
