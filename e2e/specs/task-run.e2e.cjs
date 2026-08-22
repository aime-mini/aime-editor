/**
 * A Task Run from end to end, offline.
 *
 * The run is the whole promise of the feature: hand it a work item, walk away,
 * and trust what you come back to. What makes that trustworthy is not the
 * model — it is that the run stops when the evidence says stop. So the two
 * things proved here are the two halves of that:
 *
 * 1. A run whose change is sound walks every phase and finishes.
 * 2. A run whose change breaks a test that was passing is **stopped** at the
 *    regression gate, and says which phase refused.
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
const { execFileSync } = require("node:child_process");
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
} else if (prompt.includes("Implement this work item")) {
  // The only phase that writes, and it writes for real.
  const cart = path.join(process.cwd(), "src", "cart.js");
  const sound = "export function subtotal(lines) {\n" +
    "  return lines.reduce((total, line) => total + line.price * line.quantity, 0);\n" +
    "}\n" +
    "export function withTax(amount, rate) {\n" +
    "  return Math.round(amount * (1 + rate) * 100) / 100;\n" +
    "}\n";
  const breaks = "export function subtotal(lines) {\n" +
    "  return 0;\n" +
    "}\n" +
    "export function withTax(amount, rate) {\n" +
    "  return Math.round(amount * (1 + rate) * 100) / 100;\n" +
    "}\n";
  fs.writeFileSync(cart, mode === "breaks" ? breaks : sound);
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

    // Phase 0 is real work before a single token is spent: its own branch, and
    // the suite as it stands. The sample's suite fails at the start - withTax
    // does not round yet - which is exactly a red baseline, and the run must
    // carry on rather than blame the change for it.
    await waitForText("baseline", "the run never started");
    await browser.waitUntil(() => currentBranch(repo).startsWith("bugfix/12-"), {
      timeout: 60_000,
      timeoutMsg: `the run did not start a branch of its own: on ${currentBranch(repo)}`,
    });
    assert.notEqual(currentBranch(repo), "main", "a run must never work on the branch the user was on");

    // It stops at the plan by default, which is the cheap place to catch a
    // wrong direction.
    await waitForText("read the plan below", "the run did not stop for the plan to be read");
    await (await $("button*=carry on")).click();

    await waitForText("finished, and every gate agreed", "the run never finished", 180_000);
    // The change is on disk, and the suite that judged it is the project's own.
    assert.match(
      fs.readFileSync(path.join(repo, "src", "cart.js"), "utf8"),
      /Math\.round/,
      "the implementing phase did not actually edit the file",
    );
  });

  it("stops at the regression gate when the change breaks something that worked", async () => {
    // The same run, with one difference: the change also breaks `subtotal`,
    // which was passing before. This is the gate the whole feature exists for.
    fs.writeFileSync(MODE_FILE, "breaks");
    fs.rmSync(repo, { recursive: true, force: true });
    repo = sampleProject();
    // Make the baseline green, so the break is unambiguously new.
    fs.writeFileSync(
      path.join(repo, "src", "cart.js"),
      SAMPLE_CART.replace(
        "return amount * (1 + rate);",
        "return Math.round(amount * (1 + rate) * 100) / 100;",
      ),
    );
    execFileSync("git", ["commit", "-am", "green"], { cwd: repo, stdio: "pipe" });

    await startRun(repo);
    await waitForText("read the plan below", "the run did not stop for the plan to be read");
    await (await $("button*=carry on")).click();

    await waitForText("stopped here", "a change that broke a passing test was not stopped", 180_000);
    const page = (await $("body").getText()).toLowerCase();
    assert.ok(
      page.includes("passing before this change") || page.includes("passing to failing"),
      `the run stopped without saying a test regressed:\n${page.slice(0, 1200)}`,
    );
    assert.equal(
      page.includes("finished, and every gate agreed"),
      false,
      "a blocked run must never also report success",
    );
  });
});
