/**
 * The chat panel while the AI is at work - four regressions it guards against:
 * the transcript pulled the reader back down while they scrolled
 * up to read, nothing could be written until the turn ended, a running command
 * showed no sign of life, and the answer "froze" for as long as the AI wrote a
 * file (the file's content streams as the call's input, and none of it was shown).
 *
 * The CLI is the stand-in `claude` of `fixtures/fake-claude` playing `live`, a
 * turn in the line shapes of Claude Code 2.1.302. Run with
 * `npm run test:e2e:fake-claude -- --spec e2e/fake-claude/chat-live.e2e.cjs`.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { workspace, fakeClaudeState } = require("../wdio.fake-claude.cjs");

const MODE_FILE = path.join(fakeClaudeState, "mode.txt");
const CALLS_FILE = path.join(fakeClaudeState, "calls.jsonl");
const STEERED_FILE = path.join(fakeClaudeState, "steered.jsonl");
const WITHDRAWN_FILE = path.join(fakeClaudeState, "withdrawn.jsonl");
const QUEUED = "and the tests too";
/** Written by mistake, and taken back before the AI read it. */
const MISTYPED = "delete the whole repo";
const TAKE_BACK = "Take this message back";

const playNext = (scenario) => fs.writeFileSync(MODE_FILE, scenario);
const lines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
/** One entry per CLI process started. */
const calls = () => lines(CALLS_FILE);
/** Each message the CLI took up during a turn, in order. */
const steered = () => lines(STEERED_FILE);
/** Each handed message the CLI took back before the AI read it. */
const withdrawn = () => lines(WITHDRAWN_FILE);

/** Monaco keeps a hidden textarea of its own; the composer is the one with a placeholder. */
const composer = () => $("textarea[placeholder]");

async function type(text) {
  const box = await composer();
  await box.click();
  await browser.keys(text.split(""));
  await browser.keys(["Enter"]);
}

/**
 * Everything the assertions look at, in one round trip: the activity line, the
 * transcript's scroll position, the queued bubbles, the composer, the chips of
 * the last answer and the Latest button - each found by the element that carries it.
 */
function panel() {
  return browser.execute(() => {
    const answer = [...document.querySelectorAll("div.flex-col.items-start")].at(-1) ?? null;
    const scroller = document.querySelector('[role="log"]');
    const activity = document.querySelector("[data-activity]");
    const textOf = (element) => element.textContent ?? "";
    return {
      activity: activity ? { kind: activity.getAttribute("data-activity"), text: textOf(activity) } : null,
      scroll: scroller
        ? { top: scroller.scrollTop, height: scroller.scrollHeight, view: scroller.clientHeight }
        : null,
      queued: [...document.querySelectorAll("div.border-dashed")].map(textOf),
      queuedStates: [...document.querySelectorAll("[data-queued]")].map((e) => e.getAttribute("data-queued")),
      takeBack: document.querySelectorAll('div.border-dashed button[title="Take this message back"]').length,
      userBubbles: [...document.querySelectorAll("div.flex-col.items-end")].map(textOf),
      composer: document.querySelector("textarea[placeholder]")?.value ?? null,
      chips: [...(answer?.querySelectorAll("span.rounded-md.font-mono") ?? [])].map((chip) => ({
        text: textOf(chip),
        spinning: chip.querySelector(".animate-spin") !== null,
      })),
      latest: [...document.querySelectorAll("button")].some((b) => textOf(b).trim() === "Latest"),
      running: document.querySelector('button[title="Stop"]') !== null,
      background: [...document.querySelectorAll('[role="status"]')].map(textOf),
      answers: [...document.querySelectorAll("div.flex-col.items-start")].map(textOf),
    };
  });
}

async function until(predicate, message, timeout = 40_000) {
  let seen = null;
  await browser
    .waitUntil(
      async () => {
        seen = await panel();
        return predicate(seen);
      },
      { timeout, interval: 100 },
    )
    .catch(() => {
      assert.fail(`${message} - the panel showed ${JSON.stringify(seen)}`);
    });
  return seen;
}

const fromEnd = (scroll) => scroll.height - scroll.top - scroll.view;

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

/** Lets the turn in flight end, so the next test starts on a quiet panel. */
async function settle() {
  await until((p) => !p.running, "the turn never ended", 60_000);
}

describe("The chat panel while the AI is at work", () => {
  let savedProvider = null;

  before(async () => {
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

  it("shows the message the moment Enter is pressed", async () => {
    playNext("live");
    const box = await composer();
    await box.click();
    await browser.keys("show me".split(""));
    // Timed inside the page: from the key going down to the bubble being in the DOM.
    await browser.execute(() => {
      window.__enterToBubble = null;
      const box = document.querySelector("textarea[placeholder]");
      box.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Enter") return;
          const pressed = performance.now();
          const seen = new MutationObserver(() => {
            const bubbles = [...document.querySelectorAll("div.flex-col.items-end")];
            if (!bubbles.some((b) => (b.textContent ?? "").includes("show me"))) return;
            window.__enterToBubble = performance.now() - pressed;
            seen.disconnect();
          });
          seen.observe(document.body, { childList: true, subtree: true });
        },
        { capture: true, once: true },
      );
    });
    await browser.keys(["Enter"]);
    await browser.waitUntil(() => browser.execute(() => window.__enterToBubble !== null), {
      timeout: 5_000,
      timeoutMsg: "the message never appeared",
    });
    const elapsed = await browser.execute(() => window.__enterToBubble);
    assert.ok(elapsed < 100, `the message took ${String(Math.round(elapsed))} ms to appear after Enter`);
    await settle();
  });

  it("says what the AI is doing at every moment of a turn", async () => {
    playNext("live");
    await type("write the poem");

    const command = await until(
      (p) => p.activity?.text.includes("Running Bash") === true,
      "the running command was never named",
    );
    assert.ok(command.activity.text.includes("sleep 3 && echo hi"), command.activity.text);
    assert.ok(command.chips.at(-1).spinning, "the command's chip does not spin while it runs");

    await until((p) => p.activity?.kind === "thinking", "the AI reasoning was never said");

    const early = await until(
      (p) => p.activity?.text.includes("Preparing Write") === true && /\d characters/.test(p.activity.text),
      "the file being written was never shown",
    );
    // The file's name, not the start of its long path that would truncate it away.
    assert.ok(early.activity.text.includes("rivers.md"), early.activity.text);
    const count = (p) => Number(/([\d.]+)k? characters/.exec(p.activity.text)?.[1] ?? 0);
    await until(
      (p) => p.activity?.text.includes("Preparing Write") === true && count(p) > count(early),
      "the count of characters written never moved",
    );
    const writing = await panel();
    // Folded away under the run's toggle once it is over; shown only while it runs.
    const bash = writing.chips.find((chip) => chip.text.includes("Bash"));
    assert.ok(bash === undefined || !bash.spinning, "the command still spins after it came back");
    assert.ok(writing.chips.at(-1).spinning, "the file being written has no spinning chip");

    await until((p) => p.activity?.kind === "writing", "the answer being written was never said");
    await settle();
    assert.equal((await panel()).activity, null, "the activity line outlived the turn");
  });

  it("leaves the reader where they scrolled to, and takes them back on request", async () => {
    playNext("live");
    await type("one more time");
    const streaming = await until(
      (p) => p.activity?.kind === "writing" && p.scroll !== null && p.scroll.height > p.scroll.view * 2,
      "the answer never grew past the panel",
    );
    assert.ok(
      fromEnd(streaming.scroll) < 40,
      `not following the answer: ${JSON.stringify(streaming.scroll)}`,
    );

    // A real wheel, the way a reader scrolls up.
    const scroller = await $('[role="log"]');
    await browser.action("wheel").scroll({ origin: scroller, deltaY: -900, duration: 150 }).perform();
    const reading = await until((p) => p.latest, "scrolling up offered no way back to the end");
    await browser.pause(1_500); // the answer keeps arriving underneath
    const later = await panel();
    assert.ok(later.scroll.height > reading.scroll.height, "the answer stopped growing - nothing was tested");
    assert.ok(
      Math.abs(later.scroll.top - reading.scroll.top) < 5,
      `the reader was moved from ${String(reading.scroll.top)} to ${String(later.scroll.top)}`,
    );

    await (await $("button=Latest")).click();
    await browser.pause(800);
    const back = await panel();
    assert.ok(back.activity?.kind === "writing", "the answer ended before following could be checked");
    assert.ok(
      fromEnd(back.scroll) < 40,
      `Latest did not follow the answer again: ${JSON.stringify(back.scroll)}`,
    );
    assert.ok(!back.latest, "Latest is still offered at the end");
    await settle();
  });

  it("hands a message written during a turn to the AI, which takes it up at its next step", async () => {
    playNext("live");
    const before = calls().length;
    const taken = steered().length;
    await type("first question");
    await until((p) => p.activity !== null, "the turn never started");
    await type(QUEUED);

    // Handed over at once: dashed, labelled so, and - until the AI reads it -
    // with an x to take it back.
    const handed = await until(
      (p) => p.queued.length === 1 && p.queuedStates[0] === "handed",
      "the message written during the turn is not shown as handed over",
    );
    assert.ok(handed.queued[0].includes(QUEUED), handed.queued[0]);
    assert.equal(handed.takeBack, 1, "a message the AI has not read yet offers no way to take it back");

    // Taken up where the real CLI takes it: after the command in flight,
    // inside the same turn - it joins the conversation while the turn runs.
    const read = await until(
      (p) => p.queued.length === 0 && p.userBubbles.some((bubble) => bubble.includes(QUEUED)),
      "the AI never took up the message during the turn",
    );
    assert.ok(read.running, "the turn had ended before the message was taken up");
    assert.equal(steered().length, taken + 1, "the CLI did not get the message on its stdin");
    assert.ok(steered().at(-1).text.includes(QUEUED), steered().at(-1).text);
    assert.equal(calls().length, before + 1, "the message started a process of its own");

    await settle();
    assert.equal(calls().length, before + 1, "the message was sent again after the turn");
    const after = await panel();
    assert.deepEqual(after.queued, [], "the bubble outlived the turn");
  });

  it("answers a message written after the answer while a server it started keeps running", async () => {
    playNext("server");
    const before = calls().length;
    await type("run the site");
    const serving = await until(
      (p) =>
        p.background.length === 1 && p.answers.some((answer) => answer.includes("The server is running.")),
      "the answer and the server left running were never shown",
    );
    assert.ok(serving.running, "the turn ended although its server still runs");
    assert.ok(
      serving.background[0].includes("Keep writing meanwhile"),
      `the box does not say the chat goes on: ${serving.background[0]}`,
    );

    // The regression: this message sat in the queue for as long as the server ran.
    await type("is it up?");
    const answered = await until(
      (p) =>
        p.queued.length === 0 &&
        p.userBubbles.some((bubble) => bubble.includes("is it up?")) &&
        p.answers.some((answer) => answer.includes("Yes, it answers on port 5173.")),
      "the message written after the answer was never answered",
    );
    assert.ok(answered.running, "the server's turn ended when the message was answered");
    assert.equal(answered.background.length, 1, "the server stopped being shown while it still runs");
    assert.equal(calls().length, before + 1, "the message started a process of its own");

    await (await $('button[title="Stop"]')).click();
    const stopped = await until((p) => !p.running, "Stop did not end the turn the server kept going");
    assert.deepEqual(stopped.background, [], "the server's box outlived Stop");
  });

  it("takes back a handed message the AI has not read yet, and the AI never sees it", async () => {
    playNext("slow");
    const before = calls().length;
    const taken = steered().length;
    await type("wait a while");
    await until((p) => p.activity !== null, "the turn never started");
    await type(MISTYPED);
    await until(
      (p) => p.queuedStates[0] === "handed",
      "the message written during the turn was not handed over",
    );

    await (await $(`div.border-dashed button[title="${TAKE_BACK}"]`)).click();
    const gone = await until((p) => p.queued.length === 0, "the message stayed queued after its x");
    assert.ok(gone.running, "the turn had ended before the message was taken back");
    assert.ok(
      withdrawn().some((entry) => entry.text.includes(MISTYPED)),
      "the CLI was never asked to take the message back",
    );

    await settle();
    const after = await panel();
    assert.ok(
      !after.userBubbles.some((bubble) => bubble.includes(MISTYPED)),
      "the message taken back joined the conversation",
    );
    assert.equal(steered().length, taken, "the AI read the message it was told to forget");
    await browser.pause(1_000);
    assert.equal(calls().length, before + 1, "the message taken back was sent again as a turn of its own");
  });

  it("hands a message back to the composer when the turn is stopped before the AI took it up", async () => {
    playNext("live");
    const before = calls().length;
    await type("stop me");
    await until((p) => p.activity !== null, "the turn never started");
    await type(QUEUED);
    await until((p) => p.queued.length === 1, "the message written during the turn is not shown");

    await (await $('button[title="Stop"]')).click();
    const stopped = await until((p) => !p.running, "Stop did not end the turn");
    assert.deepEqual(stopped.queued, [], "the queue outlived the stop");
    assert.equal(stopped.composer, QUEUED, "the queued words did not come back to the composer");
    await browser.pause(1_000);
    assert.equal(calls().length, before + 1, "a stopped turn still sent what was queued");
  });
});
