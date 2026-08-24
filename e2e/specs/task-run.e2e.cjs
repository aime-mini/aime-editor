/**
 * A Task Run from end to end, offline.
 *
 * The run is the whole promise of the feature: hand it a work item, walk away,
 * and trust what you come back to. What makes that trustworthy is not the model
 * — it is that the run stops when the evidence says stop, and that every claim
 * in the report was measured by something other than the thing that wrote the
 * code. So this drives the four things that promise rests on:
 *
 * 1. The confirmation gate: the approach, the test cases and the plan are on
 *    screen with NOTHING written yet, and the run waits.
 * 2. Red-then-green as a measurement, per CASE: the tests go in first, the
 *    suite has to get worse, and the failure has to carry the case's own test
 *    by name - the case table says PASS only because all of that happened.
 * 3. The project's own checks: a change that breaks `npm run check` is caught
 *    and fixed, not reported and abandoned.
 * 4. The record: a finished run is still there after a reload, and can be
 *    opened again.
 * 5. Delivery as a gate: the deliver phase must leave an artifact per case and
 *    proof the deployed software answered - files Aime checks on disk - and
 *    the cleanup button lists only what the run created and deletes only what
 *    is ticked, never the evidence by default.
 * 6. A project with no test script: the model says how it is really tested,
 *    Aime runs the answer, and the whole pipeline measures through it.
 *
 * Plus the two halves of "finish the job": a break it can repair, and one it
 * cannot - which must stop after trying and never claim success.
 *
 * Nothing here spends a penny. The "AI CLI" is a `providers.json` entry
 * pointing at a script this spec writes: it reads the prompt on stdin, works
 * out which phase is asking, and answers with the JSON that phase expects —
 * and, for the phases that write, actually edits the sample project. That is
 * enough to drive every gate with real files, a real branch, real suites and
 * real exit codes.
 *
 * The sample project is created here and thrown away here. Nothing in this
 * spec touches a real repository.
 */
const { strict: assert } = require("node:assert");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const configDir = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor");
const providersFile = path.join(configDir, "providers.json");
const trackersFile = path.join(configDir, "trackers.json");
const keysFile = path.join(configDir, "api-keys.json");

/** Where the fake CLI reads its orders: "sound", "repairs", "breaks" or "sloppy". */
const MODE_FILE = path.join(os.tmpdir(), "aime-run-probe-mode.txt");
const PROBE_SCRIPT = path.join(os.tmpdir(), "aime-run-probe.cjs");

const ORGANIZATION = "aime-run";
const PROJECT = "Probe";
const TOKEN = "pat-run-1";

/**
 * The fake CLI.
 *
 * It is a file rather than `node -e …` because it needs quotes, and every
 * argument crosses `cmd /C`, which mangles them.
 */
const PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");

const ROUNDS = "  return Math.round(amount * (1 + rate) * 100) / 100;\n";
const RAW = "  return amount * (1 + rate);\n";

const cart = (total, tax, extra) =>
  "export function subtotal(lines) {\n" + total + "}\n" +
  (extra || "") +
  "export function withTax(amount, rate) {\n" + tax + "}\n";

const ADDS_UP = "  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);\n";
const RUINED = "  return 0;\n";

// What the implementing phase writes, per mode. "sound" does the job; "breaks"
// and "sloppy" each do the job and something else - one ruins a passing test,
// the other trips the project's own linter.
const SOUND = cart(ADDS_UP, ROUNDS);
const BREAKS = cart(RUINED, ROUNDS);
const SLOPPY = cart(ADDS_UP, ROUNDS, 'const debug = () => console.log("here");\n');

// The suite as the tests phase leaves it: rounding now asserted, and results
// printed the way vitest prints them - the one JS format Aime reads failing
// test NAMES out of. The names are what let the red proof be credited to TC1
// itself rather than to "the suite", which is the per-case bar the report holds.
const TEST_WITH_ROUNDING =
  'const assert = require("node:assert");\n' +
  'const { pathToFileURL } = require("node:url");\n' +
  'const cart = pathToFileURL(require("node:path").join(__dirname, "src", "cart.js")).href;\n' +
  "const checks = [\n" +
  '  ["subtotal adds every line", (m) => assert.equal(m.subtotal([{ price: 10, quantity: 2 }]), 20)],\n' +
  '  ["rounds to two places", (m) => assert.equal(m.withTax(25, 0.1), 27.5)],\n' +
  "];\n" +
  "import(cart).then((m) => {\n" +
  "  const failed = checks.filter(([, run]) => { try { run(m); return false; } catch { return true; } });\n" +
  '  for (const [name] of failed) console.log("FAIL  test.cjs > " + name);\n' +
  "  console.log(failed.length > 0\n" +
  '    ? "Tests  " + failed.length + " failed | " + (checks.length - failed.length) + " passed (" + checks.length + ")"\n' +
  '    : "Tests  " + checks.length + " passed (" + checks.length + ")");\n' +
  "  process.exit(failed.length > 0 ? 1 : 0);\n" +
  "});\n";

const prompt = fs.readFileSync(0, "utf8");
const here = (...parts) => path.join(process.cwd(), ...parts);

// Two routes reach this script and they read its output differently, which is
// a real property of the app rather than a quirk of the probe. A phase that can
// answer from the prompt alone runs the CLI one-shot, and Aime takes stdout
// verbatim. A phase that has to look at the repository runs it as an agent with
// read-only tools, and Aime reads the streamed events - where a line of plain
// output arrives wrapped as {type:"raw", text}.
const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const stream = (value) =>
  process.stdout.write(JSON.stringify({ type: "raw", text: JSON.stringify(value) }) + "\n");
const mode = fs.existsSync(${JSON.stringify(MODE_FILE)})
  ? fs.readFileSync(${JSON.stringify(MODE_FILE)}, "utf8").trim()
  : "sound";

if (prompt.includes("answer both questions at once")) {
  // The ticket and the ground it lands on, in one reply: Aime takes its keys
  // out of the same JSON object.
  stream({
    goal: "Round the total to two places",
    criteria: [{ id: "AC1", text: "withTax rounds to two decimal places" }],
    questions: [],
    files: ["src/cart.js"],
    patterns: ["plain ES modules, no framework - src/checkout.js"],
    testsLiveIn: "test.cjs at the root, run by node",
    // Read out of "CI config": how this project is really tested. Aime only
    // acts on this when the manifest declares no test script - and even then
    // only after running it for real.
    suites: [{ command: "node test.cjs", dir: "." }],
  });
} else if (prompt.includes("Decide how this gets done")) {
  // The approach, the cases and the plan are one page, because they are what a
  // person is asked to agree to in one reading.
  stream({
    how: "round the total inside withTax, where the maths already lives",
    why: "one place to be right, and no caller can forget it; rounding at every screen cannot be enforced",
    decisions: ["withTax returns money, rounded to two places"],
    cases: [
      {
        id: "TC1",
        criterion: "AC1",
        prove: "a unit test of withTax through the project's own suite",
        given: "a total of 25 and a rate of 0.1",
        when: "withTax is called",
        then: "it answers 27.5 rather than 27.500000000000004",
      },
    ],
    steps: [{ what: "Round in withTax", files: ["src/cart.js"], criteria: ["AC1"] }],
    tests: [{ name: "rounds to two places", file: "test.cjs", case: "TC1" }],
  });
} else if (prompt.includes("Write the tests for this change")) {
  // Tests only, and no production code: the suite must go red on the strength
  // of the assertion alone, which is the thing the phase after this measures.
  fs.writeFileSync(here("test.cjs"), TEST_WITH_ROUNDING);
  process.stdout.write("tests written\n");
} else if (prompt.includes("Implement this work item")) {
  // "repairs" and "breaks" both break something here; they differ in what the
  // repair phase does about it afterwards.
  const breaks = mode === "breaks" || mode === "repairs";
  const source = breaks ? BREAKS : mode === "sloppy" ? SLOPPY : SOUND;
  fs.writeFileSync(here("src", "cart.js"), source);
  // And the kind of droppings an agent leaves behind: an untracked scratch
  // file, which the cleanup button must offer and the baseline snapshot must
  // not blame on anything that was already there.
  fs.writeFileSync(here("debug-scratch.log"), "temporary notes\n");
  process.stdout.write("done\n");
} else if (prompt.includes("broke this project's own checks")) {
  // The linter caught the stray console.log. Take it out - which is what
  // "fixed and re-run until they pass" has to mean in practice.
  fs.writeFileSync(here("src", "cart.js"), SOUND);
  process.stdout.write("tidied\n");
} else if (prompt.includes("Your change broke something")) {
  // In "repairs" mode it puts back what it broke while keeping the new
  // behaviour; in "breaks" mode it stubbornly does not, which is how the
  // bounded give-up gets proved.
  if (mode === "repairs") fs.writeFileSync(here("src", "cart.js"), SOUND);
  process.stdout.write("tried\n");
// Matched on a phrase that sits on ONE line of the prompt: the prompts are
// wrapped template literals, and a phrase spanning a wrap point never matches.
} else if (prompt.includes("build it, deploy it, and prove it works where it runs")) {
  // The deliver phase: deploy proof plus one artifact per case, which is what
  // the gate reads off the disk - the words in stdout prove nothing to it.
  fs.mkdirSync(here(".aime", "evidence", "deploy"), { recursive: true });
  fs.writeFileSync(here(".aime", "evidence", "TC1.txt"), "node test.cjs: rounds to two places passed\n");
  fs.writeFileSync(here(".aime", "evidence", "deploy", "health.txt"), "served on 4173, / answered 200\n");
  process.stdout.write("delivered\n");
} else if (prompt.includes("Review this change")) {
  say({ risks: ["rounding could drift on large totals"], findings: [] });
} else {
  process.stdout.write("unrecognised prompt\n");
}
`;

const PROBE_PROVIDER = [
  {
    id: "run-probe",
    displayName: "Run Probe",
    command: "node",
    args: [PROBE_SCRIPT],
    parser: "plain",
    promptStdin: true,
  },
];

// ------------------------------------------------------------ the sample

/**
 * The suite the gate measures, before the run touches it: green, and silent
 * about rounding.
 *
 * That silence is the point. The baseline has to pass, so that the test the run
 * writes for the new behaviour can make it fail - which is the only way
 * "red-then-green" is a measurement rather than a promise.
 */
const SAMPLE_TEST = `
const assert = require("node:assert");
const { pathToFileURL } = require("node:url");

const cart = pathToFileURL(require("node:path").join(__dirname, "src", "cart.js")).href;
import(cart).then((module) => {
  assert.equal(module.subtotal([{ price: 10, quantity: 2 }]), 20, "subtotal adds every line");
  console.log("Tests  1 passed (1)");
}).catch(() => {
  console.log("FAIL  test.cjs > subtotal adds every line");
  console.log("Tests  1 failed (1)");
  process.exit(1);
});
`;

/**
 * The project's own check, so the quality gate has something real to run.
 *
 * Deliberately a rule this project made up for itself rather than anything
 * Aime knows: the gate's whole claim is that it enforces the team's standard,
 * not its own.
 */
const SAMPLE_CHECK = `
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "src", "cart.js"), "utf8");
if (source.includes("console.log")) {
  console.error("src/cart.js logs to the console");
  process.exit(1);
}
console.log("check ok");
`;

/**
 * A second module that really imports the one being changed. Without it the
 * blast radius has no true answer to find: the suite reaches `cart.js` through
 * a computed `import()`, which is not a reference any language server can see.
 */
const SAMPLE_CHECKOUT = `import { withTax } from "./cart.js";

export function receiptTotal(amount, rate) {
  return withTax(amount, rate);
}
`;

const SAMPLE_CART = `export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}
export function withTax(amount, rate) {
  return amount * (1 + rate);
}
`;

/**
 * What a JavaScript project needs before a language server can say anything
 * about it, both measured against typescript-language-server 5.3 on 2026-08-23:
 *
 * 1. **A jsconfig (or tsconfig).** Without one the server puts the opened file
 *    in an inferred project of its own, so `references` sees that file and
 *    nothing else - `checkout.js` importing `cart.js` is invisible. With one,
 *    the server announces "Initializing JS/TS language features…" and the same
 *    question answers `src/checkout.js`.
 * 2. **A real TypeScript.** The server runs the `typescript` it finds in the
 *    project; without one it falls back to a bundled stub that reports version
 *    1.0.0 and does not even declare `documentSymbolProvider`. Note that a
 *    global install is not enough - measured, it is not looked at.
 *
 * Both are ordinary in a real project, and a sample that lacks them would test
 * a language server that was never given a chance to answer.
 */
function giveItALanguageService(dir) {
  fs.writeFileSync(
    path.join(dir, "jsconfig.json"),
    JSON.stringify({ compilerOptions: { checkJs: false }, include: ["src/**/*"] }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(process.cwd(), "node_modules", "typescript"),
    path.join(dir, "node_modules", "typescript"),
    // A junction, because a symlink to a directory needs administrator rights
    // on Windows and a junction does not.
    "junction",
  );
}

function sampleProject({ declaresTest = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aime-run-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "sample",
        private: true,
        type: "module",
        // `declaresTest: false` models the Gradle/Makefile world: the tests
        // exist, but no manifest script names them, so the run has to ask and
        // then verify the answer by running it.
        scripts: declaresTest
          ? { test: "node test.cjs", check: "node check.cjs" }
          : { check: "node check.cjs" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, "test.cjs"), SAMPLE_TEST);
  fs.writeFileSync(path.join(dir, "check.cjs"), SAMPLE_CHECK);
  fs.writeFileSync(path.join(dir, "src", "cart.js"), SAMPLE_CART);
  fs.writeFileSync(path.join(dir, "src", "checkout.js"), SAMPLE_CHECKOUT);
  giveItALanguageService(dir);

  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "probe@example.com");
  git("config", "user.name", "Probe");
  git("add", ".");
  git("commit", "-m", "first");
  return dir;
}

// ------------------------------------------------------------- the board

const ITEM = {
  id: 12,
  fields: {
    "System.Title": "Round the total to two places",
    "System.State": "Committed",
    "System.WorkItemType": "Bug",
    "System.AreaPath": "Probe\\Cart",
    "System.Description": "<div>withTax must round to two decimal places.</div>",
  },
};

const WORK_ITEM_TYPES = {
  count: 1,
  value: [{ name: "Bug", states: [{ name: "Committed", category: "InProgress" }] }],
};

const board = { server: null, origin: "" };

function startBoard() {
  return new Promise((resolve) => {
    board.server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const url = request.url ?? "";
        const json = (payload) => {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(payload));
        };
        if (url.includes("/workitemtypes")) return json(WORK_ITEM_TYPES);
        if (url.includes("/wiql")) return json({ queryType: "flat", workItems: [{ id: 12 }] });
        if (url.includes("/workitemsbatch")) return json({ count: 1, value: [ITEM] });
        if (url.includes("/comments")) return json({ count: 0, comments: [] });
        if (url.includes("/teamsettings/teamfieldvalues")) {
          return json({
            field: { referenceName: "System.AreaPath" },
            defaultValue: "Probe",
            values: [{ value: "Probe", includeChildren: true }],
          });
        }
        if (/\/workitems\/\d+/.test(url)) return json(ITEM);
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end("{}");
      });
    });
    board.server.listen(0, "127.0.0.1", () => {
      board.origin = `http://127.0.0.1:${board.server.address().port}`;
      resolve();
    });
  });
}

// -------------------------------------------------------------- helpers

const backupOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const restore = (file, content) => {
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
};

/**
 * One phase's own row in the run's list, by the heading it carries.
 *
 * Anchored to the row rather than read off the whole page: a summary that
 * appeared under a different phase - or in the log - would still be found by a
 * search of the body, and a test that cannot tell those apart proves nothing.
 */
async function phaseRow(heading) {
  return browser.execute((label) => {
    const rows = [...document.querySelectorAll("ol > li")];
    const row = rows.find((candidate) => (candidate.textContent ?? "").includes(label));
    return row?.textContent ?? "";
  }, heading);
}

/** Waits for a phase's row to say something, and hands back what it says. */
async function waitForPhase(heading, needle, message, timeout = 180_000) {
  await browser.waitUntil(async () => (await phaseRow(heading)).includes(needle), {
    timeout,
    timeoutMsg: `${message} (row "${heading}" never said "${needle}")`,
  });
  return phaseRow(heading);
}

async function waitForText(text, message, timeout = 60_000) {
  const needle = text.toLowerCase();
  try {
    await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
      timeout,
      timeoutMsg: `${message} (looked for "${text}")`,
    });
  } catch {
    // The panel's own words are the diagnosis; without them a timeout says
    // only that something did not happen.
    const page = await $("body").getText();
    throw new Error(`${message} (looked for "${text}")
--- on screen ---
${page.slice(0, 2000)}`);
  }
}

/**
 * Types a value and proves it arrived whole.
 *
 * Measured 2026-08-24: a person typing at the machine while the parked test
 * window held keyboard focus left "làm" interleaved inside the board URL -
 * 'lhttp://127.0.0.1:51291àm' - and the connect step failed for a reason that
 * looked exactly like the long-standing board flake. A field read back is a
 * field known to hold its value, whatever else the keyboard was doing.
 */
async function fill(field, value) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await field.setValue(value);
    if ((await field.getValue()) === value) return;
  }
  throw new Error(`a field never held "${value}" - something else is typing into this window`);
}

async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
    localStorage.setItem("aime.provider", "run-probe");
    localStorage.setItem("aime.theme", "dark");
  }, dir);
  await browser.refresh();
  await waitForText("recent", "the welcome screen never rendered");
  await (await $(`span=${dir.split(/[\\/]/).pop()}`)).click();
}

/** The branch the repository is standing on right now. */
const currentBranch = (dir) =>
  execFileSync("git", ["branch", "--show-current"], { cwd: dir }).toString().trim();

/** The row whose text carries this work item id. */
async function rowFor(id) {
  const rows = await $$("div.group");
  for (const row of rows) {
    if ((await row.getText()).includes(`#${id}`)) return row;
  }
  throw new Error(`no row for work item ${id}`);
}

/**
 * Connects the board and starts a run on its one item.
 *
 * The board is connected once and the credential is the machine's, so the
 * second project of the run is asked which board it uses rather than for a
 * token again - both doors have to be handled.
 */
async function startRun(repo) {
  await open(repo);
  await waitForText("package.json", "the sample never opened");
  await (await $('button[title="Work items"]')).click();

  await browser.waitUntil(
    async () => {
      const page = (await $("body").getText()).toLowerCase();
      return page.includes("connect a board") || page.includes("which board does this project use");
    },
    { timeout: 60_000, timeoutMsg: "the work items tab never asked for a board" },
  );

  if ((await $("body").getText()).toLowerCase().includes("connect a board")) {
    await fill(await $('input[placeholder="contoso"]'), ORGANIZATION);
    // Matched by prefix: the field takes a comma-separated list of projects, so
    // its placeholder names two.
    await fill(await $('input[placeholder^="Contoso Web"]'), PROJECT);
    await fill(await $('input[placeholder="https://dev.azure.com"]'), board.origin);
    await fill(await $('input[type="password"]'), TOKEN);
    await browser.keys("Enter");
  } else {
    await (await $(`button*=${ORGANIZATION}`)).click();
  }
  await waitForText("round the total", "the board's item never reached the panel");

  const row = await rowFor(12);
  await row.moveTo();
  await (await $('button[title="Work on this with AI"]')).click();
}

/**
 * Waits for the confirmation gate and approves it.
 *
 * The gate is the default, and it is the one place a person is meant to be in
 * the loop - so every test goes through it rather than around it.
 */
async function approve(repo) {
  await waitForText("read the approach", "the run never stopped for approval", 240_000);
  assert.equal(
    fs.readFileSync(path.join(repo, "src", "cart.js"), "utf8").includes("Math.round"),
    false,
    "the run wrote code before it was approved",
  );
  await (await $("button*=Approved")).click();
}

/** Runs the sample's own suite, so "fixed" is checked and not taken on trust. */
function spawnSuite(dir) {
  const run = spawnSync("npm", ["test"], { cwd: dir, encoding: "utf8", shell: true });
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/** The run report this project wrote, whichever run wrote it. */
function reportsIn(dir) {
  const runs = path.join(dir, ".aime", "runs");
  if (!fs.existsSync(runs)) return [];
  return fs
    .readdirSync(runs)
    .filter((name) => name.endsWith(".md"))
    .map((name) => fs.readFileSync(path.join(runs, name), "utf8"));
}

describe("Task run", () => {
  const saved = { providers: null, trackers: null, keys: null };
  let repo = "";

  before(async () => {
    saved.providers = backupOf(providersFile);
    saved.trackers = backupOf(trackersFile);
    saved.keys = backupOf(keysFile);
    fs.rmSync(trackersFile, { force: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(PROBE_SCRIPT, PROBE_SOURCE);
    fs.writeFileSync(providersFile, JSON.stringify(PROBE_PROVIDER, null, 2));
    await startBoard();
  });

  after(() => {
    restore(providersFile, saved.providers);
    restore(trackersFile, saved.trackers);
    restore(keysFile, saved.keys);
    fs.rmSync(PROBE_SCRIPT, { force: true });
    fs.rmSync(MODE_FILE, { force: true });
    board.server?.close();
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on the folder the app has open.
    }
  });

  /** A fresh sample for each test, so no run inherits another's damage. */
  function freshRepo(previous, options) {
    try {
      if (previous) fs.rmSync(previous, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on the folder the app has open; the temp sweep gets it.
    }
    return sampleProject(options);
  }

  it("agrees the approach and the cases before it writes anything, then proves the tests red", async () => {
    fs.writeFileSync(MODE_FILE, "sound");
    repo = freshRepo(repo);
    await startRun(repo);

    // Phase 0 is real work before a single token is spent: a branch of its own,
    // and every suite and check as they stand.
    await waitForText("baseline", "the run never started");
    await browser.waitUntil(() => currentBranch(repo).startsWith("bugfix/12-"), {
      timeout: 60_000,
      timeoutMsg: `the run did not start a branch of its own: on ${currentBranch(repo)}`,
    });
    assert.notEqual(currentBranch(repo), "main", "a run must never work on the branch the user was on");

    // The phase that asks the language server "who else uses this?". `checkout.js`
    // imports `cart.js`, and the only thing in the app that can know it is the
    // server - the fake CLI never mentions that file.
    const ground = await waitForPhase(
      "Read the item and the code",
      "depending on them",
      "the phase never reported a radius",
    );
    assert.match(
      ground,
      /1 file\(s\) to change, 1 depending on them/,
      `the language server was not asked what depends on the change: ${ground}`,
    );

    // One page: the approach, the cases and the plan. The cases exist as a file
    // a person can read and edit, which is the whole difference between "there
    // is a test" and "we agreed what proof is".
    await waitForPhase(
      "Decide the approach, the cases and the plan",
      "test case(s) covering",
      "the approach and the cases were never decided",
    );
    const casesFile = path.join(repo, ".aime", "test-cases.md");
    assert.ok(fs.existsSync(casesFile), "the test cases were not written where a person can read them");
    const cases = fs.readFileSync(casesFile, "utf8");
    assert.match(cases, /## AC1 —/, `the cases are not filed under the criterion: ${cases}`);
    assert.match(cases, /\*\*Then\*\* it answers 27\.5/, `the expected result is missing: ${cases}`);
    // And how it gets proved, which is the case's own answer rather than a
    // layer Aime guessed from the file path.
    assert.match(cases, /\*\*Proved by\*\* a unit test/, `the case does not say how it is proved: ${cases}`);

    // The gate: everything is on screen and nothing has been written. `approve`
    // itself asserts the second half of that.
    await approve(repo);

    // Red-then-green, measured: the tests went in alone and the suite got worse.
    const tests = await waitForPhase("Write the tests", "as they must", "the tests were never proved red");
    assert.match(tests, /fail as they must/, `the red proof was not reported: ${tests}`);

    await waitForText("finished, and every gate agreed", "the run never finished", 240_000);
    assert.match(
      fs.readFileSync(path.join(repo, "src", "cart.js"), "utf8"),
      /Math\.round/,
      "the implementing phase did not actually edit the file",
    );

    // The table a tester would sign, and the one word in it that has to be
    // earned: a test naming the case exists, that test was seen failing first,
    // every suite is green, and an artifact from the running software names it.
    const [report] = reportsIn(repo);
    assert.ok(report, "the run left no report behind");
    assert.match(report, /\| TC1 \| AC1 \|/, `the case table is missing its row: ${report}`);
    assert.match(report, /\| PASS \|/, `the case was not recorded as proved: ${report}`);

    // The deliver phase's evidence is real files Aime checked, not a claim:
    // one artifact named after the case, and proof the deployed thing answered.
    assert.ok(
      fs.existsSync(path.join(repo, ".aime", "evidence", "TC1.txt")),
      "no artifact for TC1 on disk",
    );
    assert.ok(
      fs.existsSync(path.join(repo, ".aime", "evidence", "deploy", "health.txt")),
      "no proof the deployed software answered",
    );

    // The cleanup button: the first click only lists - the stray file the run
    // created is offered, the evidence is shown but not ticked - and the second
    // click deletes exactly what is ticked.
    await (await $("button*=List what this run left behind")).click();
    await waitForText("debug-scratch.log", "the stray file the run created was never offered");
    const listed = await $("body").getText();
    assert.match(listed, /TC1\.txt/, "the evidence is not in the cleanup list at all");
    await (await $("button*=Delete 1 file")).click();
    await browser.waitUntil(() => !fs.existsSync(path.join(repo, "debug-scratch.log")), {
      timeout: 30_000,
      timeoutMsg: "the ticked stray file is still on disk",
    });
    assert.ok(
      fs.existsSync(path.join(repo, ".aime", "evidence", "TC1.txt")),
      "the sweep took the evidence too, which the default must never do",
    );
  });

  it("fixes what it broke instead of handing back an unfinished job", async () => {
    // The change does what was asked *and* ruins `subtotal`, which was passing.
    // A workflow that reported the damage and stopped would have produced
    // homework; this one is asked to finish the task, so the repair phase gets
    // the failure and puts it right.
    fs.writeFileSync(MODE_FILE, "repairs");
    repo = freshRepo(repo);
    await startRun(repo);
    await approve(repo);

    const repair = await waitForPhase(
      "Measure everything, and fix what broke",
      "Fixed in",
      "the phase never reported putting it right",
      240_000,
    );
    assert.match(repair, /Fixed in \d+ attempt/, `the repair did not say what it cost: ${repair}`);
    assert.match(repair, /measured again/, `nothing was measured after the fix: ${repair}`);
    await waitForText("finished, and every gate agreed", "the run gave up instead of repairing", 240_000);
    // And it really is fixed on disk, by the project's own suite's standard.
    const suite = spawnSuite(repo);
    assert.equal(
      suite.status,
      0,
      `the suite is still failing after the repair:
${suite.output}`,
    );
  });

  it("fixes the project's own check when the change breaks it", async () => {
    // `npm run check` is this project's rule, not Aime's: no console.log in
    // cart.js. The implementing phase leaves one in, so the quality gate has to
    // catch it, hand it back, and re-run - and never silence the rule.
    fs.writeFileSync(MODE_FILE, "sloppy");
    repo = freshRepo(repo);
    await startRun(repo);
    await approve(repo);

    const quality = await waitForPhase(
      "Measure everything, and fix what broke",
      "Fixed in",
      "the project's own check was not fixed",
      240_000,
    );
    // The summary names what it mended, which is this project's own check task
    // ("npm check", the way the task list labels it) - not a rule Aime invented.
    assert.match(quality, /measured again: npm check/, `the mended check was not named: ${quality}`);
    await waitForText("finished, and every gate agreed", "the run never finished", 240_000);
    assert.equal(
      fs.readFileSync(path.join(repo, "src", "cart.js"), "utf8").includes("console.log"),
      false,
      "the console.log the project forbids is still there",
    );
  });

  it("keeps the run on file, so it can be read again after a reload", async () => {
    // The run just finished in this project. Reload the app, open the project
    // again and ask for the runs: what a person comes back to a week later.
    await browser.refresh();
    await waitForText("recent", "the welcome screen never rendered");
    await (await $(`span=${repo.split(/[\\/]/).pop()}`)).click();
    await waitForText("package.json", "the sample never reopened");

    await browser.keys(["Control", "p"]);
    // '>' narrows the palette to commands, so Enter cannot land on a file whose
    // name happens to fuzzy-match better than the command does.
    await (await $('input[placeholder*="Type a command"]')).setValue(">task runs");
    await browser.keys("Enter");

    await waitForText("earlier runs", "the run history never opened");
    await waitForText("round the total", "the finished run was not kept on file");
  });

  it("finds how a script-less project is tested, runs it, and still proves the case", async () => {
    // The Gradle/Makefile world: the tests exist but no manifest script names
    // them. The model is asked how this project is really tested, and Aime
    // believes the answer only after running it. Everything downstream is the
    // proof that this worked: without the discovered suite there is no
    // baseline, the tests phase would skip, and TC1 could never be proved red.
    fs.writeFileSync(MODE_FILE, "sound");
    repo = freshRepo(repo, { declaresTest: false });
    await startRun(repo);

    await waitForPhase(
      "Baseline",
      "declares no test command",
      "the baseline hid that the gate had nothing to run",
    );
    await approve(repo);
    const tests = await waitForPhase(
      "Write the tests",
      "as they must",
      "the discovered command never carried the red proof",
    );
    assert.match(tests, /fail as they must/, `red was not proved through the discovered suite: ${tests}`);

    await waitForText("finished, and every gate agreed", "the run never finished", 240_000);
    const [report] = reportsIn(repo);
    assert.match(report, /\| PASS \|/, `the case was not proved end to end: ${report}`);
  });

  it("stops only after trying, and says so, when it cannot fix what it broke", async () => {
    // Same damage as the repair test, but the repair phase refuses to undo it.
    // The run must not report success, and must not loop forever either.
    fs.writeFileSync(MODE_FILE, "breaks");
    repo = freshRepo(repo);
    await startRun(repo);
    await approve(repo);

    const gave = await waitForPhase(
      "Measure everything, and fix what broke",
      "Still broken after",
      "the run stopped without saying it had tried",
      240_000,
    );
    assert.match(gave, /Still broken after 3 attempts/, `the attempts were not reported: ${gave}`);
    await waitForText("stopped here", "a change that broke a passing test was not stopped", 240_000);
    assert.equal(
      (await $("body").getText()).toLowerCase().includes("finished, and every gate agreed"),
      false,
      "a blocked run must never also report success",
    );
  });
});
