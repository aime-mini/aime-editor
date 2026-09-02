/**
 * What the chat panel shows while the AI is still answering.
 *
 * The complaint this exists for: a turn just appended text, so a panel that had
 * gone quiet looked the same whether the AI was thinking, working, or finished.
 * The marks that answer that only exist inside a laid-out window with a live
 * turn in it - a session planted from outside can carry the messages but never
 * `running` - so the turn here is a real one.
 *
 * Nothing here spends a penny: the "AI CLI" is a `providers.json` entry whose
 * command is node printing one JSON line at a time, with a silence between them
 * long enough to look at. The user's config is restored on the way out,
 * including the case where it did not exist.
 *
 * NOT covered here, and not an oversight: the spinner that marks the tool call
 * the AI is inside. A CLI described in `providers.json` can only declare
 * `plain` or `jsonl` as its parser (`ParserKind` in `providers/generic.rs`), and
 * both of those produce text and nothing else - a configured CLI has no way to
 * emit a tool call at all. Reaching that mark needs a built-in CLI on a real,
 * paid turn, which this suite must never require.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { workspace } = require("../wdio.conf.cjs");

const configDir = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor");
const providersFile = path.join(configDir, "providers.json");

const PROBE_SCRIPT = path.join(os.tmpdir(), "aime-chat-wait-probe.cjs");
/** Which of its two turns the fake CLI plays: "answer" (the default) or "silent". */
const MODE_FILE = path.join(os.tmpdir(), "aime-chat-wait-mode.txt");
const PROBE_ID = "chat-wait-probe";

/** The first words of the answer - the text the caret has to sit behind. */
const ANSWER = "Running the suite now";

/**
 * How long the fake CLI stays silent before each line.
 *
 * Every assertion below is a poll over WebDriver, which costs tens of
 * milliseconds a round trip, so each window has to be wide enough to be looked
 * at without racing. It also has to pass a whole second, because one of the
 * things under test is a clock counting them.
 */
const SILENCE_MS = 2600;

/**
 * The fake CLI. A file rather than `node -e …`: every argument crosses
 * `cmd /C`, which does not honour the C runtime's quoting rules.
 */
const PROBE_SOURCE =
  'const fs = require("node:fs");\n' +
  "// The prompt arrives on stdin, and reading it to EOF is also the starting gun.\n" +
  'fs.readFileSync(0, "utf8");\n' +
  "const silence = () => new Promise((resolve) => setTimeout(resolve, " +
  String(SILENCE_MS) +
  "));\n" +
  "const mode = fs.existsSync(" +
  JSON.stringify(MODE_FILE) +
  ") ? fs.readFileSync(" +
  JSON.stringify(MODE_FILE) +
  ', "utf8").trim() : "answer";\n' +
  "void (async () => {\n" +
  "  await silence(); // not a word written yet\n" +
  '  if (mode === "silent") return; // the turn that answers nothing at all\n' +
  '  process.stdout.write(JSON.stringify({ text: ' +
  JSON.stringify(ANSWER) +
  ' }) + "\\n");\n' +
  "  await silence(); // the answer is still arriving\n" +
  "})();\n";

const PROBE_PROVIDER = [
  {
    id: PROBE_ID,
    displayName: "Chat Wait Probe",
    command: "node",
    args: [PROBE_SCRIPT],
    parser: "jsonl",
    textField: "text",
    promptStdin: true,
  },
];

const backupOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const restore = (file, content) => {
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
};

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/** Monaco keeps a hidden textarea of its own; the composer is the one with a placeholder. */
const composer = () => $("textarea[placeholder]");

/**
 * Every mark the panel can be wearing, read in one round trip.
 *
 * Each one is anchored on the element that carries it rather than on the page's
 * text: the dots and the caret have classes of their own.
 *
 * The computed `animationName`s are read too, and they are the point: a class in
 * the markup proves only that the JSX asked for an effect. Whether the
 * stylesheet defines one is a different question, and a test that counted
 * elements alone would pass just as happily with nothing moving.
 */
function marks() {
  return browser.execute(() => {
    const dots = [...document.querySelectorAll(".animate-thinking")];
    // The dots sit in their own wrapper inside the line that carries the label,
    // so the label is two parents up from any one dot.
    const line = dots[0]?.parentElement?.parentElement?.textContent ?? "";
    const caret = document.querySelector(".animate-caret");
    const nameOf = (element) => (element ? getComputedStyle(element).animationName : "");
    return {
      dots: dots.length,
      thinkingLine: line,
      dotAnimations: dots.map(nameOf),
      dotDelays: dots.map((dot) => getComputedStyle(dot).animationDelay),
      carets: document.querySelectorAll(".animate-caret").length,
      caretAnimation: nameOf(caret),
      // The caret has to be behind the words, which is the last position in the
      // bubble - anywhere else and it is marking nothing.
      caretIsLast: caret !== null && caret.parentElement?.lastElementChild === caret,
      answerShown: (document.body.textContent ?? "").includes("Running the suite now"),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
}

/**
 * Whether the row carrying `prompt` is the last thing in the conversation.
 *
 * A user's row is the one aligned to the end, so it is found by that and by its
 * own words; being its parent's last child is then the only way to say "and
 * nothing came after it" - which is the whole assertion about a turn that
 * answered nothing.
 */
function lastRowIsUsers(prompt) {
  return browser.execute((words) => {
    const rows = [...document.querySelectorAll("div.items-end")].filter((row) =>
      (row.textContent ?? "").includes(words),
    );
    const row = rows.at(-1);
    if (!row) return { found: false, isLast: false, after: "" };
    const after = [...(row.parentElement?.children ?? [])]
      .slice([...(row.parentElement?.children ?? [])].indexOf(row) + 1)
      .map((element) => `${element.tagName.toLowerCase()}:${JSON.stringify(element.textContent ?? "")}`);
    return { found: true, isLast: after.length === 0, after: after.join(" | ") };
  }, prompt);
}

async function waitForMark(predicate, message) {
  let last = null;
  await browser
    .waitUntil(
      async () => {
        last = await marks();
        return predicate(last);
      },
      { timeout: 30_000, interval: 120 },
    )
    .catch(() => {
      assert.fail(`${message} — the panel was wearing ${JSON.stringify(last)}`);
    });
  return last;
}

describe("The chat panel while the AI is still answering", () => {
  const saved = { providers: null, provider: null };

  before(async () => {
    saved.providers = backupOf(providersFile);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(providersFile, JSON.stringify(PROBE_PROVIDER, null, 2));
    fs.writeFileSync(PROBE_SCRIPT, PROBE_SOURCE);

    // The panel reads its CLI out of localStorage before React renders, so the
    // pick has to be in place before the reload - and put back afterwards,
    // because this profile is the one the app itself uses.
    saved.provider = await browser.execute(
      (folder, providerId) => {
        const before = localStorage.getItem("aime.provider");
        localStorage.setItem("aime.provider", providerId);
        localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
        return before;
      },
      workspace,
      PROBE_ID,
    );
    await browser.refresh();
    await waitForText("RECENT", "the welcome screen never rendered");
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await waitForText("hello.ts", "the workspace never opened");
  });

  after(async () => {
    restore(providersFile, saved.providers);
    fs.rmSync(PROBE_SCRIPT, { force: true });
    fs.rmSync(MODE_FILE, { force: true });
    await browser.execute((before) => {
      if (before === null) localStorage.removeItem("aime.provider");
      else localStorage.setItem("aime.provider", before);
    }, saved.provider);
  });

  it("says it is thinking, then that words are still coming, then nothing", async () => {
    const box = await composer();
    await box.click();
    await browser.keys("run the tests".split(""));
    await browser.keys(["Enter"]);

    // 1. Not a word written yet: three dots, and a clock that has passed a second.
    const thinking = await waitForMark(
      (m) => m.dots === 3 && /\d+s/.test(m.thinkingLine),
      "the panel never said it was thinking, with a clock on it",
    );
    assert.equal(thinking.carets, 0, "there is no text yet for a caret to sit behind");
    if (thinking.reducedMotion) {
      assert.deepEqual(thinking.dotAnimations, ["none", "none", "none"], "reduced motion was not honoured");
    } else {
      assert.deepEqual(
        thinking.dotAnimations,
        ["thinking", "thinking", "thinking"],
        "the dots carry the class but the stylesheet gives them no animation",
      );
      // Identical delays would be three dots blinking in unison, not a wave.
      assert.equal(new Set(thinking.dotDelays).size, 3, `the dots share a delay: ${thinking.dotDelays}`);
    }

    // 2. Text is arriving: one caret, behind the words, and the dots are gone -
    //    the panel says one thing at a time.
    const streaming = await waitForMark(
      (m) => m.carets === 1,
      "text arrived with no caret to say more was coming",
    );
    assert.equal(streaming.dots, 0, "the thinking dots outstayed the first word");
    assert.ok(streaming.caretIsLast, "the caret is in the bubble but not behind the text");
    assert.ok(streaming.answerShown, "the caret arrived without the answer it belongs to");
    if (!streaming.reducedMotion) {
      assert.equal(streaming.caretAnimation, "caret", "the caret is on screen but not blinking");
    }

    // 3. The turn is over: every mark goes, and what it wrote stays.
    const done = await waitForMark(
      (m) => m.carets === 0 && m.dots === 0,
      "the panel kept a waiting mark after the turn ended",
    );
    assert.ok(done.answerShown, "the answer itself is gone");
  });

  it("leaves nothing behind when a turn ends without a word", async () => {
    // A CLI that starts, says nothing and exits 0 - the shape of one that dies
    // on its own footing. The panel used to leave its "Thinking…" there for
    // good; an empty bubble in its place would be no better.
    fs.writeFileSync(MODE_FILE, "silent");
    const prompt = "answer me nothing";
    const box = await composer();
    await box.click();
    await browser.keys(prompt.split(""));
    await browser.keys(["Enter"]);

    // It has to have started before the end of it means anything.
    await waitForMark((m) => m.dots === 3, "the silent turn never started");
    await waitForMark(
      (m) => m.dots === 0 && m.carets === 0,
      "the silent turn never let go of its waiting marks",
    );

    const row = await lastRowIsUsers(prompt);
    assert.ok(row.found, "the prompt that was sent is not in the conversation");
    assert.ok(row.isLast, `the turn that said nothing left something behind: ${row.after}`);
  });
});
