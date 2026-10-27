/**
 * A command the AI read out of a project is run once before it is saved.
 *
 * The stand-in `claude` first proposes a build the project does not take - a
 * flag its build script rejects - so the trial fails; shown the failure, it
 * answers the right command, which is run again and only then saved. "The
 * program is on PATH" alone would have saved the wrong one. Run with
 * `npm run test:e2e:fake-claude`.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { workspace, fakeClaudeState } = require("../wdio.fake-claude.cjs");

const BUILD_SCRIPT = path.join(workspace, "build.cjs");
const TASKS_FILE = path.join(workspace, ".aime", "tasks.json");
/** Says the project was already read for its tasks; gone, the opening reads it again. */
const PROFILED = path.join(workspace, ".aime", "task-profile-read");
const CALLS_FILE = path.join(fakeClaudeState, "calls.jsonl");

/** A build that takes no options, and says so when it is given one. */
const BUILD_SOURCE = `if (process.argv.includes("--wrong")) {
  console.error("build.cjs: unknown option --wrong");
  process.exit(1);
}
console.log("built");
`;

const callsOf = (mode) =>
  fs.existsSync(CALLS_FILE)
    ? fs
        .readFileSync(CALLS_FILE, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((call) => call.mode === mode)
    : [];

describe("A command the AI proposes is tried before it is saved", () => {
  let savedProvider = null;

  before(async () => {
    fs.writeFileSync(BUILD_SCRIPT, BUILD_SOURCE);
    fs.rmSync(TASKS_FILE, { force: true });
    fs.rmSync(PROFILED, { force: true });
    fs.writeFileSync(path.join(fakeClaudeState, "mode.txt"), "tasks");
    savedProvider = await browser.execute((folder) => {
      const before = localStorage.getItem("aime.provider");
      localStorage.setItem("aime.provider", "claude");
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
      return before;
    }, workspace);
    await browser.refresh();
    await browser.waitUntil(async () => (await $("body").getText()).includes("RECENT"), { timeout: 30_000 });
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("hello.ts"), {
      timeout: 30_000,
    });
  });

  after(async () => {
    fs.rmSync(BUILD_SCRIPT, { force: true });
    fs.rmSync(TASKS_FILE, { force: true });
    await browser.execute((before) => {
      if (before === null) localStorage.removeItem("aime.provider");
      else localStorage.setItem("aime.provider", before);
    }, savedProvider);
  });

  it("tries the proposed build, hands the failure back, and saves the corrected one once it runs", async () => {
    // Nothing is clicked: opening a project whose tasks Aime could not work
    // out has the AI read it by itself, and that pass is what is under test.
    await browser.waitUntil(() => fs.existsSync(TASKS_FILE), {
      timeout: 90_000,
      timeoutMsg: "no task was ever saved",
    });
    const saved = fs.readFileSync(TASKS_FILE, "utf8");
    assert.match(saved, /"command": "node build.cjs"/, saved);
    assert.ok(!saved.includes("--wrong"), `the build that failed its trial was saved: ${saved}`);

    // Asked twice: the reading, and the second look with the failure in it.
    await browser.waitUntil(() => callsOf("tasks").length >= 2, { timeout: 30_000 });
    const [, second] = callsOf("tasks");
    assert.ok(
      second.prompt.includes("build.cjs: unknown option --wrong"),
      "the trial's output was not handed back",
    );
  });
});
