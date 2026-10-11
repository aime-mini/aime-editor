/**
 * A project is learned in the background: the whole first, then each part the
 * AI named, each a read-only turn whose answer Aime writes as memories - and
 * once learned, only a part whose code changed is read again.
 *
 * The suite turns background turns off (`AIME_NO_BACKGROUND_TURNS`, since the
 * main suite drives the real CLI), so this drives the learning itself, the way
 * opening a project starts it. Run with `npm run test:e2e:fake-claude`.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { workspace, fakeClaudeState } = require("../wdio.fake-claude.cjs");

const CALLS_FILE = path.join(fakeClaudeState, "calls.jsonl");
const MEMORY_DIR = path.join(workspace, ".aime", "memory");
const STATE_FILE = path.join(workspace, ".aime", "learning.json");
const LIB = path.join(workspace, "lib");
const ROUTER = path.join(LIB, "router.js");
/** What the stand-in answers, one memory per study (`fixtures/fake-claude`). */
const LEARNED = ["project-overview.md", "lib-router.md", "api-package.md"];

/** The studies the stand-in was asked for - not the reading of the project's tasks that opening it also starts. */
const learnCalls = () =>
  fs.existsSync(CALLS_FILE)
    ? fs
        .readFileSync(CALLS_FILE, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (call) => call.mode === "learn" && call.prompt.includes("You are reading this project for Aime"),
        )
    : [];

/** Runs the learning the way opening the project starts it, and waits for it to end. */
const learn = () =>
  browser.execute(async (root) => {
    const { learnProject } = await import("/src/lib/projectLearner.ts");
    await learnProject(root);
  }, workspace);

const studied = (call) =>
  call.prompt.includes("Study the project as a whole")
    ? "/"
    : (/Study one part of this project: `([^`]+)`/.exec(call.prompt)?.[1] ?? "?");

describe("Aime learns a project before anyone asks", () => {
  let savedProvider = null;

  before(async () => {
    fs.mkdirSync(LIB, { recursive: true });
    fs.writeFileSync(ROUTER, "export function route(request) {\n  return request.path;\n}\n");
    fs.writeFileSync(path.join(fakeClaudeState, "mode.txt"), "learn");
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
    // Memory files one by one, never the folder: a missing folder is what the
    // mirror restores, and the next spec would find these memories back.
    for (const name of LEARNED) fs.rmSync(path.join(MEMORY_DIR, name), { force: true });
    fs.rmSync(STATE_FILE, { force: true });
    fs.rmSync(LIB, { recursive: true, force: true });
    await browser.execute((before) => {
      if (before === null) localStorage.removeItem("aime.provider");
      else localStorage.setItem("aime.provider", before);
    }, savedProvider);
  });

  it("studies the whole, then every part it named, with the read-only tools alone", async () => {
    await learn();

    assert.deepEqual(learnCalls().map(studied), ["/", "lib", "api", "api"]);
    for (const call of learnCalls()) {
      const tools = call.args[call.args.indexOf("--tools") + 1];
      assert.equal(tools, "Read,Glob,Grep", `a study could do more than read: ${call.args.join(" ")}`);
      assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "plan");
      assert.ok(!call.args.includes("--resume"), "a study joined a conversation");
    }
    assert.ok(learnCalls()[3].prompt.includes("could not be used"), "the prose answer was not asked again");

    for (const name of LEARNED) {
      const text = fs.readFileSync(path.join(MEMORY_DIR, name), "utf8");
      assert.match(text, /^kind: structure$/m, `${name}:\n${text}`);
    }
    assert.match(fs.readFileSync(path.join(MEMORY_DIR, "lib-router.md"), "utf8"), /^scope: lib$/m);
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    assert.deepEqual(state.pending, [], JSON.stringify(state));
    assert.ok(state.considered.includes("lib") && state.considered.includes("api"), JSON.stringify(state));
    assert.ok(fs.existsSync(path.join(workspace, ".aime", ".gitignore")), ".aime/ would show in git status");
  });

  it("reads nothing again while nothing changed", async () => {
    const before = learnCalls().length;
    await learn();
    assert.equal(learnCalls().length, before);
  });

  it("reads again only the part whose code changed", async () => {
    const before = learnCalls().length;
    // A second later than the memory, whatever the filesystem's resolution.
    const later = new Date(fs.statSync(path.join(MEMORY_DIR, "lib-router.md")).mtimeMs + 2_000);
    fs.utimesSync(ROUTER, later, later);

    await learn();

    assert.deepEqual(learnCalls().slice(before).map(studied), ["lib"]);
  });
});
