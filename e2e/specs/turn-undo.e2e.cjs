/**
 * Undoing an AI turn in a folder that holds several repositories.
 *
 * A checkpoint is git's: `stash create` in a repository, before the turn. A
 * product folder - a frontend and a backend side by side - is not a
 * repository, so until 2026-09-25 a turn there took no checkpoint at all and
 * the chat offered no undo, however many files the AI had just rewritten.
 *
 * The "AI CLI" is a `providers.json` entry pointing at a script this spec
 * writes: it edits a file in each repository, makes one up, and answers. The
 * checks are against the disk, never against the words on screen - and the
 * work the user had not committed before the turn has to survive the undo.
 */
const { strict: assert } = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const configDir = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor");
const providersFile = path.join(configDir, "providers.json");

const PROBE_ID = "turn-undo-probe";
const PROBE_SCRIPT = path.join(os.tmpdir(), "aime-turn-undo-probe.cjs");

const NEWLINE = String.fromCharCode(10);

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-undo-"));
const product = path.join(base, "IODM");
const backend = path.join(product, "Backend");
const frontend = path.join(product, "Frontend");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function repository(root, files) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "e2e@aime.test");
  git(root, "config", "user.name", "Aime E2E");
  // Byte for byte: a global autocrlf would hand the restored files back as CRLF.
  git(root, "config", "core.autocrlf", "false");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
}

repository(backend, { "api/main.rs": `fn main() {}${NEWLINE}` });
repository(frontend, {
  "src/app.ts": `export const app = 1;${NEWLINE}`,
  "README.md": `# Frontend${NEWLINE}`,
});
// What the user was in the middle of before asking: a change and a new file.
const UNCOMMITTED = `# Frontend${NEWLINE}${NEWLINE}work in progress${NEWLINE}`;
fs.writeFileSync(path.join(frontend, "README.md"), UNCOMMITTED);
fs.writeFileSync(path.join(frontend, "src", "draft.ts"), `// mine${NEWLINE}`);

/** The turn: one edit per repository and a file it made up, then an answer. */
const PROBE_SOURCE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'fs.readFileSync(0, "utf8");',
  "const at = (...parts) => path.join(process.cwd(), ...parts);",
  'fs.writeFileSync(at("Backend", "api", "main.rs"), "fn main() { rewritten(); }\\n");',
  'fs.writeFileSync(at("Backend", "api", "extra.rs"), "// made up\\n");',
  'fs.writeFileSync(at("Frontend", "src", "app.ts"), "export const app = 2;\\n");',
  'process.stdout.write(JSON.stringify({ text: "Rewrote both sides." }) + "\\n");',
].join(NEWLINE);

const PROBE_PROVIDER = [
  {
    id: PROBE_ID,
    displayName: "Turn Undo Probe",
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
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

async function waitForText(text, message, timeout = 30_000) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout,
    timeoutMsg: `${message} (looked for "${text}")`,
  });
}

describe("Undoing an AI turn across repositories", () => {
  const saved = { providers: null, provider: null };

  before(async () => {
    saved.providers = backupOf(providersFile);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(providersFile, JSON.stringify(PROBE_PROVIDER, null, 2));
    fs.writeFileSync(PROBE_SCRIPT, PROBE_SOURCE);
    saved.provider = await browser.execute(
      (folder, providerId) => {
        const before = localStorage.getItem("aime.provider");
        localStorage.setItem("aime.provider", providerId);
        localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
        return before;
      },
      product,
      PROBE_ID,
    );
    await browser.refresh();
    await waitForText("recent", "the welcome screen never rendered");
    await (await $(`span=${path.basename(product)}`)).click();
    await waitForText("Frontend", "the product folder never opened");
  });

  after(async () => {
    restore(providersFile, saved.providers);
    fs.rmSync(PROBE_SCRIPT, { force: true });
    await browser.execute((before) => {
      if (before === null) localStorage.removeItem("aime.provider");
      else localStorage.setItem("aime.provider", before);
    }, saved.provider);
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on the folder the app has open; the temp sweep gets it.
    }
  });

  it("puts every repository back, and keeps what the user had not committed", async () => {
    const box = await $("textarea[placeholder]");
    await box.click();
    await browser.keys("rewrite both sides".split(""));
    await browser.keys(["Enter"]);

    await waitForText("changed 3 file(s)", "the turn never said what it changed", 60_000);
    assert.equal(
      read(frontend, "src", "app.ts"),
      `export const app = 2;${NEWLINE}`,
      "the turn wrote nothing",
    );

    await (await $("button*=Undo this turn")).click();
    await waitForText("3 file(s) put back", "the undo never reported back");

    assert.equal(read(backend, "api", "main.rs"), `fn main() {}${NEWLINE}`, "Backend was not put back");
    assert.equal(
      read(frontend, "src", "app.ts"),
      `export const app = 1;${NEWLINE}`,
      "Frontend was not put back",
    );
    assert.ok(
      !fs.existsSync(path.join(backend, "api", "extra.rs")),
      "the file the turn made up is still there",
    );
    // The user's own work from before the turn is not the turn's to take back.
    assert.equal(
      read(frontend, "README.md"),
      UNCOMMITTED,
      "the user's uncommitted change went with the undo",
    );
    assert.ok(
      fs.existsSync(path.join(frontend, "src", "draft.ts")),
      "the user's own new file went with the undo",
    );
  });
});
