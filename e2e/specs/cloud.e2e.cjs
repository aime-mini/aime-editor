/**
 * Cloud discovery, end to end and offline.
 *
 * The promise of the feature is not the panel - it is that after a discovery
 * the project's own memory file holds what is really running in that account,
 * because that file is what every AI CLI reads on the turn where someone asks
 * for a deployment. So what this drives is the whole path: the rows, the
 * discovery, the parse, and the file on disk afterwards.
 *
 * Two things are deliberately real and one is deliberately fake. The probes are
 * real - Aime shells out to whichever cloud CLIs this machine has - so the rows
 * say something true about it. The write is real, into a throwaway folder made
 * and deleted here. The AI is a script this spec writes, pointed at by a
 * `providers.json` entry, so nothing here costs a penny or touches a real
 * cloud beyond asking it who you are.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const configDir = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor");
const providersFile = path.join(configDir, "providers.json");
const PROBE_SCRIPT = path.join(os.tmpdir(), "aime-cloud-probe.cjs");

/**
 * The fake AI.
 *
 * It answers the discovery prompt with the JSON a real one would, and anything
 * else with a shrug - which is also what proves the store writes nothing when
 * the answer is not readable.
 */
const PROBE_SOURCE = `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("Find out what already exists in this cloud account")) {
  process.stdout.write(JSON.stringify({
    deploys: ["GitHub Actions pushes the container on merge to main"],
    services: [
      { name: "probe-web", kind: "web app", where: "southeastasia / rg-probe", notes: "public" },
      { name: "probe-db", kind: "database", where: "southeastasia", notes: "private endpoint only" },
    ],
    gaps: ["no permission to list key vaults"],
  }) + "\\n");
} else {
  process.stdout.write("nothing to say\\n");
}
`;

const PROBE_PROVIDER = [
  {
    id: "cloud-probe",
    displayName: "Cloud Probe",
    command: "node",
    args: [PROBE_SCRIPT],
    parser: "plain",
    promptStdin: true,
  },
];

const backupOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const restore = (file, content) => {
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
};

/** One cloud's row, by the label it carries - never read off the whole page. */
async function cloudRow(label) {
  return browser.execute((name) => {
    const rows = [...document.querySelectorAll("div.flex.items-center")];
    const row = rows.find((candidate) => {
      const own = candidate.querySelector("span");
      return own !== null && own.textContent === name;
    });
    return row?.textContent ?? "";
  }, label);
}

/** The radar button of one row, or null when that row does not offer one. */
async function discoverButton(label) {
  const rows = await $$("div.flex.items-center");
  for (const row of rows) {
    const own = await row.$("span");
    if (!(await own.isExisting()) || (await own.getText()) !== label) continue;
    const buttons = await row.$$("button");
    for (const button of buttons) {
      if ((await button.getAttribute("title"))?.toLowerCase().includes("what is running")) return button;
    }
  }
  return null;
}

/** The first row offering an install, or null when none does on this machine. */
async function installRow() {
  const rows = await $$("div.flex.items-center");
  for (const row of rows) {
    const buttons = await row.$$("button");
    for (const button of buttons) {
      if ((await button.getAttribute("title")) === "Install it for me") return row;
    }
  }
  return null;
}

describe("Cloud", () => {
  const saved = {};
  let project = "";

  before(async () => {
    saved.providers = backupOf(providersFile);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(PROBE_SCRIPT, PROBE_SOURCE);
    fs.writeFileSync(providersFile, JSON.stringify(PROBE_PROVIDER, null, 2));

    project = fs.mkdtempSync(path.join(os.tmpdir(), "aime-cloud-"));
    // A note of the user's own, so the splice can be proved not to eat it.
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# Notes\n\nDo not rename the store keys.\n");
    fs.writeFileSync(path.join(project, "package.json"), '{ "name": "cloud-probe" }\n');

    await browser.execute((recent) => {
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
      localStorage.setItem("aime.provider", "cloud-probe");
      localStorage.setItem("aime.theme", "dark");
    }, project);
    await browser.refresh();
    await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes("recent"), {
      timeout: 30_000,
      timeoutMsg: "the welcome screen never rendered",
    });
    await (await $(`span=${project.split(/[\\/]/).pop()}`)).click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("package.json"), {
      timeout: 30_000,
      timeoutMsg: "the throwaway project never opened",
    });

    await browser.keys(["Control", ","]);
    // The probes shell out to cloud CLIs, two of which ask the cloud who you
    // are over the network, so the rows arrive late by design.
    await browser.waitUntil(async () => (await cloudRow("Azure")) !== "", {
      timeout: 60_000,
      timeoutMsg: "the cloud rows never arrived",
    });
  });

  after(() => {
    restore(providersFile, saved.providers);
    fs.rmSync(PROBE_SCRIPT, { force: true });
    try {
      if (project !== "") fs.rmSync(project, { recursive: true, force: true });
    } catch {
      // Windows still holds the folder the app has open as its project, watcher
      // and all. Leaving a temp folder behind is worth less than failing a
      // suite over the cleanup of something the temp sweep collects anyway.
    }
  });

  it("tells every cloud's own truth: the account, or the command that gets there", async () => {
    for (const label of ["Azure", "AWS", "Google Cloud", "Supabase"]) {
      const row = await cloudRow(label);
      assert.ok(row.includes(label), `no row for ${label}`);
      assert.ok(row.replace(label, "").trim().length > 0, `the ${label} row offers nothing: "${row}"`);
    }
  });

  it("asks before installing anything, and takes no for an answer", async () => {
    // Never clicks Install: that would put a cloud SDK on the machine running
    // the suite. What is proved here is the half that matters - the question
    // is asked, it carries the exact command, and declining changes nothing.
    const row = await installRow();
    if (row === null) {
      // Every CLI is already here, or no package manager can carry the ones
      // that are not. Then the rows must still say how to get them by hand.
      for (const label of ["Google Cloud", "Supabase"]) {
        const text = await cloudRow(label);
        assert.ok(text.length > label.length, `the ${label} row says nothing about its CLI`);
      }
      return;
    }

    await (await row.$("button")).click();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.textContent ?? "")).includes("Install with:"),
      { timeout: 10_000, timeoutMsg: "the download button installed without asking" },
    );
    // Whatever the offer is on this machine - a package manager command, or a
    // release archive Aime fetches itself - the question has to name it. Anchored
    // to the row's own hint rather than to the word "winget", which would be an
    // assertion about this machine rather than about the feature.
    const question = await browser.execute(() => document.body.textContent ?? "");
    assert.match(question, /Install with: \S+/, `the confirmation does not say what it would run: ${question.slice(0, 200)}`);

    // Declining leaves the row exactly as it was, and nothing gets installed.
    await (await $('button[title="Leave it"]')).click();
    await browser.waitUntil(
      async () =>
        !(await browser.execute(() => document.body.textContent ?? "")).includes("Install with:"),
      { timeout: 10_000, timeoutMsg: "the question stayed on screen after declining" },
    );
  });

  it("writes what the discovery found into the project's own memory file", async () => {
    const button = await discoverButton("Azure");
    if (button === null) {
      // No signed-in cloud CLI on this machine. The honest behaviour then is
      // that the row says how to get there, and that is what gets checked -
      // never a quiet pass.
      const row = await cloudRow("Azure");
      assert.match(row, /az /, `with no signed-in CLI the row must show the way in: "${row}"`);
      return;
    }

    await button.click();
    const memory = path.join(project, "AGENTS.md");
    await browser.waitUntil(() => fs.readFileSync(memory, "utf8").includes("probe-web"), {
      timeout: 120_000,
      timeoutMsg: "the discovery never reached the project's memory file",
    });

    const written = fs.readFileSync(memory, "utf8");
    // Exact names, because a later command has to be able to use them.
    assert.match(written, /probe-web/, "the service is missing from the memory file");
    assert.match(written, /southeastasia \/ rg-probe/, "where it lives is missing");
    assert.match(written, /GitHub Actions pushes the container/, "how it deploys is missing");
    // The half that keeps the note honest: what the discovery could not see.
    assert.match(written, /no permission to list key vaults/, "the stated gap is missing");
    // And the user's own note is still there, which is the whole reason this
    // is a splice into a marked section rather than an append.
    assert.match(written, /Do not rename the store keys\./, "the discovery ate the user's own note");

    // Claude reads the project file through an import Aime maintains, so a
    // note it cannot see is a note that does not exist for half the CLIs.
    const bridge = path.join(project, "CLAUDE.md");
    assert.ok(fs.existsSync(bridge), "the CLAUDE.md import was not refreshed");
    assert.match(fs.readFileSync(bridge, "utf8"), /AGENTS\.md/, "the bridge does not import AGENTS.md");
  });

  it("replaces its own section instead of stacking a second one", async () => {
    const button = await discoverButton("Azure");
    if (button === null) return;

    await button.click();
    const memory = path.join(project, "AGENTS.md");
    await browser.waitUntil(
      () => (fs.readFileSync(memory, "utf8").match(/aime:cloud/g) ?? []).length === 2,
      {
        timeout: 120_000,
        timeoutMsg: "a second discovery did not leave exactly one managed section",
      },
    );
    // A stale map left above a fresh one is the worst outcome available here:
    // the AI would read the older one first and answer from it.
    const written = fs.readFileSync(memory, "utf8");
    assert.equal((written.match(/probe-web/g) ?? []).length, 1, "the service is listed twice");
  });
});
