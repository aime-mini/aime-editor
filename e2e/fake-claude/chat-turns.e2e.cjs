/**
 * How the chat panel shows a turn that is more than one answer, and a turn that
 * did not finish - the two things reported on 2026-09-29: forty commands of a
 * background review agent listed as chips of the main answer until the panel
 * looked frozen, and a turn the connection broke that only an app restart got
 * out of.
 *
 * The CLI is the stand-in `claude` of `fixtures/fake-claude`, replaying line
 * shapes captured from the real one, so nothing here spends a penny and the
 * failures happen on cue. Run with `npm run test:e2e:fake-claude`.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { workspace, fakeClaudeState } = require("../wdio.fake-claude.cjs");

const MODE_FILE = path.join(fakeClaudeState, "mode.txt");
const CALLS_FILE = path.join(fakeClaudeState, "calls.jsonl");
const CONTINUE = "Continue";

const playNext = (scenario) => fs.writeFileSync(MODE_FILE, scenario);
const lastCall = () => JSON.parse(fs.readFileSync(CALLS_FILE, "utf8").trim().split("\n").at(-1));

/** Monaco keeps a hidden textarea of its own; the composer is the one with a placeholder. */
const composer = () => $("textarea[placeholder]");

async function send(prompt) {
  const box = await composer();
  await box.click();
  await browser.keys(prompt.split(""));
  await browser.keys(["Enter"]);
}

/**
 * Everything the assertions look at, read in one round trip and anchored on the
 * elements that carry it: the last answer's row, its chips and toggles, the
 * status box, the error box, and the Stop button by its title.
 */
function panel() {
  return browser.execute((continueLabel) => {
    const answer = [...document.querySelectorAll("div.flex-col.items-start")].at(-1) ?? null;
    const textOf = (element) => element.textContent ?? "";
    return {
      chips: [...(answer?.querySelectorAll("span.rounded-md.font-mono") ?? [])].map((chip) => ({
        text: textOf(chip),
        spinning: chip.querySelector(".animate-spin") !== null,
      })),
      toggles: [...(answer?.querySelectorAll("button[aria-expanded]") ?? [])].map((toggle) =>
        textOf(toggle).trim(),
      ),
      steps: [...(answer?.querySelectorAll("li") ?? [])].map(textOf),
      answerText: answer ? textOf(answer) : "",
      footer: answer ? (textOf(answer).match(/\$\d+\.\d{4}/)?.[0] ?? null) : null,
      background: [...document.querySelectorAll('[role="status"]')].map(textOf),
      errors: [...document.querySelectorAll("div.text-danger")].map(textOf),
      continueButtons: [...document.querySelectorAll("button")].filter(
        (b) => textOf(b).trim() === continueLabel,
      ).length,
      running: document.querySelector('button[title="Stop"]') !== null,
      cutOff: (document.body.textContent ?? "").includes("This turn was cut off"),
    };
  }, CONTINUE);
}

async function until(predicate, message) {
  let seen = null;
  await browser
    .waitUntil(
      async () => {
        seen = await panel();
        return predicate(seen);
      },
      { timeout: 40_000, interval: 150 },
    )
    .catch(() => {
      assert.fail(`${message} - the panel showed ${JSON.stringify(seen)}`);
    });
  return seen;
}

/** Clicks a fold toggle of the last answer, found by its words. */
async function unfold(label) {
  const found = await browser.execute((words) => {
    const answer = [...document.querySelectorAll("div.flex-col.items-start")].at(-1);
    const toggle = [...(answer?.querySelectorAll("button[aria-expanded]") ?? [])].find((candidate) =>
      (candidate.textContent ?? "").includes(words),
    );
    toggle?.click();
    return toggle !== undefined;
  }, label);
  assert.ok(found, `the answer has no "${label}" toggle to open`);
}

async function clickContinue() {
  await (await $(`button=${CONTINUE}`)).click();
}

async function openWorkspace() {
  await browser.waitUntil(async () => (await $("body").getText()).includes("RECENT"), {
    timeout: 30_000,
    timeoutMsg: "the welcome screen never rendered",
  });
  await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
  await browser.waitUntil(async () => (await $("body").getText()).includes("hello.ts"), {
    timeout: 30_000,
    timeoutMsg: "the workspace never opened",
  });
}

describe("A chat turn that is more than one answer, or did not finish", () => {
  let savedProvider = null;

  before(async () => {
    // The panel reads its CLI out of localStorage before React renders, so the
    // pick goes in before the reload - and back afterwards, since this profile
    // is the one the app itself uses.
    savedProvider = await browser.execute((folder) => {
      const before = localStorage.getItem("aime.provider");
      localStorage.setItem("aime.provider", "claude");
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
      return before;
    }, workspace);
    await browser.refresh();
    await openWorkspace();
  });

  after(async () => {
    await browser.execute((before) => {
      if (before === null) localStorage.removeItem("aime.provider");
      else localStorage.setItem("aime.provider", before);
    }, savedProvider);
  });

  it("names the work left in the background and keeps a subagent's steps under its call", async () => {
    playNext("agent");
    await send("review it");
    const working = await until(
      (p) => p.background.length === 1 && p.steps.length === 1,
      "the background agent was never shown at work",
    );
    assert.ok(
      working.background[0].includes("Independent review of the diff"),
      "the background task is not named",
    );
    assert.equal(working.chips.length, 1, "the subagent's commands came out as chips of the main answer");
    assert.ok(working.chips[0].text.startsWith("Agent"), "the one chip is not the Agent call");
    assert.ok(working.chips[0].spinning, "the Agent chip does not say it is still working");
    assert.ok(working.running, "Stop is not offered while the background work runs");

    const done = await until((p) => !p.running && p.footer !== null, "the turn never ended");
    assert.equal(done.background.length, 0, "the background box outlived the turn");
    assert.ok(
      done.toggles.some((toggle) => toggle.includes("12 steps")),
      `the steps were counted as ${done.toggles}`,
    );
    // Two answers reported 0.4 and then 0.5 as the session's total: the turn cost 0.5, not 0.9.
    assert.equal(done.footer, "$0.5000", "the turn was not priced from the session's running total");

    await unfold("12 steps");
    const opened = await panel();
    assert.equal(opened.steps.length, 12, "opening the Agent call did not list its steps");
    assert.ok(opened.steps[11].includes('grep -n "step12"'), "the steps are out of order");
  });

  it("folds a run of commands into one line that opens on a click", async () => {
    playNext("tools");
    await send("check the files");
    const done = await until(
      (p) => !p.running && p.answerText.includes("Checked every file."),
      "the investigation never ended",
    );
    const header = done.toggles.find((toggle) => toggle.includes("14 steps"));
    assert.ok(header, `no folded line for the 14 commands: ${done.toggles}`);
    assert.ok(header.includes("Bash 12") && header.includes("Read 2"), `the folded line reads "${header}"`);
    assert.equal(done.chips.length, 1, "folded, only the last command should be in view");
    assert.equal(done.footer, "$0.1000", "this turn took the total from 0.5 to 0.6");

    await unfold("14 steps");
    assert.equal((await panel()).chips.length, 14, "opening the line did not show every command");
  });

  it("says it is retrying, then gives the CLI's reason and continues the same conversation", async () => {
    playNext("network");
    await send("try it");
    const retrying = await until(
      (p) => /retrying \(\d+\/10\)/.test(p.answerText),
      "the retries were never shown",
    );
    assert.ok(
      !retrying.answerText.includes("Thinking"),
      "the bubble claims to be thinking while it cannot connect",
    );

    const failed = await until((p) => !p.running && p.continueButtons === 1, "nothing offered to continue");
    assert.ok(
      failed.errors.some((error) => error.includes("Connection refused")),
      `the CLI's reason is not on screen: ${failed.errors}`,
    );
    assert.ok(
      !failed.errors.some((error) => error.includes("exited with code")),
      "a bare exit code hid the reason",
    );

    playNext("resume");
    await clickContinue();
    const resumed = await until(
      (p) => !p.running && p.answerText.includes("Picked up where it stopped."),
      "Continue did not resume the conversation",
    );
    const call = lastCall();
    assert.equal(
      call.args[call.args.indexOf("--resume") + 1],
      "fake-session-1",
      "Continue resumed another session",
    );
    assert.ok(call.prompt.includes("Continue where you left off"), `Continue sent "${call.prompt}"`);
    assert.equal(resumed.continueButtons, 0, "Continue outstayed the turn that answered it");
    assert.equal(resumed.errors.length, 0, "the old error outstayed the turn that recovered");
  });

  it("hands a conversation what the project remembers once, and again when it changes or the CLI compacts", async () => {
    const memoryDir = path.join(workspace, ".aime", "memory");
    const remember = (name, kind, summary) =>
      fs.writeFileSync(
        path.join(memoryDir, `${name}.md`),
        [
          "---",
          `name: ${name}`,
          `kind: ${kind}`,
          "scope: .",
          `summary: ${summary}`,
          "files: ",
          "updated: 2026-10-01",
          "---",
          "",
        ].join("\n"),
      );
    const turn = async (prompt) => {
      await send(prompt);
      await browser.waitUntil(() => lastCall().prompt.includes(prompt), {
        timeoutMsg: `"${prompt}" never reached the CLI`,
      });
      const done = await until((p) => !p.running, `"${prompt}" never ended`);
      return { prompt: lastCall().prompt, done };
    };
    const handed = (prompt) => /<aime_memory>[\s\S]*<\/aime_memory>/.test(prompt);

    fs.mkdirSync(memoryDir, { recursive: true });
    remember("prices-are-integer-cents", "decision", "Prices are integer cents, never floats");
    // How an AI deletes a memory: it empties the file, and Aime removes it.
    const emptied = path.join(memoryDir, "prices-are-float-dollars.md");
    fs.writeFileSync(emptied, "");
    try {
      playNext("resume");
      const first = await turn("change how prices are rounded");
      assert.match(first.prompt, /<aime_memory>[\s\S]*Prices are integer cents, never floats/, first.prompt);
      assert.ok(
        !first.done.answerText.includes("memor"),
        `the memory was put on screen: ${first.done.answerText}`,
      );
      assert.ok(!fs.existsSync(emptied), "an emptied memory was left behind");

      // The same session already holds the index: handing it over again would
      // only pile copies into the history.
      const second = await turn("and the shipping fee");
      assert.ok(!handed(second.prompt), `the index was handed over twice:\n${second.prompt}`);

      remember("shipping-is-flat", "decision", "Shipping is a flat fee per order");
      const third = await turn("apply it to the invoice");
      assert.match(third.prompt, /<aime_memory>[\s\S]*Shipping is a flat fee per order/, third.prompt);

      // Compacted by the CLI: what it kept of the index is its summary's guess.
      playNext("compact");
      const compacted = await turn("summarise the cart module");
      assert.ok(!handed(compacted.prompt), "nothing had changed before the compaction");
      playNext("resume");
      const after = await turn("now the refund path");
      assert.ok(
        handed(after.prompt),
        `the index was not handed over again after compaction:\n${after.prompt}`,
      );
    } finally {
      // The files go, the folder stays: a missing folder is what the mirror in
      // app data restores (`memory_mirror.rs`), an emptied one is a decision.
      for (const name of fs.readdirSync(memoryDir)) fs.rmSync(path.join(memoryDir, name), { force: true });
    }
  });

  it("offers to continue a turn the app was closed in the middle of", async () => {
    playNext("agent");
    await send("review it again");
    await until((p) => p.background.length === 1, "the long turn never started");
    // The frontend going away mid-turn is what closing the app does to it.
    await browser.refresh();
    await openWorkspace();
    await until((p) => p.cutOff && p.continueButtons === 1, "the cut-off turn was not offered back");

    playNext("resume");
    await clickContinue();
    await until(
      (p) => !p.running && p.answerText.includes("Picked up where it stopped."),
      "continuing failed",
    );
    assert.ok(lastCall().args.includes("--resume"), "the cut-off turn was started over instead of resumed");
  });
});
