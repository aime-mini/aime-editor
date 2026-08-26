/**
 * The API key path, end to end: stored through the real command, reported by
 * the real health probe, and — the part nothing else can prove — riding the
 * environment of the process Aime itself spawns.
 *
 * The provider under test is a probe written for this spec: a `providers.json`
 * entry whose "CLI" is node printing the very variable the key should arrive
 * in. Proving it with a real key is impossible (there is none to spend), and
 * proving it with an invalid key is unaffordable: measured, `claude -p`
 * retries an invalid ANTHROPIC_API_KEY for ~218 s before giving up.
 *
 * The first probe is written before the session reloads, because the app under
 * test must already know it. The second one is written with the app running on
 * purpose — that is the point of its own test: Aime watches providers.json and
 * re-reads it, so a CLI added mid-session needs no restart. The user's own
 * config files are restored on the way out, including the case where they did
 * not exist.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fill } = require("../support/fields.cjs");

const configDir = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor");
const providersFile = path.join(configDir, "providers.json");
const keysFile = path.join(configDir, "api-keys.json");

/** No `{prompt}`: chat would be useless, but a oneshot only needs stdout. */
const PROBE_PROVIDER = [
  {
    id: "probe-env",
    displayName: "Env Probe",
    command: "node",
    // No spaces and no quotes in the script: every argument crosses `cmd /C`,
    // which does not honour the C runtime's quoting rules.
    args: ["-e", "console.log(process.env.AIME_PROBE_KEY)"],
    parser: "plain",
    apiKeyEnv: "AIME_PROBE_KEY",
    promptStdin: false,
  },
];

/** Where the second probe drops the key it was handed, for the spec to read. */
const SINK = path.join(os.tmpdir(), "aime-cli-login-key.txt");
/** The "CLI" that stores its own key: a script that saves whatever stdin holds. */
const LOGIN_SCRIPT = path.join(os.tmpdir(), "aime-login-probe.cjs");

/**
 * A provider on the other API key route: no variable, a login command of its
 * own. It is a file rather than `node -e …` because the script needs quotes,
 * and every argument here crosses `cmd /C`, which mangles them.
 */
function loginProvider() {
  fs.rmSync(SINK, { force: true });
  fs.writeFileSync(
    LOGIN_SCRIPT,
    `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(SINK)}, fs.readFileSync(0, "utf8"));\n`,
  );
  return {
    id: "probe-login",
    displayName: "Login Probe",
    command: "node",
    args: ["-e", "console.log(0)"],
    parser: "plain",
    login: "probe-login logout",
    apiKeyLoginArgs: [LOGIN_SCRIPT],
    promptStdin: false,
  };
}

const backupOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const restore = (file, content) => {
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
};

/**
 * Calls a Tauri command from inside the window. `browser.execute` does not
 * await a promise (session-12 lesson), so the answer lands on a window flag
 * that `waitUntil` reads back.
 */
async function invoke(command, payload) {
  await browser.execute(
    (cmd, args) => {
      window.__aimeProbe = undefined;
      window.__TAURI_INTERNALS__.invoke(cmd, args).then(
        (value) => (window.__aimeProbe = { ok: true, value }),
        (error) => (window.__aimeProbe = { ok: false, error: String(error) }),
      );
    },
    command,
    payload,
  );
  await browser.waitUntil(async () => browser.execute(() => window.__aimeProbe !== undefined), {
    timeout: 30_000,
    timeoutMsg: `${command} never answered`,
  });
  return browser.execute(() => window.__aimeProbe);
}

async function waitForText(text, message) {
  const needle = text.toLowerCase();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes(needle), {
    timeout: 30_000,
    timeoutMsg: message ?? `never saw "${text}"`,
  });
}

/** Opens a folder the only way a driver can: through the recent list. */
async function open(dir) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
  }, dir);
  await browser.refresh();
  await waitForText("RECENT", "the welcome screen never rendered");
  await (await $(`span=${dir.split(/[\\/]/).pop()}`)).click();
}

describe("API keys", () => {
  const saved = { providers: null, keys: null };
  const projects = [];

  before(async () => {
    saved.providers = backupOf(providersFile);
    saved.keys = backupOf(keysFile);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(providersFile, JSON.stringify(PROBE_PROVIDER, null, 2));
    await browser.reloadSession();
    // Tauri injects its IPC bridge into the boot interstitial too, so probing
    // for it proves nothing - and driver calls against that page fail with
    // origin/permission errors. The app is up when its own document is on
    // screen: the welcome screen here, since a reloaded session does not get
    // the suite's folder argument again. getText throws mid-navigation, which
    // is why the probe swallows rather than aborts.
    await browser.waitUntil(
      async () => {
        try {
          return (await $("body").getText()).toUpperCase().includes("RECENT");
        } catch {
          return false;
        }
      },
      { timeout: 60_000, timeoutMsg: "the reloaded app never rendered" },
    );
  });

  after(() => {
    restore(providersFile, saved.providers);
    restore(keysFile, saved.keys);
    fs.rmSync(SINK, { force: true });
    fs.rmSync(LOGIN_SCRIPT, { force: true });
    for (const dir of projects) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows keeps a handle on the folder the app has open; best effort.
      }
    }
  });

  it("hands a stored key to the provider's own process - and only while stored", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aime-apikey-"));
    projects.push(dir);
    const oneshot = () =>
      invoke("ai_oneshot", { providerId: "probe-env", prompt: "x", cwd: dir, model: null });

    // Before any key: the child must not see the variable at all.
    const bare = await oneshot();
    assert.equal(bare.ok, true, `the probe provider never ran: ${bare.error}`);
    assert.equal(bare.value, "undefined", "no key was configured, yet the child saw one");

    const stored = await invoke("provider_set_api_key", { providerId: "probe-env", key: "probe-key-123" });
    assert.equal(stored.ok, true, `storing the key failed: ${stored.error}`);

    // The health probe cannot see an environment key, so a configured one has
    // to read as signed in on its own authority.
    const health = await invoke("provider_health", { providerId: "probe-env" });
    assert.equal(health.ok, true, `health failed: ${health.error}`);
    assert.equal(health.value.apiKey, true, "health does not know a key is configured");
    assert.equal(health.value.signedIn, true, "a configured key must read as signed in");

    const keyed = await oneshot();
    assert.equal(keyed.value, "probe-key-123", "the stored key never reached the spawned CLI");

    // Clearing must actually clear - a key that lingers is a leak.
    await invoke("provider_set_api_key", { providerId: "probe-env", key: "" });
    const cleared = await oneshot();
    assert.equal(cleared.value, "undefined", "a removed key kept riding along");
  });

  it("saves a key typed into Settings, and never shows it back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aime-apikey-ui-"));
    projects.push(dir);
    fs.writeFileSync(path.join(dir, "readme.md"), "# probe\n");
    await open(dir);
    await waitForText("readme.md", "the project never opened");

    await browser.keys(["Control", ","]);
    await waitForText("appearance", "Ctrl+, never opened the settings page");
    await (await $("button=Env Probe")).click();
    // The field names the variable the key will ride, so the user can check
    // it against the provider's documentation.
    const field = await $('input[placeholder="AIME_PROBE_KEY"]');
    await fill(field, "ui-key-456");
    await (await $("button=Save")).click();
    await waitForText("saved", "the settings page never confirmed the key");

    const onDisk = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    assert.equal(onDisk["probe-env"], "ui-key-456", "the key typed into Settings never reached disk");
    // Write-only: the input is gone once a key exists; only Remove remains.
    assert.equal(await $('input[placeholder="AIME_PROBE_KEY"]').isExisting(), false);

    await (await $("button=Remove")).click();
    await browser.waitUntil(
      () => !(JSON.parse(fs.readFileSync(keysFile, "utf8"))["probe-env"] ?? null),
      { timeout: 10_000, timeoutMsg: "Remove left the key on disk" },
    );
  });

  it("picks up a provider added to providers.json while it is running", async () => {
    // The proof of the watcher: this entry is written with the app already up,
    // and nothing here reloads, restarts or even clicks.
    fs.writeFileSync(providersFile, JSON.stringify([...PROBE_PROVIDER, loginProvider()], null, 2));

    await browser.waitUntil(
      async () => {
        const listed = await invoke("list_providers");
        return listed.ok && listed.value.some((provider) => provider.id === "probe-login");
      },
      { timeout: 20_000, timeoutMsg: "the new provider never reached the backend" },
    );
    // And the UI hears about it too, without being asked.
    await waitForText("Login Probe", "the settings page never listed the new provider");
  });

  it("hands the key to a CLI that stores its own, and keeps no copy", async () => {
    const handed = await invoke("provider_set_api_key", { providerId: "probe-login", key: "cli-key-789" });
    assert.equal(handed.ok, true, `the login route failed: ${handed.error}`);
    assert.equal(fs.readFileSync(SINK, "utf8"), "cli-key-789", "the CLI received a different key");
    fs.rmSync(SINK, { force: true });

    await (await $("button=Login Probe")).click();
    // No variable name to show: this CLI takes the key on its own stdin, and
    // the hint says so by naming the command that undoes it.
    await waitForText("probe-login logout", "the settings page never explained the CLI route");

    const field = await $('input[placeholder="API key"]');
    await fill(field, "cli-key-789");
    await (await $("button=Save")).click();
    // Replacing a CLI's login is not a click Aime makes on its own.
    await waitForText("signs the cli out", "no warning before replacing the CLI's login");
    assert.equal(fs.existsSync(SINK), false, "the key was handed over before the warning was accepted");

    await (await $("button=Replace the login")).click();
    await browser.waitUntil(() => fs.existsSync(SINK), {
      timeout: 20_000,
      timeoutMsg: `the key never reached the CLI's own login command; page said: ${await $("body").getText()}`,
    });
    assert.equal(fs.readFileSync(SINK, "utf8"), "cli-key-789", "the CLI received a different key");

    // Aime stores nothing for this route: the CLI owns the credential now.
    const onDisk = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
    assert.equal(onDisk["probe-login"], undefined, "Aime kept a copy of a key it must not keep");
    // This CLI reports nothing about keys, so Aime says exactly that.
    await waitForText("reports nothing about api keys", "Aime claimed more than the CLI told it");
  });
});
