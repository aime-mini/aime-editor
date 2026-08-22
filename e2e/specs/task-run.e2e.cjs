/**
 * A Task Run from end to end, offline.
 *
 * The run is the whole promise of the feature: hand it a work item, walk away,
 * and trust what you come back to. What makes that trustworthy is not the
 * model — it is that the run stops when the evidence says stop. So the two
 * things proved here are the two halves of that:
 *
 * 1. A run whose change is sound walks every phase and finishes, with nothing
 *    to click on the way.
 * 2. A run whose change breaks a test that was passing **fixes it** and still
 *    finishes - reporting the damage and stopping would have been homework,
 *    not a finished task.
 * 3. A run that cannot fix what it broke stops after trying, says it tried,
 *    and never reports success.
 *
 * Neither test spends a penny. The "AI CLI" is a `providers.json` entry
 * pointing at a script this spec writes: it reads the prompt on stdin, works
 * out which phase is asking, and answers with the JSON that phase expects —
 * and, for the implementing phase, actually edits the sample project. That is
 * enough to drive every gate with real files, a real branch, a real suite and
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

/** Where the fake CLI reads its orders: "sound" or "breaks". */
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

const SOUND = "export function subtotal(lines) {\n" +
  "  return lines.reduce((total, line) => total + line.price * line.quantity, 0);\n" +
  "}\n" +
  "export function withTax(amount, rate) {\n" +
  "  return Math.round(amount * (1 + rate) * 100) / 100;\n" +
  "}\n";
// Rounds as asked, and quietly ruins the totals - a change that does the job
// and breaks something else, which is the case the whole gate exists for.
const BREAKS = "export function subtotal(lines) {\n" +
  "  return 0;\n" +
  "}\n" +
  "export function withTax(amount, rate) {\n" +
  "  return Math.round(amount * (1 + rate) * 100) / 100;\n" +
  "}\n";

const prompt = fs.readFileSync(0, "utf8");
const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const mode = fs.existsSync(${JSON.stringify(MODE_FILE)})
  ? fs.readFileSync(${JSON.stringify(MODE_FILE)}, "utf8").trim()
  : "sound";

if (prompt.includes("say what it actually asks for")) {
  say({
    goal: "Round the total to two places",
    criteria: [{ id: "AC1", text: "withTax rounds to two decimal places" }],
    questions: [],
  });
} else if (prompt.includes("List the files")) {
  process.stdout.write("src/cart.js\n");
} else if (prompt.includes("Plan the change")) {
  say({
    steps: [{ what: "Round in withTax", files: ["src/cart.js"], criteria: ["AC1"] }],
    tests: [{ name: "rounds to two places", file: "test.cjs", criterion: "AC1" }],
  });
} else if (prompt.includes("Review this change")) {
  say({ risks: ["rounding could drift on large totals"], findings: [] });
} else if (prompt.includes("Your change broke something")) {
  // The repair phase. In "repairs" mode it puts back what it broke while
  // keeping the new behaviour; in "breaks" mode it stubbornly does not, which
  // is how the bounded give-up gets proved.
  if (mode === "repairs") {
    fs.writeFileSync(path.join(process.cwd(), "src", "cart.js"), SOUND);
  }
  process.stdout.write("tried\n");
} else if (prompt.includes("Implement this work item")) {
  // The only phase that writes, and it writes for real.
  fs.writeFileSync(path.join(process.cwd(), "src", "cart.js"), mode === "sound" ? SOUND : BREAKS);
  process.stdout.write("done\n");
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

/** The suite the gate measures: plain node, so nothing has to be installed. */
const SAMPLE_TEST = `
const assert = require("node:assert");
const { pathToFileURL } = require("node:url");

const cart = pathToFileURL(require("node:path").join(__dirname, "src", "cart.js")).href;
import(cart).then((module) => {
  assert.equal(module.subtotal([{ price: 10, quantity: 2 }]), 20, "subtotal adds every line");
  assert.equal(module.withTax(25, 0.1), 27.5, "withTax rounds to two places");
  console.log("2 passing");
}).catch((error) => {
  console.error(String(error.message ?? error));
  process.exit(1);
});
`;

const SAMPLE_CART = `export function subtotal(lines) {
  return lines.reduce((total, line) => total + line.price * line.quantity, 0);
}
export function withTax(amount, rate) {
  return amount * (1 + rate);
}
`;

function sampleProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aime-run-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "sample", private: true, type: "module", scripts: { test: "node test.cjs" } },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, "test.cjs"), SAMPLE_TEST);
  fs.writeFileSync(path.join(dir, "src", "cart.js"), SAMPLE_CART);

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

async function waitForText(text, message, timeout = 60_000) {
  const needle = text.toLowerCase();
  try {
    await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
      timeout,
      timeoutMsg: `${message} (looked for "${text}")`,
    });
  } catch (error) {
    // The panel's own words are the diagnosis; without them a timeout says
    // only that something did not happen.
    const page = await $("body").getText();
    throw new Error(`${message} (looked for "${text}")
--- on screen ---
${page.slice(0, 2000)}`);
  }
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
    await (await $('input[placeholder="contoso"]')).setValue(ORGANIZATION);
    await (await $('input[placeholder="Contoso Web"]')).setValue(PROJECT);
    await (await $('input[placeholder="https://dev.azure.com"]')).setValue(board.origin);
    await (await $('input[type="password"]')).setValue(TOKEN);
    await browser.keys("Enter");
  } else {
    await (await $(`button*=${ORGANIZATION}`)).click();
  }
  await waitForText("round the total", "the board's item never reached the panel");

  const row = await rowFor(12);
  await row.moveTo();
  await (await $('button[title="Work on this with AI"]')).click();
}

/** A sample whose suite is green from the first commit, so a break is new. */
function freshGreenRepo(previous) {
  try {
    if (previous) fs.rmSync(previous, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on the folder the app has open; the temp sweep gets it.
  }
  const dir = sampleProject();
  fs.writeFileSync(
    path.join(dir, "src", "cart.js"),
    SAMPLE_CART.replace("return amount * (1 + rate);", "return Math.round(amount * (1 + rate) * 100) / 100;"),
  );
  execFileSync("git", ["commit", "-am", "green"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/** Runs the sample's own suite, so "fixed" is checked and not taken on trust. */
function spawnSuite(dir) {
  const run = spawnSync("npm", ["test"], { cwd: dir, encoding: "utf8", shell: true });
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
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

  it("walks every phase and finishes when the change is sound", async () => {
    fs.writeFileSync(MODE_FILE, "sound");
    repo = sampleProject();
    await startRun(repo);

    // Phase 0 is real work before a single token is spent: a branch of its own,
    // and the suite as it stands. The sample's suite fails at the start -
    // withTax does not round yet - which is exactly a red baseline, and the run
    // must carry on rather than blame the change for it.
    await waitForText("baseline", "the run never started");
    await browser.waitUntil(() => currentBranch(repo).startsWith("bugfix/12-"), {
      timeout: 60_000,
      timeoutMsg: `the run did not start a branch of its own: on ${currentBranch(repo)}`,
    });
    assert.notEqual(currentBranch(repo), "main", "a run must never work on the branch the user was on");

    // Nothing to click: the run drives itself to the end, which is the point of
    // handing a task over.
    await waitForText("finished, and every gate agreed", "the run never finished", 240_000);
    assert.match(
      fs.readFileSync(path.join(repo, "src", "cart.js"), "utf8"),
      /Math\.round/,
      "the implementing phase did not actually edit the file",
    );
  });

  it("fixes what it broke instead of handing back an unfinished job", async () => {
    // The change does what was asked *and* ruins `subtotal`, which was passing.
    // A workflow that reported the damage and stopped would have produced
    // homework; this one is asked to finish the task, so the repair phase gets
    // the failure and puts it right.
    fs.writeFileSync(MODE_FILE, "repairs");
    repo = freshGreenRepo(repo);
    await startRun(repo);

    await waitForText("finished, and every gate agreed", "the run gave up instead of repairing", 240_000);
    const page = (await $("body").getText()).toLowerCase();
    assert.ok(
      page.includes("fixed, and the suite is clean"),
      `the repair was not reported: ${page.slice(0, 900)}`,
    );
    // And it really is fixed on disk, by the project's own suite's standard.
    const suite = spawnSuite(repo);
    assert.equal(
      suite.status,
      0,
      `the suite is still failing after the repair:
${suite.output}`,
    );
  });

  it("stops only after trying, and says so, when it cannot fix what it broke", async () => {
    // Same damage, but the repair phase refuses to undo it. The run must not
    // report success, and must not loop forever either.
    fs.writeFileSync(MODE_FILE, "breaks");
    repo = freshGreenRepo(repo);
    await startRun(repo);

    await waitForText("stopped here", "a change that broke a passing test was not stopped", 240_000);
    const page = (await $("body").getText()).toLowerCase();
    assert.ok(
      page.includes("still broken after"),
      `the run stopped without saying it had tried: ${page.slice(0, 900)}`,
    );
    assert.equal(
      page.includes("finished, and every gate agreed"),
      false,
      "a blocked run must never also report success",
    );
  });
});
