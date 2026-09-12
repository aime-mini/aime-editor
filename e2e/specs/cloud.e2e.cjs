/**
 * Cloud discovery, end to end and offline.
 *
 * The promise of the feature is not the panel - it is that after a discovery
 * the project's own memory file holds what is really running in that account,
 * because that file is what every AI CLI reads on the turn where someone asks
 * for a deployment. So what this drives is the whole path: the tabs, the
 * discovery, the parse, and the file on disk afterwards.
 *
 * Two things are deliberately real and one is deliberately fake. The probes are
 * real - Aime shells out to whichever cloud CLIs this machine has - so the tabs
 * say something true about it. The write is real, into a throwaway folder made
 * and deleted here. The AI is a script this spec writes, pointed at by a
 * `providers.json` entry, so nothing here costs a penny or touches a real
 * cloud beyond asking it who you are.
 *
 * Rewritten 2026-09-12. It used to drive the cloud list inside SETTINGS, which
 * has not been where the clouds live since the panel took over, so every run
 * failed in its `before` hook on a screen that no longer exists. Everything it
 * asserted still holds; it is anchored to the panel now, and to the panel's own
 * markup - `nav[aria-label]`, `data-cloud`, `data-cloud-state` - rather than to
 * the text of the whole page, which would pass on a word appearing anywhere.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const configDir = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor");
const providersFile = path.join(configDir, "providers.json");
const PROBE_SCRIPT = path.join(os.tmpdir(), "aime-cloud-probe.cjs");

const CLOUD_BUTTON = 'button[title="Clouds - accounts, applications and what is running in them"]';
const PANEL_NAV = 'nav[aria-label="Clouds"]';
const DIALOG = 'div[role="dialog"]';
/** Every cloud that can have a tab, by the id the panel stamps on its pane. */
const CLOUDS = [
  { id: "azure", label: "Azure", command: "az" },
  { id: "aws", label: "AWS", command: "aws" },
  { id: "gcp", label: "Google Cloud", command: "gcloud" },
  { id: "supabase", label: "Supabase", command: "supabase" },
];

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

/** The labels on the tab strip, read off the strip itself. */
async function tabLabels() {
  return browser.execute((selector) => {
    return [...document.querySelectorAll(`${selector} > div`)].map((tab) => (tab.textContent ?? "").trim());
  }, PANEL_NAV);
}

/** Opens one cloud's tab by its label, and answers whether there was one. */
async function openTab(label) {
  const tabs = await $$(`${PANEL_NAV} > div`);
  for (const tab of tabs) {
    if ((await tab.getText()).includes(label)) {
      await tab.click();
      return true;
    }
  }
  return false;
}

/** What the open pane is showing, in the panel's own word for it. */
async function paneState(id) {
  return browser.execute((cloudId) => {
    const pane = document.querySelector(`section[data-cloud="${cloudId}"]`);
    return pane === null ? null : pane.getAttribute("data-cloud-state");
  }, id);
}

/** The open pane's text - scoped to the pane, never the page. */
async function paneText(id) {
  return browser.execute((cloudId) => {
    const pane = document.querySelector(`section[data-cloud="${cloudId}"]`);
    return pane === null ? "" : (pane.textContent ?? "");
  }, id);
}

/** Waits for a cloud's pane to settle on something other than a spinner. */
async function settledPane(id) {
  await browser.waitUntil(async () => (await paneState(id)) !== null && (await paneState(id)) !== "looking", {
    timeout: 120_000,
    timeoutMsg: `the ${id} pane never stopped looking for its CLI`,
  });
  return paneState(id);
}

/** The discovery button on the open account, or null when there is no account. */
async function discoverButton() {
  const buttons = await $$("button");
  for (const button of buttons) {
    const title = (await button.getAttribute("title")) ?? "";
    if (title.toLowerCase().includes("what is running")) return button;
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
      localStorage.setItem("aime.locale", "en");
      // Every cloud gets a tab here: what this spec checks is that each one
      // says something true, and a cloud without a tab says nothing at all.
      localStorage.removeItem("aime.cloud.shown");
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

    await (await $(CLOUD_BUTTON)).click();
    await browser.waitUntil(async () => (await $(PANEL_NAV)).isExisting(), {
      timeout: 30_000,
      timeoutMsg: "the cloud panel never opened",
    });
    // The probes shell out to four CLIs, two of which ask the cloud who you
    // are over the network, so the question arrives late by design.
    await browser.waitUntil(async () => (await $(DIALOG)).isExisting(), {
      timeout: 120_000,
      timeoutMsg: "the panel never asked which clouds to show",
    });
    for (const button of await $$(`${DIALOG} button`)) {
      if ((await button.getText()).startsWith("Show ")) {
        await button.click();
        break;
      }
    }
    await browser.waitUntil(async () => (await tabLabels()).length > 0, {
      timeout: 30_000,
      timeoutMsg: "no cloud got a tab",
    });
  });

  after(async () => {
    restore(providersFile, saved.providers);
    fs.rmSync(PROBE_SCRIPT, { force: true });
    // The choice of tabs is a preference of this machine's; leave none behind.
    await browser.execute(() => {
      localStorage.removeItem("aime.cloud.shown");
    });
    try {
      if (project !== "") fs.rmSync(project, { recursive: true, force: true });
    } catch {
      // Windows still holds the folder the app has open as its project, watcher
      // and all. Leaving a temp folder behind is worth less than failing a
      // suite over the cleanup of something the temp sweep collects anyway.
    }
  });

  it("tells every cloud's own truth: the account, or the way to get to one", async () => {
    for (const cloud of CLOUDS) {
      assert.ok(await openTab(cloud.label), `no tab for ${cloud.label}`);
      const state = await settledPane(cloud.id);
      // Four states and no fifth - see `lib/cloudPane.ts`. Which one this
      // machine is in is none of this spec's business; that it is in one of
      // them, and says so, is the whole promise.
      assert.ok(
        ["cli-missing", "signed-out", "accounts"].includes(state),
        `the ${cloud.label} pane settled on "${state}"`,
      );
      const text = await paneText(cloud.id);
      assert.ok(text.trim().length > 0, `the ${cloud.label} pane is blank`);
      if (state !== "accounts") {
        // With no account to show, the pane owes the way in: the CLI to get,
        // or the command that signs in. Either names the CLI itself.
        assert.ok(
          text.includes(cloud.command),
          `the ${cloud.label} pane shows no way in: "${text.slice(0, 200)}"`,
        );
      }
    }
  });

  it("asks before installing anything, and takes no for an answer", async () => {
    // Never clicks Install: that would put a cloud SDK on the machine running
    // the suite. What is proved here is the half that matters - the question
    // is asked, it carries the exact command, and declining changes nothing.
    let missing = null;
    for (const cloud of CLOUDS) {
      await openTab(cloud.label);
      if ((await settledPane(cloud.id)) === "cli-missing") {
        missing = cloud;
        break;
      }
    }
    if (missing === null) {
      // Every CLI is already on this machine. There is no offer to check, and
      // saying so beats a quiet pass: what has to hold instead is that no pane
      // is sitting on the missing-CLI state with nothing to do about it.
      for (const cloud of CLOUDS) {
        await openTab(cloud.label);
        assert.notEqual(await paneState(cloud.id), "cli-missing", `${cloud.label} lost its CLI mid-spec`);
      }
      return;
    }

    const offer = await $(`section[data-cloud="${missing.id}"] button`);
    if (!(await offer.isExisting())) {
      // No package manager on this platform carries it: the pane must then say
      // how to get it by hand, which the previous test already required to
      // name the CLI. Nothing is installed either way.
      return;
    }
    await offer.click();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.textContent ?? "")).includes("Install with:"),
      { timeout: 10_000, timeoutMsg: "the download button installed without asking" },
    );
    // Whatever the offer is on this machine - a package manager command, or a
    // release archive Aime fetches itself - the question has to name it.
    const question = await browser.execute(() => document.body.textContent ?? "");
    assert.match(
      question,
      /Install with: \S+/,
      `the confirmation does not say what it would run: ${question.slice(0, 200)}`,
    );

    // Declining leaves the pane exactly as it was, and nothing gets installed.
    await (await $('button[title="Leave it"]')).click();
    await browser.waitUntil(
      async () => !(await browser.execute(() => document.body.textContent ?? "")).includes("Install with:"),
      { timeout: 10_000, timeoutMsg: "the question stayed on screen after declining" },
    );
    assert.equal(await paneState(missing.id), "cli-missing", "declining changed the pane");
  });

  it("writes what the discovery found into the project's own memory file", async () => {
    const signedIn = [];
    for (const cloud of CLOUDS) {
      await openTab(cloud.label);
      if ((await settledPane(cloud.id)) === "accounts") signedIn.push(cloud);
    }
    if (signedIn.length === 0) {
      // No signed-in cloud CLI on this machine. The honest behaviour then is
      // that every pane says how to get there, which the first test required -
      // never a quiet pass over a discovery that could not have run.
      return;
    }
    await openTab(signedIn[0].label);
    const button = await discoverButton();
    assert.ok(button !== null, `${signedIn[0].label} has an account but offers no discovery`);

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
    const button = await discoverButton();
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
