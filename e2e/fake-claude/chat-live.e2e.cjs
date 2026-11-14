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
const { reloadOnWelcome } = require("../support/welcome.cjs");

const MODE_FILE = path.join(fakeClaudeState, "mode.txt");
const CALLS_FILE = path.join(fakeClaudeState, "calls.jsonl");
const STEERED_FILE = path.join(fakeClaudeState, "steered.jsonl");
const WITHDRAWN_FILE = path.join(fakeClaudeState, "withdrawn.jsonl");
const QUEUED = "and the tests too";
/** Two messages written one after the other while the AI works. */
const SECOND = "check the docs as well";
const THIRD = "then summarise";
/** Written by mistake, and taken back before the AI read it. */
const MISTYPED = "delete the whole repo";
const TAKE_BACK = "Take this message back";
const EDIT_QUEUED = "Edit this message: it goes back to the box below, to be sent again";
/** Written into the queue with a typo, taken back to the composer and corrected. */
const TYPO = "run the unti tests";
const CORRECTION = " - I mean unit tests";
const SESSION_NAME = "Queue and steering checks";
/** Written while the AI is busy, and sent at once rather than after the work in flight. */
const URGENT = "stop that and look at the login page";
const SEND_NOW = "Send now: stop what the AI is doing and send the queue as the next turn";
const SIGNED_OUT_FILE = path.join(fakeClaudeState, "signed-out");
/** What the AI is told once the job it left running has ended. */
const LEFT_RUNNING_ENDED = "The processes you left running when your last turn ended have all finished";
const STOP_FOLLOWING = "Stop following - the processes keep running";
/** The `detached` scenario's job runs this long; a turn it caused would have started by then. */
const DETACHED_JOB_OUTLIVED_MS = 10_000;

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
      leftRunning: document.querySelector("[data-left-running]")?.textContent ?? null,
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
    await reloadOnWelcome();
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

  it("hands several messages written during a turn over one at a time, each read once and in order", async () => {
    // Handed over together, the CLI echoes the second with the first's text
    // joined to it: matched by text it would stay queued, its x would do
    // nothing, and it would be sent again after the turn.
    playNext("live");
    const before = calls().length;
    const taken = steered().length;
    await type("first question");
    await until((p) => p.activity !== null, "the turn never started");
    await type(SECOND);
    await type(THIRD);

    const waiting = await until(
      (p) => p.queued.length === 2,
      "the two messages written during the turn are not both shown",
    );
    assert.deepEqual(
      waiting.queuedStates,
      ["handed", "waiting"],
      "the second message went to the CLI before the AI read the first",
    );

    const read = await until(
      (p) => p.queued.length === 0 && p.userBubbles.some((bubble) => bubble.includes(THIRD)),
      "the messages written during the turn never all joined the conversation",
    );
    assert.ok(read.running, "the turn had ended before the messages were taken up");
    const order = [SECOND, THIRD].map((text) =>
      read.userBubbles.findIndex((bubble) => bubble.includes(text)),
    );
    assert.ok(order[0] !== -1 && order[0] < order[1], `the conversation shows them out of order: ${order}`);
    assert.deepEqual(
      steered()
        .slice(taken)
        .map((entry) => entry.text.split("\n\n").at(-1)),
      [SECOND, THIRD],
      "the CLI did not get the messages one by one, in the order written",
    );

    await settle();
    const after = await panel();
    assert.deepEqual(after.queued, [], "a message outlived the turn in the queue");
    for (const text of [SECOND, THIRD]) {
      const shown = after.userBubbles.filter((bubble) => bubble.includes(text)).length;
      assert.equal(shown, 1, `"${text}" is in the conversation ${String(shown)} times`);
    }
    await browser.pause(1_000);
    assert.equal(calls().length, before + 1, "a message read during the turn was sent again after it");
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

  it("takes a handed message back into the composer to be corrected, and hands the correction over", async () => {
    playNext("slow");
    const taken = steered().length;
    await type("wait a while");
    await until((p) => p.activity !== null, "the turn never started");
    await type(TYPO);
    await until(
      (p) => p.queuedStates[0] === "handed",
      "the message written during the turn was not handed over",
    );

    await (await $(`div.border-dashed button[title="${EDIT_QUEUED}"]`)).click();
    const reclaimed = await until(
      (p) => p.queued.length === 0 && p.composer === TYPO,
      "the queued message did not come back to the composer",
    );
    assert.ok(reclaimed.running, "the turn had ended before the message was taken back");
    assert.ok(
      withdrawn().some((entry) => entry.text.includes(TYPO)),
      "the CLI was never asked to take the message back",
    );

    // The caret goes to the end of what came back, and the correction follows it.
    await browser.execute(() => {
      const box = document.querySelector("textarea[placeholder]");
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    await browser.keys([...CORRECTION.split(""), "Enter"]);
    await until(
      () =>
        steered()
          .slice(taken)
          .some((entry) => entry.text.includes(TYPO + CORRECTION)),
      "the corrected message never reached the AI",
    );
    await settle();
    const after = await panel();
    assert.ok(
      after.userBubbles.some((bubble) => bubble.includes(TYPO + CORRECTION)),
      "the corrected message is not in the conversation",
    );
    assert.ok(
      !after.userBubbles.some((bubble) => bubble.trim().endsWith(TYPO)),
      "the message as first written joined the conversation",
    );
  });

  it("sends a queued message at once by stopping the work in flight, as the next turn of the session", async () => {
    playNext("slow");
    const before = calls().length;
    const waitedOut = (p) => p.answers.filter((answer) => answer.includes("Done waiting.")).length;
    const waitedBefore = waitedOut(await panel());
    await type("wait a while");
    await until((p) => p.activity !== null, "the turn never started");
    await type(URGENT);
    await until((p) => p.queuedStates[0] === "handed", "the message was not handed over");
    // The turn that follows plays a quick answer; the slow command never finishes.
    playNext("live");

    await (await $(`div.border-dashed button[title="${SEND_NOW}"]`)).click();
    await until(
      () => calls().length === before + 2,
      "the queued message never went out as a turn of its own",
    );
    const [, next] = calls().slice(before);
    assert.ok(next.prompt.includes(URGENT), `the next turn did not carry the queued message: ${next.prompt}`);
    const resumed = next.args[next.args.indexOf("--resume") + 1];
    assert.equal(resumed, "fake-session-1", "the next turn left the conversation it was written in");
    await settle();
    const after = await panel();
    assert.deepEqual(after.queued, [], "the message stayed in the queue");
    assert.ok(
      after.userBubbles.some((bubble) => bubble.includes(URGENT)),
      "the message is not in the conversation",
    );
    assert.equal(waitedOut(after), waitedBefore, "the stopped command ran to its end");
  });

  it("follows a job the AI left running when its turn ended, and tells the AI once it ends", async () => {
    playNext("detached");
    const before = calls().length;
    await type("run the tests in the background");
    const following = await until((p) => p.leftRunning !== null, "nothing was followed after the turn ended");
    assert.match(following.leftRunning, /node/i, "the line does not name the job that runs on");
    assert.equal(following.running, false, "the turn had not ended while its job was followed");
    playNext("resume");

    await until(() => calls().length === before + 2, "the AI was never told that the job ended");
    const [, told] = calls().slice(before);
    assert.ok(told.prompt.includes(LEFT_RUNNING_ENDED), `the next turn did not say the job ended: ${told.prompt}`);
    const resumed = told.args[told.args.indexOf("--resume") + 1];
    assert.equal(resumed, "fake-session-1", "the news went to another conversation");
    await settle();
    assert.equal((await panel()).leftRunning, null, "the line stayed after the job ended");
  });

  it("stops following when asked: the job runs on and the AI is not told", async () => {
    playNext("detached");
    const before = calls().length;
    await type("run them once more");
    await until((p) => p.leftRunning !== null, "nothing was followed after the turn ended");
    await (await $(`button[title="${STOP_FOLLOWING}"]`)).click();
    await until((p) => p.leftRunning === null, "the line stayed after following stopped");

    // Proving that no turn starts takes waiting out the job it would follow.
    await browser.pause(DETACHED_JOB_OUTLIVED_MS);
    assert.equal(calls().length, before + 1, "the AI was told about a job no longer followed");
  });

  it("names a session from the list of previous sessions, and keeps the name", async () => {
    const openHistory = async () => {
      await (await $('button[title="Previous sessions"]')).click();
      await $('[role="menu"][aria-label="Previous sessions"]').waitForDisplayed({ timeout: 5_000 });
    };
    const rows = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[role="menu"][aria-label="Previous sessions"] [role="menuitem"]')].map(
          (row) => row.textContent ?? "",
        ),
      );

    await openHistory();
    const live = await $('[role="menu"][aria-label="Previous sessions"] button[aria-label="Rename session"]');
    // The pencil only shows on hover; it is still the first row's button.
    await live.click();
    const box = await $('[role="menu"] input[aria-label="Rename session"]');
    await box.waitForDisplayed({ timeout: 5_000 });
    await browser.keys([...SESSION_NAME.split(""), "Enter"]);
    await browser.waitUntil(async () => (await rows()).some((row) => row.includes(SESSION_NAME)), {
      timeout: 5_000,
      timeoutMsg: "the list does not show the new name",
    });
    await browser.keys(["Escape"]);
    await $('[role="menu"][aria-label="Previous sessions"]').waitForDisplayed({
      reverse: true,
      timeout: 5_000,
    });

    await openHistory();
    assert.ok((await rows())[0].includes(SESSION_NAME), "the name was gone when the list was opened again");
    await browser.keys(["Escape"]);
    const saved = fs
      .readdirSync(process.env.APPDATA ?? "")
      .filter((name) => name.startsWith("io.github.aime-mini.editor"))
      .flatMap((name) => {
        const folder = path.join(process.env.APPDATA ?? "", name, "sessions");
        return fs.existsSync(folder) ? fs.readdirSync(folder).map((file) => path.join(folder, file)) : [];
      })
      .filter((file) => path.basename(file).startsWith(path.basename(workspace).toLowerCase()))
      .map((file) => fs.readFileSync(file, "utf8"));
    assert.ok(
      saved.some((text) => JSON.parse(text).sessions.some((session) => session.name === SESSION_NAME)),
      "the name never reached the project's session file",
    );
  });

  it("attaches a pasted screenshot as a file in the project, mentioned in the composer", async () => {
    // The smallest valid PNG: one transparent pixel.
    const png = [
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31,
      21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0,
      0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    await browser.execute((bytes) => {
      const box = document.querySelector("textarea[placeholder]");
      box.focus();
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
      box.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, png);
    const pasted = await until(
      (p) => /@\S*pasted-\d+-\d+\.png /.test(p.composer ?? ""),
      "the pasted picture was not mentioned in the composer",
    );
    const mentioned = /@(\S*pasted-\d+-\d+\.png) /.exec(pasted.composer)[1];
    assert.ok(
      path.resolve(mentioned).startsWith(path.join(path.resolve(workspace), ".aime", "pasted")),
      `the picture was saved outside the project's .aime folder: ${mentioned}`,
    );
    assert.deepEqual([...fs.readFileSync(mentioned)], png, "the saved file is not the pasted picture");
    await browser.execute(() => {
      const box = document.querySelector("textarea[placeholder]");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  it("shows why the composer is disabled where the user is typing, however long the conversation", async () => {
    fs.writeFileSync(SIGNED_OUT_FILE, "");
    try {
      // The panel re-checks the CLI when the window gets focus back.
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        () => browser.execute(() => document.querySelector("textarea[placeholder]")?.disabled === true),
        { timeout: 15_000, timeoutMsg: "signing out did not disable the composer" },
      );
      const notice = await browser.execute(() => {
        const sign = [...document.querySelectorAll("button")].find(
          (b) => (b.textContent ?? "").trim() === "Sign in",
        );
        if (!sign) return null;
        const box = sign.getBoundingClientRect();
        return {
          inLog: sign.closest('[role="log"]') !== null,
          visible: box.top >= 0 && box.bottom <= window.innerHeight && box.height > 0,
        };
      });
      assert.ok(notice, "no Sign in button was shown while the composer was disabled");
      assert.equal(notice.inLog, false, "the notice scrolls away with the conversation");
      assert.equal(notice.visible, true, "the notice is out of sight");
    } finally {
      fs.rmSync(SIGNED_OUT_FILE, { force: true });
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        () => browser.execute(() => document.querySelector("textarea[placeholder]")?.disabled === false),
        { timeout: 15_000, timeoutMsg: "signing back in did not enable the composer again" },
      );
    }
  });
});
