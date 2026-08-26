/**
 * Plugins, from the two angles only the real window can show: one that works,
 * and one that asks for something it never declared.
 *
 * The plugin is written to Aime's own data folder by this spec, because that is
 * where plugins live - never in the project, since opening a repository must not
 * run its code. It is then switched on in Settings and run from the palette, the
 * way a person would.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fill } = require("../support/fields.cjs");

const PLUGIN_ID = "e2e-shout";
const pluginsDir = path.join(process.env.APPDATA ?? os.homedir(), "com.iodm.aiminieditor", "plugins");
const pluginDir = path.join(pluginsDir, PLUGIN_ID);

/**
 * Two commands on purpose: one inside what the manifest declared, one outside
 * it. The second is how the sandbox is proven - it must fail, and say why.
 */
const PLUGIN_SOURCE = [
  'aime.commands.register("shout", "E2E: shout the file", async () => {',
  "  const text = await aime.editor.getText();",
  "  await aime.editor.setText(text.toUpperCase());",
  "});",
  "",
  'aime.commands.register("sneak", "E2E: read a file it may not", async () => {',
  "  try {",
  '    await aime.workspace.readFile("secret.txt");',
  '    aime.ui.showMessage("read it, which should not have happened");',
  "  } catch (err) {",
  // `showMessage` rather than `log`: a plugin that wants to be seen says so and
  // Aime brings its output forward, while `log` deliberately does not steal the
  // panel - which is exactly why the fixture reports through the first one.
  '    aime.ui.showMessage("refused: " + err.message);',
  "  }",
  "});",
  "",
  "// Calls Aime in a loop: the host has to stop it, and the window has to stay",
  "// usable while it does.",
  'aime.commands.register("flood", "E2E: call Aime in a loop", () => {',
  '  for (let i = 0; i < 100000; i += 1) aime.ui.showMessage("flood " + i);',
  "});",
  "",
].join("\n");

const projects = [];

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aime-${name}-`));
  projects.push(dir);
  return dir;
}

function installPlugin() {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        id: PLUGIN_ID,
        name: "E2E shout",
        version: "1.0.0",
        description: "Uppercases the open file, and tries one thing it may not.",
        main: "main.js",
        // Only the editor: the second command asks for files on purpose.
        capabilities: ["editor", "ui"],
        apiVersion: 1,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(pluginDir, "main.js"), PLUGIN_SOURCE);
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

async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
  }, dir);
  await browser.refresh();
  await waitForText("RECENT", "the welcome screen never rendered");
  await (await $(`span=${dir.split(/[\\/]/).pop()}`)).click();
  await waitForText(dir, `the status bar never reported ${dir} as the open project`);
}

/** Runs one of the plugin's commands through the palette, the way a user does. */
async function runFromPalette(title) {
  await browser.keys(["Control", "k"]);
  // The palette's own field: `input[placeholder]` also matches the Debug
  // Console's disabled one, which is not interactable and not the point.
  await fill(await $('input[placeholder^="Type a command"]'), title);
  await waitForText(title, `the palette never offered "${title}"`);
  await browser.keys(["Enter"]);
}

describe("Plugins", () => {
  before(() => {
    installPlugin();
  });

  after(() => {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    } catch {
      /* leaving a test plugin behind is not worth failing a run over */
    }
    for (const dir of projects) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows keeps a handle on the folder the app has open */
      }
    }
  });

  it("runs a plugin the user switched on, and lets its edit be undone", async () => {
    const dir = project("plugin");
    fs.writeFileSync(path.join(dir, "note.txt"), "hello plugin\n");
    await open(dir);

    // Off until switched on: a plugin that is merely present must never run.
    await browser.keys(["Control", ","]);
    await waitForText("e2e shout", "the plugin was not listed in Settings");
    // By the checkbox's own tooltip: it names the plugin, which is both better to
    // hover over and the one selector that cannot drift to another row.
    await (await $('input[title="Run E2E shout"]')).click();
    await waitForText("running", "the plugin never started");
    await browser.keys(["Escape"]);

    await (await $("span=note.txt")).click();
    await browser.waitUntil(async () => (await $$(".view-line")).length >= 1, {
      timeout: 20_000,
      timeoutMsg: "the editor never rendered the file",
    });

    await runFromPalette("E2E: shout the file");
    await waitForText("HELLO PLUGIN", "the plugin's edit never reached the editor", 30_000);

    // Through Monaco, so the user's own undo takes it back.
    await (await $(".view-line")).click();
    await browser.keys(["Control", "z"]);
    await waitForText("hello plugin", "the plugin's edit could not be undone");
  });

  /**
   * The promise the sandbox makes: a plugin's mistake costs the plugin, not the
   * editor. This one calls into Aime a hundred thousand times; the host stops it
   * for running away, and the window is still answering afterwards.
   */
  it("stops a plugin that calls in a loop, and the window keeps working", async () => {
    const started = Date.now();
    await runFromPalette("E2E: call Aime in a loop");
    await waitForText("stopped:", "the runaway plugin was never stopped", 30_000);
    // How long the window took to say so, which is the cost of the flood: this
    // reading only comes back once the renderer has drained every message the
    // plugin managed to post, so it measures the Worker's own ceiling
    // (MAX_WORKER_POSTS_PER_SECOND) rather than the host's rate limit.
    const noticedIn = Date.now() - started;
    console.log(`[plugins.e2e] the runaway was stopped and reported in ${noticedIn} ms`);
    assert.ok(noticedIn < 20_000, `the window needed ${noticedIn} ms to report the runaway plugin`);
    const shown = await bodyText();
    assert.ok(
      shown.toLowerCase().includes("loop rather than work"),
      `the reason should say what Aime saw: ${shown.slice(0, 300)}`,
    );

    // Still alive: the palette opens and answers, which is the whole point of a
    // plugin living in a worker rather than in the window.
    await browser.keys(["Control", "k"]);
    await fill(await $('input[placeholder^="Type a command"]'), "Settings");
    await waitForText("settings", "the window stopped answering after the runaway plugin");
    await browser.keys(["Escape"]);

    // And it can be started again without untick/retick.
    await browser.keys(["Control", ","]);
    await (await $('button[title="Start it again"]')).click();
    await waitForText("running", "a stopped plugin could not be started again");
    await browser.keys(["Escape"]);
  });

  it("refuses a call the plugin never declared, and says which capability it needed", async () => {
    await runFromPalette("E2E: read a file it may not");
    await waitForText("refused:", "the plugin's own report of the refusal never appeared", 30_000);
    const shown = await bodyText();
    assert.ok(
      shown.includes("files"),
      `the refusal should name the missing capability: ${shown.slice(0, 400)}`,
    );
  });
});
