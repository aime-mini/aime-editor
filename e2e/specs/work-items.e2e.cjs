/**
 * The work items panel, end to end: connected through the real form, listed by
 * the real Rust connector over real HTTP, and tied to a real git repository.
 *
 * The board under test is a stand-in Azure DevOps served from this file, which
 * is what the connection's optional server URL exists for (Azure DevOps Server
 * lives under a company URL too). It answers the exact three requests a refresh
 * makes and records what it was asked, so the spec can prove the token rode
 * along and that the state filter was built from the project's own process
 * template rather than from a guess.
 *
 * The stand-in also plays the failure that matters most: a token the service
 * has stopped accepting, which Azure DevOps reports as a 302 to its sign-in
 * page (measured 2026-08-18) and not as a 401.
 *
 * It also proves the rule that a board belongs to a project: a second repository
 * opened in the same app shows no board until it is pointed at one, and pointing
 * it there leaves the first repository's binding alone.
 *
 * The user's own `trackers.json` and `api-keys.json` are restored on the way
 * out, including the case where they did not exist.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const configDir = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor");
const trackersFile = path.join(configDir, "trackers.json");
const keysFile = path.join(configDir, "api-keys.json");

const ORGANIZATION = "aime-probe";
const PROJECT = "Probe";
const TOKEN = "pat-e2e-1";

/**
 * Two types with vocabularies no Azure default uses, so nothing can pass by
 * recognising "Active" or "Closed": only reading this template can work.
 */
const WORK_ITEM_TYPES = {
  count: 2,
  value: [
    {
      name: "Bug",
      states: [
        { name: "Committed", category: "InProgress" },
        { name: "Shipped", category: "Completed" },
      ],
    },
    {
      name: "Task",
      states: [
        { name: "Parked", category: "Proposed" },
        { name: "Doing", category: "InProgress" },
        { name: "Shipped", category: "Completed" },
      ],
    },
  ],
};

const ITEMS = {
  42: {
    id: 42,
    fields: {
      "System.Title": "Login screen forgets the language",
      "System.State": "Committed",
      "System.WorkItemType": "Bug",
      // Two different boards and one sprint, so the panel has something real to
      // group by - and a parent that is deliberately *not* in the list, which is
      // the normal case: the story is somebody else's item.
      "System.AreaPath": "Probe\\Accounts",
      "System.IterationPath": "Probe\\Sprint 24",
      "System.Parent": 100,
      "System.AssignedTo": { displayName: "Linh Pham" },
      // The shape a real ticket arrives in: a sentence, a heading, and steps as
      // a list. Dropping the markup used to glue the heading to the first step.
      "System.Description":
        "<div>The picker resets after a reload.<br>Since&nbsp;Monday.</div>" +
        "<b>Steps to reproduce</b><ul><li>Open /login</li><li>Submit</li></ul>",
    },
  },
  7: {
    id: 7,
    fields: {
      "System.Title": "Add a keyboard shortcut",
      "System.State": "Parked",
      "System.WorkItemType": "Task",
      "System.AreaPath": "Probe\\Collections",
    },
  },
  // Nothing moves this one, which is what makes it useful: the state test leaves
  // items 42 and 7 both in progress, so without a third item "grouped by status"
  // would have a single heading and prove nothing.
  9: {
    id: 9,
    fields: {
      "System.Title": "Rename the export button",
      "System.State": "Parked",
      "System.WorkItemType": "Task",
      "System.AreaPath": "Probe\\Collections",
    },
  },
  100: {
    id: 100,
    fields: {
      "System.Title": "Make the login screen behave",
      "System.State": "Committed",
      "System.WorkItemType": "User Story",
      "System.AreaPath": "Probe\\Accounts",
    },
  },
};

/** The conversation the stand-in keeps, so a posted comment can be read back. */
const COMMENTS = [
  {
    id: 1,
    text: "<div>Reproduced on Firefox as well.</div>",
    createdBy: { displayName: "Mai Tran" },
    createdDate: "2026-08-17T09:00:00Z",
  },
];

/**
 * The stand-in board. `mode` is what the spec flips to make every answer the
 * sign-in redirect an expired token gets.
 */
const board = {
  server: null,
  origin: "",
  mode: "ok",
  /** Milliseconds every answer is held back, so waiting can be observed. */
  delayMs: 0,
  seen: [],
};

function startBoard() {
  return new Promise((resolve) => {
    board.server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        board.seen.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization ?? "",
          contentType: request.headers["content-type"] ?? "",
          body,
        });
        if (board.delayMs === 0) answer(request, response, body);
        else setTimeout(() => answer(request, response, body), board.delayMs);
      });
    });
    board.server.listen(0, "127.0.0.1", () => {
      board.origin = `http://127.0.0.1:${board.server.address().port}`;
      resolve();
    });
  });
}

function answer(request, response, body) {
  if (board.mode === "expired") {
    // Exactly what dev.azure.com sends for a token it will not accept.
    response.writeHead(302, {
      Location: "https://spsprodcus4.vssps.visualstudio.com/_signin",
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end("<html><head><title>Object moved</title></head></html>");
    return;
  }

  const url = request.url ?? "";
  const json = (payload) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };

  const stateOf = (typeName) =>
    WORK_ITEM_TYPES.value.find((type) => type.name === typeName) ?? { states: [] };

  if (url.includes("/states")) {
    const typeName = decodeURIComponent(url.split("/workitemtypes/")[1].split("/")[0]);
    json({ count: stateOf(typeName).states.length, value: stateOf(typeName).states });
    return;
  }
  if (url.includes("/workitemtypes")) {
    json(WORK_ITEM_TYPES);
    return;
  }
  if (url.includes("/wiql")) {
    json({ queryType: "flat", workItems: [{ id: 42 }, { id: 7 }, { id: 9 }] });
    return;
  }
  if (url.includes("/workitemsbatch")) {
    const ids = JSON.parse(body).ids;
    json({ count: ids.length, value: ids.map((id) => ITEMS[id]).filter(Boolean) });
    return;
  }
  if (url.includes("/comments")) {
    // Comments are still a preview resource, and Azure DevOps refuses the plain
    // version with exactly this 400 - what a real organization answered when the
    // item view first went out.
    if (!url.includes("api-version=7.1-preview")) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          message:
            'The requested version "7.1" of the resource is under preview. The -preview flag must ' +
            'be supplied in the api-version for such requests. For example: "7.1-preview".',
        }),
      );
      return;
    }
    if (request.method === "POST") {
      const said = JSON.parse(body).text;
      COMMENTS.push({
        id: COMMENTS.length + 1,
        text: `<div>${said}</div>`,
        createdBy: { displayName: "Linh Pham" },
        createdDate: "2026-08-18T10:00:00Z",
      });
      json(COMMENTS[COMMENTS.length - 1]);
      return;
    }
    json({ count: COMMENTS.length, totalCount: COMMENTS.length, comments: COMMENTS });
    return;
  }
  if (url.includes("/teamsettings/teamfieldvalues")) {
    json({
      field: { referenceName: "System.AreaPath" },
      defaultValue: "Probe",
      values: [{ value: "Probe", includeChildren: true }],
    });
    return;
  }
  const single = url.match(/\/workitems\/(\d+)/);
  if (single !== null) {
    const item = ITEMS[Number(single[1])];
    if (request.method === "PATCH") {
      // The service answers with the item as it now is, so the panel does not
      // have to guess what its own update produced.
      item.fields["System.State"] = JSON.parse(body)[0].value;
    }
    json(item);
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ message: `nothing at ${url}` }));
}

const backupOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const restore = (file, content) => {
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
};

const requestsTo = (fragment) => board.seen.filter((entry) => entry.url.includes(fragment));

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  // A plain string: the driver does not await a function here, and an async one
  // costs the diagnostic exactly when it is needed.
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: `${message ?? "text never appeared"} (looked for "${text}")`,
  });
}

/** Opens a folder the only way a driver can: through the recent list. */
async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
  }, dir);
  await browser.refresh();
  await waitForText("recent", "the welcome screen never rendered");
  await (await $(`span=${dir.split(/[\\/]/).pop()}`)).click();
}

/** A repository with one commit - the panel's branch action needs a real one. */
function repository(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, "readme.md"), "# probe\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "probe@example.com");
  git("config", "user.name", "Probe");
  git("add", ".");
  git("commit", "-m", "first");
  return dir;
}

/** Opens a project and switches the sidebar to its work items. */
async function openWorkItems(dir) {
  await open(dir);
  await waitForText("readme.md", `${dir} never opened`);
  await (await $('button[title="Work items"]')).click();
}

const storeOnDisk = () => JSON.parse(fs.readFileSync(trackersFile, "utf8"));

/**
 * Clicks a button the panel only reveals on hover. The mouse goes to the row
 * first, which is the real path; the JS click is the fallback for a driver that
 * reports a fully transparent element as unclickable.
 */
async function clickAction(row, title) {
  const button = await row.$(`button[title="${title}"]`);
  await row.moveTo();
  try {
    await button.click();
  } catch {
    await browser.execute((element) => element.click(), button);
  }
}

/** The row whose text contains this work item id. */
async function rowFor(id) {
  const rows = await $$("div.group");
  for (const row of rows) {
    if ((await row.getText()).includes(`#${id}`)) return row;
  }
  throw new Error(`no row for work item ${id}`);
}

/**
 * Opens one of the panel's two menus and picks an entry out of it.
 *
 * The settings that are chosen once - how the list is filed, whether finished
 * work counts, what to do with the board itself - live behind these rather than
 * in rows of controls standing over a list they were taller than.
 */
async function chooseFrom(buttonTitle, entry) {
  await (await $(`button[title^="${buttonTitle}"]`)).click();
  const menu = await $("div.z-50");
  await menu.waitForExist({ timeout: 20_000 });
  await (await menu.$(`button*=${entry}`)).click();
}

describe("Work items", () => {
  const saved = { trackers: null, keys: null };
  let repo = "";
  let otherRepo = "";

  before(async () => {
    saved.trackers = backupOf(trackersFile);
    saved.keys = backupOf(keysFile);
    fs.rmSync(trackersFile, { force: true });
    await startBoard();

    // Two real repositories: one to connect, one to prove a board does not
    // follow the user into the next project.
    repo = repository("aime-workitems-");
    otherRepo = repository("aime-workitems-other-");

    await openWorkItems(repo);
    await waitForText("connect a board", "the work items tab never showed its connect form");
  });

  after(() => {
    restore(trackersFile, saved.trackers);
    restore(keysFile, saved.keys);
    board.server?.close();
    for (const dir of [repo, otherRepo]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows keeps a handle on the folder the app has open; best effort.
      }
    }
  });

  it("builds the connect form out of whatever the service declares", async () => {
    // Two connectors are registered, and the panel has never heard of either:
    // the fields, their examples and the name of the credential all arrive from
    // Rust. Switching services is the proof - nothing in the UI knows that Jira
    // needs an account email and Azure DevOps does not.
    const services = await $("select");
    assert.equal(await $('input[placeholder="contoso"]').isExisting(), true, "no organization field");

    await services.selectByVisibleText("Jira Cloud");
    await waitForText("api token", "the credential kept Azure DevOps' name");
    assert.equal(await $('input[placeholder="your-team.atlassian.net"]').isExisting(), true);
    assert.equal(await $('input[placeholder="you@company.com"]').isExisting(), true);
    assert.equal(
      await $('input[placeholder="contoso"]').isExisting(),
      false,
      "a field belonging to the other service stayed on screen",
    );

    // The same product self-hosted is a different connector: a company URL, a
    // personal access token, and no account email to give.
    await services.selectByVisibleText("Jira Server / Data Center");
    await waitForText("personal access token", "a self-hosted token is not an API token");
    assert.equal(await $('input[placeholder="https://jira.company.com"]').isExisting(), true);
    assert.equal(
      await $('input[placeholder="you@company.com"]').isExisting(),
      false,
      "a self-hosted token authenticates on its own, so no email may be asked for",
    );

    // GitHub: a repository if you want one, and an API URL only if your GitHub
    // is your company's own.
    await services.selectByVisibleText("GitHub");
    assert.equal(await $('input[placeholder="owner/name"]').isExisting(), true);
    assert.equal(await $('input[placeholder="https://api.github.com"]').isExisting(), true);
    assert.equal(
      await $('input[placeholder="you@company.com"]').isExisting(),
      false,
      "GitHub asks for no email either",
    );

    // A fifth service, asking for less than any of the others: nothing but a
    // workspace, and it may be left empty.
    await services.selectByVisibleText("ClickUp");
    assert.equal(await $('input[placeholder="My Workspace"]').isExisting(), true);
    assert.equal(
      await $('input[placeholder="you@company.com"]').isExisting(),
      false,
      "ClickUp needs no account email, and the form must not ask for one",
    );

    // Back to the service the rest of this spec drives.
    await services.selectByVisibleText("Azure DevOps");
    await waitForText("personal access token", "the form did not return to Azure DevOps");
  });

  it("connects by querying the board, and only stores what worked", async () => {
    await (await $('input[placeholder="contoso"]')).setValue(ORGANIZATION);
    await (await $('input[placeholder="Contoso Web"]')).setValue(PROJECT);
    await (await $('input[placeholder="https://dev.azure.com"]')).setValue(board.origin);
    await (await $('input[type="password"]')).setValue(TOKEN);
    // Enter finishes the form; the Connect button runs the same submit.
    await browser.keys("Enter");

    // How the list is filed is the grouping test's business; this one is about the
    // connect flow, so it only asks that both items arrived.
    await waitForText("login screen forgets", "the board's items never reached the panel");
    await waitForText("add a keyboard shortcut", "the second item is missing");

    // The token rode along as basic auth with an empty user name.
    const wiql = requestsTo("/wiql")[0];
    assert.ok(wiql, "no query was ever sent");
    assert.equal(
      wiql.authorization,
      `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`,
      "the token did not reach the service as Azure DevOps takes it",
    );
    // The filter was built from this template's own words, not from Azure's.
    assert.match(
      wiql.body,
      /NOT IN \('Shipped'\)/,
      `the finished states were not read from the process template: ${wiql.body}`,
    );

    const store = storeOnDisk();
    assert.equal(store.connections.length, 1, "the connection was not stored");
    assert.equal(store.connections[0].settings.project, PROJECT);
    assert.equal(store.connections[0].settings.serverUrl, board.origin);
    assert.equal(
      JSON.stringify(store).includes(TOKEN),
      false,
      "the token must never be written next to the settings",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(keysFile, "utf8"))[`tracker:${store.connections[0].id}`],
      TOKEN,
      "the token never reached the secret store",
    );
    // Connecting is what binds this project to the board it just proved works.
    assert.deepEqual(
      Object.entries(store.workspaces),
      [[repo, store.connections[0].id]],
      "the board was not bound to the project that connected it",
    );
  });

  it("refuses a connection the board rejects, and stores nothing", async () => {
    const before = fs.readFileSync(trackersFile, "utf8");
    board.mode = "expired";
    await (await $('button[title="Refresh"]')).click();

    await waitForText("refused the credential", "an expired token was not reported as one");
    await waitForText("reconnect", "the panel did not offer the one fix there is");
    assert.equal(fs.readFileSync(trackersFile, "utf8"), before, "a failed refresh changed what is stored");

    board.mode = "ok";
    await (await $('button[title="Refresh"]')).click();
    await waitForText("login screen forgets", "the panel never recovered once the board answered again");
  });

  it("starts the branch an item suggests, in the real repository", async () => {
    const row = await rowFor(42);
    await clickAction(row, "Start a branch for this item");
    await waitForText("branch for #42", "the branch dialog never opened");

    const input = await $("div.w-80 input");
    assert.equal(
      await input.getValue(),
      "bugfix/42-login-screen-forgets-the-language",
      "the suggested branch name is not the one a person would type",
    );
    await (await $("button=OK")).click();

    await browser.waitUntil(
      () =>
        execFileSync("git", ["branch", "--show-current"], { cwd: repo }).toString().trim() ===
        "bugfix/42-login-screen-forgets-the-language",
      { timeout: 20_000, timeoutMsg: "the branch was never created in the repository" },
    );
  });

  it("says so when git refuses the branch, in the panel that asked for it", async () => {
    const row = await rowFor(7);
    await clickAction(row, "Start a branch for this item");
    await waitForText("branch for #7", "the branch dialog never opened");

    // `main` exists, so git refuses - and the click happened here, so the
    // refusal has to appear here and not only in the Git panel.
    const input = await $("div.w-80 input");
    await input.setValue("main");
    await (await $("button=OK")).click();
    await waitForText("already exists", "a branch git refused was reported nowhere");
  });

  it("moves an item to a state the board itself offered", async () => {
    const row = await rowFor(7);
    await (await row.$('button[title="Change state"]')).click();
    // The list is the process template's, so "Doing" can only come from it.
    await waitForText("doing", "the states were not read from the service");

    const states = await row.$$("button");
    for (const state of states) {
      if ((await state.getText()) === "Doing") {
        await state.click();
        break;
      }
    }

    await browser.waitUntil(async () => (await (await rowFor(7)).getText()).includes("Doing"), {
      timeout: 20_000,
      timeoutMsg: "the row never showed the new state",
    });

    // The buttons sitting on a row do their own job and nothing else. The row
    // itself opens the item, so without that being stopped, every state change
    // would take over the editor as well.
    // Counted among item rows only: a terminal tab is a `div.group` that marks
    // itself the same way.
    const opened = await browser.execute(() =>
      [...document.querySelectorAll("div.group")]
        .filter((row) => (row.textContent ?? "").trim().startsWith("#"))
        .filter((row) => row.className.split(/\s+/).includes("bg-elevated"))
        .map((row) => (row.textContent ?? "").trim().slice(0, 40)),
    );
    assert.deepEqual(opened, [], "changing a state also opened the item");

    const patch = requestsTo("/workitems/7").find((entry) => entry.method === "PATCH");
    assert.ok(patch, "no update was sent");
    assert.equal(
      patch.contentType,
      "application/json-patch+json",
      "Azure DevOps refuses a work item update sent as plain JSON",
    );
    assert.deepEqual(JSON.parse(patch.body), [{ op: "add", path: "/fields/System.State", value: "Doing" }]);
  });

  it("hands the item to the AI with its description as plain text", async () => {
    const row = await rowFor(42);
    await clickAction(row, "Work on this with AI");

    // The prompt goes into the AI panel, which is where a turn starts; the CLI
    // behind it is not this spec's business, only what was handed over.
    await waitForText("work item #42", "the item never reached the AI panel");
    await waitForText("the picker resets after a reload", "the description never reached the prompt");
    const chat = await $("body").getText();
    assert.equal(chat.includes("&nbsp;"), false, "raw markup reached the prompt");
    assert.equal(chat.includes("<div>"), false, "raw markup reached the prompt");
  });

  it("opens an item in the middle of the window, with its facts and its conversation", async () => {
    // Clicked on the item's *type*, the far corner of the row: the whole row is
    // the target, not just its title line. That line used to be the only live
    // part of a row the hover highlight covers entirely.
    await (await (await rowFor(42)).$('span[title="Bug"]')).click();

    // The middle of the window, not the sidebar: this is where a description and
    // a conversation have room to be read.
    await waitForText("the picker resets after a reload", "the item's text never arrived");
    await waitForText("make the login screen behave", "the item did not say what it belongs to");
    await waitForText("linh pham", "the facts the service holds were not shown");
    await waitForText("reproduced on firefox", "the conversation was not read");

    // The list marks the item that is on screen: the two halves are one view of
    // one board, and a sidebar that does not say where you are is a sidebar you
    // lose your place in.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const row = [...document.querySelectorAll("div.group")].find((candidate) =>
            (candidate.textContent ?? "").trim().startsWith("#42"),
          );
          // Split on spaces: `hover:bg-elevated` is on every row.
          return row !== undefined && row.className.split(/\s+/).includes("bg-elevated");
        }),
      { timeout: 20_000, timeoutMsg: "the row of the item on screen was not marked as open" },
    );
  });

  it("reads the description as the structure it was written with", async () => {
    // The item opened by the test before this one is still on screen. Its
    // description carries a heading and two steps; the panel used to drop the
    // markup, which ran the heading into the first step and lost the steps.
    // Read out of the description section itself: the AI panel above still holds
    // the prompt from an earlier test, description and all, so anything read off
    // the whole page would pass whether this section rendered or not.
    const described = await browser.execute(() => {
      const section = [...document.querySelectorAll("section")].find(
        (candidate) => (candidate.querySelector("h2")?.textContent ?? "").trim() === "Description",
      );
      return {
        steps: [...(section?.querySelectorAll("li") ?? [])].map((li) => (li.textContent ?? "").trim()),
        emphasised: [...(section?.querySelectorAll("strong") ?? [])].map((one) => one.textContent ?? ""),
        text: section?.textContent ?? "",
      };
    });

    assert.equal(described.steps.length, 2, `the steps did not survive as a list: ${described.text}`);
    assert.ok(described.steps[0].includes("Open /login"), `the first step reads "${described.steps[0]}"`);
    assert.ok(described.steps[1].includes("Submit"), `the second step reads "${described.steps[1]}"`);
    assert.deepEqual(
      described.emphasised,
      ["Steps to reproduce"],
      "the heading was not rendered as the emphasis it was written as",
    );
    assert.equal(
      described.text.includes("reproduceOpen"),
      false,
      "the heading was glued to the step under it, which is what losing the markup does",
    );
    assert.equal(
      described.text.includes("**"),
      false,
      "raw Markdown reached the screen instead of being rendered",
    );
  });

  it("says something on the item, and reads it back from the board", async () => {
    const box = await $("textarea");
    await box.setValue("Fixed on the language branch.");
    await (await $("button=Comment")).click();

    await waitForText("fixed on the language branch", "the comment never came back from the board");
    const posted = requestsTo("/comments").find((seen) => seen.method === "POST");
    assert.ok(posted, "nothing was sent");
    assert.deepEqual(JSON.parse(posted.body), { text: "Fixed on the language branch." });
    assert.equal(await $("textarea").getValue(), "", "the box must clear once the board has it");
  });

  it("files the list by the thing the items differ along, and lets that be changed", async () => {
    // Read off the headings themselves, not off the page: the item opened by the
    // test before this one is still on screen and names its board too, so a text
    // search would pass whether the list is grouped or not.
    const headings = () =>
      browser.execute(() =>
        [...document.querySelectorAll("section")]
          .map((section) => section.querySelector(":scope > button > span[title]"))
          .filter((span) => span !== null)
          .map((span) => span.getAttribute("title") ?? ""),
      );
    const headingsAre = async (expected, message) => {
      await browser.waitUntil(async () => (await headings()).join(" | ") === expected.join(" | "), {
        timeout: 20_000,
        timeoutMsg: `${message} (headings: ${(await headings()).join(" | ")})`,
      });
    };

    // Two items on two different boards: that is the cut worth taking, and the
    // panel took it without being told.
    await headingsAre(["Accounts", "Collections"], "the list was not filed by board on its own");

    await chooseFrom("How the list is filed", "Grouped by status");
    await headingsAre(["In progress", "To do"], "grouping by status did not take");

    await chooseFrom("How the list is filed", "Grouped by what it belongs to");
    await headingsAre(
      ["Make the login screen behave", "Not filed"],
      "grouping by parent did not take, or the item under nothing lost its heading",
    );

    await chooseFrom("How the list is filed", "Grouped by Board");
  });

  it("leads with the board this repository is about, and follows it to the next one", async () => {
    // Nothing was configured for this. Earlier in this spec the panel created the
    // branch item 42 suggests and checked it out; item 42 is filed under
    // Accounts; so Accounts is the board this repository is about, and it says so
    // where the reader is looking.
    // One string per heading, in the order they are on screen; a star is the
    // "this project" mark the panel puts on the one it opened first.
    const headings = () =>
      browser.execute(() =>
        [...document.querySelectorAll("section")]
          .map((section) => section.querySelector(":scope > button"))
          .filter((button) => button !== null)
          .map(
            (button) =>
              (button.querySelector("span[title]")?.getAttribute("title") ?? "") +
              ((button.textContent ?? "").includes("this project") ? " *" : ""),
          ),
      );
    const leadIs = async (expected, message) => {
      await browser.waitUntil(async () => (await headings()).join(" | ") === expected.join(" | "), {
        timeout: 20_000,
        timeoutMsg: `${message} (headings: ${(await headings()).join(" | ")})`,
      });
    };
    await leadIs(
      ["Accounts *", "Collections"],
      "the board this repository has a branch for did not lead, or was not marked",
    );

    // Start work on an item from the other board: the same evidence now points
    // the other way, and the panel follows without being told twice.
    await clickAction(await rowFor(7), "Start a branch for this item");
    await waitForText("branch for #7", "the branch dialog never opened");
    await (await $("button=OK")).click();
    await leadIs(
      ["Collections *", "Accounts"],
      "checking out a branch for the other board did not move the lead",
    );

    // And the row itself says so. Of everything assigned to this person, the
    // item whose branch is checked out is the one they are working on right now,
    // so it is marked and it is the first row of its heading - never something
    // to scroll for.
    //
    // Item 9 rather than 7 on purpose: 7 is in progress and 9 is only to do, so
    // the reading order of the heading already puts 7 first. Only 9 can show
    // that the branch is what moved it.
    await clickAction(await rowFor(9), "Start a branch for this item");
    await waitForText("branch for #9", "the branch dialog never opened");
    await (await $("button=OK")).click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("feature/9-"), {
      timeout: 20_000,
      timeoutMsg: "the branch for item 9 was never checked out",
    });

    const branchRow = await browser.execute(() => {
      const rows = [...document.querySelectorAll("div.group")].filter((row) =>
        (row.textContent ?? "").trim().startsWith("#"),
      );
      const marked = rows.filter((row) => row.querySelector('span[title*="branch"]') !== null);
      // The id runs straight into the title, so a row is named by its start.
      const idOf = (row) => ((row?.textContent ?? "").trim().match(/^#\S*?(?=[A-Z])/) ?? [""])[0];
      return { marked: marked.map(idOf), first: idOf(rows[0]) };
    });
    assert.deepEqual(branchRow.marked, ["#9"], "the item whose branch is checked out was not marked");
    assert.equal(branchRow.first, "#9", "the item being worked on was not the first row on the board");
  });

  it("filters what is on screen as it is typed, without asking the board again", async () => {
    const asked = requestsTo("/wiql").length;

    // Counted in the list rather than read off the page: the AI panel above still
    // holds the prompt from an earlier test, item title and all - and it has rows
    // of its own, so a row is counted only when it starts with an item id.
    const rows = () =>
      browser.execute(
        () =>
          [...document.querySelectorAll("div.group")].filter((row) =>
            (row.textContent ?? "").trim().startsWith("#"),
          ).length,
      );
    const whole = await rows();
    assert.ok(whole > 1, `the list to filter was not there: ${whole} rows`);

    const box = await $('input[placeholder^="Filter by title"]');
    await box.setValue("keyboard");
    await browser.waitUntil(async () => (await rows()) === 1, {
      timeout: 20_000,
      timeoutMsg: "the filter did not narrow the list to the one item that matches",
    });
    const left = await browser.execute(
      () =>
        [...document.querySelectorAll("div.group")]
          .map((row) => (row.textContent ?? "").trim())
          .find((text) => text.startsWith("#")) ?? "",
    );
    assert.ok(left.includes("Add a keyboard shortcut"), `the wrong row survived: ${left}`);
    assert.equal(requestsTo("/wiql").length, asked, "filtering must not cost a query");

    // Something nothing matches says so, rather than looking empty for no reason.
    await box.setValue("zzzz-nothing");
    await waitForText("nothing here matches", "an empty result did not explain itself");
    await browser.waitUntil(async () => (await rows()) === 0, {
      timeout: 20_000,
      timeoutMsg: "rows stayed on screen under a filter nothing matches",
    });

    // Emptied with real keys: this input is controlled by React state, and
    // neither `setValue("")` nor the driver's clear command makes it notice.
    await box.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("Backspace");
    await browser.waitUntil(async () => (await rows()) === whole, {
      timeout: 20_000,
      timeoutMsg: "clearing the filter did not bring the list back",
    });
  });

  it("asks the board a different question when everyone's work is wanted", async () => {
    await (await $("button=All")).click();
    await browser.waitUntil(() => requestsTo("/wiql").some((seen) => !seen.body.includes("AssignedTo")), {
      timeout: 20_000,
      timeoutMsg: "the query still asked only for one person's work",
    });

    await (await $("button=Mine")).click();
    await browser.waitUntil(
      () => requestsTo("/wiql").slice(-1)[0]?.body.includes("[System.AssignedTo] = @Me") === true,
      { timeout: 20_000, timeoutMsg: "going back to Mine did not ask for one person's work" },
    );
  });

  it("says it is reading, in the list and in the item, instead of looking empty", async () => {
    // A board on a slow morning. Nothing else changes: this is the same panel,
    // answering the same questions, only late enough to be seen doing it.
    board.delayMs = 1_500;
    try {
      // Switching whose work is wanted is a question for the service, so the
      // list is emptied - the exact moment a panel with no sign of life reads as
      // a board with nothing on it.
      await (await $("button=All")).click();
      await waitForText("reading the board", "the emptied list gave no sign it was working");
      await waitForText("rename the export button", "the list never arrived");

      // An item that has not been opened yet, so this is a fresh view and not
      // one already holding the answer.
      await (await (await rowFor(9)).$("button")).click();
      await waitForText("reading the conversation", "the opened item gave no sign it was working");
    } finally {
      board.delayMs = 0;
    }
    await waitForText("reproduced on firefox", "the conversation never arrived");

    await (await $("button=Mine")).click();
    await waitForText("login screen forgets", "going back to Mine lost the list");
  });

  it("says which board lost its token instead of offering a click that cannot work", async () => {
    const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    const entry = `tracker:${storeOnDisk().connections[0].id}`;
    const token = keys[entry];

    // A credential can go missing without Aime doing anything: an edited file,
    // a synced profile, a token revoked and cleared by hand.
    delete keys[entry];
    fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));
    await openWorkItems(otherRepo);
    await waitForText("which board does this project use", "the unbound project did not ask");
    await waitForText("needs its token again", "a board without its token looked ready to pick");

    keys[entry] = token;
    fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));
  });

  it("lets a project stop using a board without the board being forgotten", async () => {
    await openWorkItems(repo);
    await waitForText("login screen forgets", "the first project lost its board");

    await chooseFrom("More actions", "Stop using a board");
    await waitForText("which board does this project use", "unbinding did not bring the picker back");

    const store = storeOnDisk();
    assert.equal(store.connections.length, 1, "the board itself must survive");
    assert.equal(store.workspaces[repo], undefined, "this project must no longer be pointed at it");
    assert.equal(
      JSON.parse(fs.readFileSync(keysFile, "utf8"))[`tracker:${store.connections[0].id}`],
      TOKEN,
      "unbinding is not a disconnect, so the token stays",
    );

    // Put it back, because the tests after this one work on this board.
    await (await $(`button*=${ORGANIZATION}`)).click();
    await waitForText("login screen forgets", "picking the board back did not load it");
  });

  it("keeps every project on its own board", async () => {
    const connectionId = storeOnDisk().connections[0].id;
    await openWorkItems(otherRepo);

    // The credential is the person's, so there is nothing to type again - but
    // this folder has not been pointed at a board, and must not inherit one.
    await waitForText("which board does this project use", "a second project inherited the first's board");
    const body = await $("body").getText();
    assert.equal(
      body.toLowerCase().includes("login screen forgets"),
      false,
      "another project's work items were on screen",
    );
    assert.deepEqual(
      Object.keys(storeOnDisk().workspaces),
      [repo],
      `opening a project must not bind it by itself; stored: ${JSON.stringify(storeOnDisk().workspaces)}`,
    );

    await (await $(`button*=${ORGANIZATION}`)).click();
    await waitForText("login screen forgets", "picking the board did not load its items");
    assert.deepEqual(
      storeOnDisk().workspaces,
      { [repo]: connectionId, [otherRepo]: connectionId },
      "the two projects must each carry their own binding",
    );

    // And the first project still knows its board without being asked again.
    await openWorkItems(repo);
    await waitForText("login screen forgets", "the first project forgot its board");
  });

  it("forgets the token when the connection is disconnected", async () => {
    const stored = storeOnDisk().connections;
    const before = fs.readFileSync(trackersFile, "utf8");
    await chooseFrom("More actions", "Disconnect");

    // Two projects are on this board, so the price is named before it is paid.
    await waitForText("every project pointed at this board", "no warning before forgetting the token");
    assert.equal(
      fs.readFileSync(trackersFile, "utf8"),
      before,
      "the disconnect happened before it was confirmed",
    );
    await (await $("button=OK")).click();

    await browser.waitUntil(() => storeOnDisk().connections.length === 0, {
      timeout: 20_000,
      timeoutMsg: "the connection stayed on disk",
    });
    const keys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
    assert.equal(
      keys[`tracker:${stored[0].id}`],
      undefined,
      "a token left behind after a disconnect is a leaked secret",
    );
    // Both projects were pointed at it, and neither may be left pointing at
    // something that is gone.
    assert.deepEqual(storeOnDisk().workspaces, {}, "a binding survived the board it pointed at");
    await waitForText("connect a board", "the panel did not return to its empty state");
  });
});
