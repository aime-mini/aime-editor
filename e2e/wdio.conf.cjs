/**
 * End-to-end configuration: drives the real Aime window.
 *
 * Tauri exposes its WebView to WebDriver through `tauri-driver`, which needs
 * the Edge driver matching the installed WebView2 runtime. The app is launched
 * with a workspace folder as its argument, which is what lets these tests
 * reach the editor at all - the Open Folder button opens a native dialog no
 * driver can click.
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const project = path.resolve(__dirname, "..");
const application = path.join(project, "src-tauri", "target", "debug", "ai-mini-editor.exe");

/** Where drivers are kept, one per WebView2 major version (see e2e/README.md). */
const DRIVER_DIR = path.join(os.homedir(), ".aime-e2e");

/** Microsoft's own download host; every runtime version has a driver of the same number. */
const DRIVER_DOWNLOADS = "https://msedgedriver.microsoft.com";

/** The driver archive for this machine's architecture - one per runtime identifier. */
const DRIVER_ARCHIVE = {
  x64: "edgedriver_win64.zip",
  arm64: "edgedriver_arm64.zip",
  ia32: "edgedriver_win32.zip",
};

/** Orders `153.0.4234.48`-style versions by their numbers, not by their text. */
function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let part = 0; part < Math.max(a.length, b.length); part += 1) {
    const difference = (a[part] ?? 0) - (b[part] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The version of the WebView2 runtime this machine will actually start.
 *
 * Read from the runtime's own install folder rather than remembered: it updates
 * itself in the background, and the driver that matched last month refuses the
 * session this month - "This version of Microsoft Edge WebDriver only supports
 * Microsoft Edge version 151", measured against a 153 runtime, which reads like
 * a broken suite rather than a stale download.
 */
function installedWebViewVersion() {
  const roots = [
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
      "Microsoft/EdgeWebView/Application",
    ),
    path.join(process.env.ProgramFiles ?? "C:/Program Files", "Microsoft/EdgeWebView/Application"),
  ];
  const versions = roots
    .filter((root) => fs.existsSync(root))
    .flatMap((root) => fs.readdirSync(root))
    .filter((name) => /^\d+(\.\d+){3}$/.test(name))
    .sort(compareVersions);
  return versions.at(-1) ?? null;
}

const majorOf = (version) => Number(version.split(".")[0]);

/** What a driver answers to `--version`, as a major number. */
function driverMajor(binary) {
  const asked = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const major = /(\d+)\./.exec(asked.stdout ?? "");
  return major === null ? null : Number(major[1]);
}

/**
 * Fetches the driver built for `version` into the driver folder.
 *
 * Unpacked with Windows' own `tar.exe`, named by path: under Git Bash the `tar`
 * found first on PATH is GNU tar, which does not read zip archives.
 */
async function downloadEdgeDriver(version) {
  const archive = DRIVER_ARCHIVE[process.arch];
  if (!archive) throw new Error(`no Edge driver is published for ${process.arch}`);
  const url = `${DRIVER_DOWNLOADS}/${version}/${archive}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`the Edge driver for WebView2 ${version} is not at ${url}: ${response.status}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aime-edgedriver-"));
  try {
    const zip = path.join(scratch, archive);
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    const tar = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
    const unpacked = spawnSync(tar, ["-xf", zip, "-C", scratch, "msedgedriver.exe"], { encoding: "utf8" });
    if (unpacked.status !== 0) throw new Error(`could not unpack ${url}: ${unpacked.stderr}`);
    fs.mkdirSync(DRIVER_DIR, { recursive: true });
    const driver = path.join(DRIVER_DIR, `msedgedriver-edge${majorOf(version)}.exe`);
    fs.copyFileSync(path.join(scratch, "msedgedriver.exe"), driver);
    return driver;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The driver to drive this machine's WebView2 with.
 *
 * `AIME_EDGE_DRIVER` still wins, for a driver kept somewhere else. Otherwise
 * every driver in the folder is asked its version and the one that matches the
 * runtime is taken; when none does - the runtime updated itself since the last
 * run - the matching one is downloaded next to the others, so an update costs
 * the next run a few seconds instead of a debugging session.
 */
async function edgeDriver() {
  if (process.env.AIME_EDGE_DRIVER) return process.env.AIME_EDGE_DRIVER;
  const version = installedWebViewVersion();
  if (version === null) throw new Error("no WebView2 runtime is installed - see e2e/README.md");
  const candidates = fs.existsSync(DRIVER_DIR)
    ? fs
        .readdirSync(DRIVER_DIR)
        .filter((name) => name.startsWith("msedgedriver") && name.endsWith(".exe"))
        .map((name) => path.join(DRIVER_DIR, name))
    : [];
  const matching = candidates.find((binary) => driverMajor(binary) === majorOf(version));
  if (matching) return matching;
  process.stdout.write(`[e2e] no Edge driver for WebView2 ${version} yet - downloading it\n`);
  return downloadEdgeDriver(version);
}

/**
 * The Edge driver gives every WebView2 it starts a scratch profile in the system
 * temp folder and never takes it back: one `scoped_dir*` per spec, 10-90 MB
 * each, which is how 57 of them came to be sitting there by the ninth session.
 * `onComplete` removes the ones this run created - hence the timestamp.
 */
const startedAt = Date.now();
const DRIVER_PROFILE_PREFIX = "scoped_dir";
/** The profile is only released once the WebView2 process behind it has exited. */
const PROFILE_ATTEMPTS = 3;
const PROFILE_RETRY_MS = 400;

/** A throwaway project, so the tests never depend on what is on this machine. */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-"));
fs.writeFileSync(path.join(workspace, "hello.ts"), 'export const greeting = "hello";\n');
fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n\nsecond file\n");
// A repository that builds nothing at its own root: the project lives one folder
// down, which is the shape that makes task detection look past the root and
// carry a `cwd` on what it finds. The script prints a marker precisely so a task
// started in the wrong folder is a failure rather than a shrug - npm run from
// the root would find no package.json at all.
fs.mkdirSync(path.join(workspace, "api"));
fs.writeFileSync(
  path.join(workspace, "api", "package.json"),
  JSON.stringify(
    {
      name: "api",
      private: true,
      scripts: { test: "node -e \"console.log('the api suite ran here')\"" },
    },
    null,
    2,
  ),
);
// A file carrying a UTF-8 byte order mark, the way Visual Studio writes C#:
// 3373 of the 4071 .cs files in the solution this was found on have one.
fs.writeFileSync(path.join(workspace, "marked.cs"), "\ufeffusing Nop.Core.Caching;\n\nclass Marked { }\n");
// A file long enough to scroll whose braces sit on their own line - the shape
// that made Monaco's sticky scroll pin five rows of bare "{" over the code,
// because without an outline it reads indentation instead.
fs.writeFileSync(
  path.join(workspace, "nested.ts"),
  [
    "export function deep(): number",
    "{",
    "  let total = 0;",
    "  for (let i = 0; i < 40; i += 1)",
    "  {",
    "    if (i % 2 === 0)",
    "    {",
    ...Array.from({ length: 40 }, (_, line) => `      total += ${line};`),
    "    }",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n"),
);

// Java, for the code intelligence test: a plain folder with no Maven and no
// Gradle, which is the case JDT LS has to build an "invisible project" for before
// it can answer anything about `greeting`.
fs.writeFileSync(
  path.join(workspace, "App.java"),
  [
    "public class App {",
    "    public static void main(String[] args) {",
    '        String greeting = "hello";',
    "        System.out.println(greeting.length());",
    "    }",
    "}",
    "",
  ].join("\n"),
);

// The same shape in a language Monaco has no outline of its own for, so anything
// sticky scroll pins here came from a real language server answering
// textDocument/documentSymbol.
fs.writeFileSync(
  path.join(workspace, "nested.py"),
  [
    "def outer():",
    "    total = 0",
    "    for index in range(40):",
    "        if index % 2 == 0:",
    ...Array.from({ length: 40 }, (_, line) => `            total += ${line}`),
    "    return total",
    "",
  ].join("\n"),
);

/** cargo installs it here; the extension matters when spawning on Windows. */
function tauriDriverPath() {
  const candidates = [
    path.join(os.homedir(), ".cargo", "bin", "tauri-driver.exe"),
    path.join(os.homedir(), ".cargo", "bin", "tauri-driver"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "tauri-driver";
}

/** How a Node loader flag names tsx - the one wdio adds to load its own config. */
const TSX_LOADER = /[\\/]tsx[\\/]/;

/** `NODE_OPTIONS` without the `--import`/`--loader` flag that points at tsx. */
function withoutTsxLoader(nodeOptions) {
  const flags = nodeOptions.split(/\s+/).filter(Boolean);
  const kept = [];
  for (let index = 0; index < flags.length; index += 1) {
    const isLoader = flags[index] === "--import" || flags[index] === "--loader";
    if (isLoader && TSX_LOADER.test(flags[index + 1] ?? "")) {
      index += 1; // the flag and the path it takes
      continue;
    }
    kept.push(flags[index]);
  }
  return kept.join(" ");
}

/**
 * The environment the app under test starts in: the one the suite was started
 * from, without what wdio put there for its own sake.
 *
 * wdio's bin sets `NODE_ENV=test` and its launcher appends `--import <tsx>` to
 * `NODE_OPTIONS`. Both reached tauri-driver, the app, and through the app every
 * Node process it starts: the program being debugged, js-debug, language
 * servers, the AI CLIs. Measured 2026-09-24 from inside a debuggee: the tsx
 * loader was in its `NODE_OPTIONS`, so a program that only runs because tsx
 * compiles it would pass here and fail on every user's machine.
 *
 * `AIME_UNATTENDED` is the one addition, and it is deliberate: the window is
 * parked off the desktop and never takes focus, so a run does not maximize
 * over - and type into - whatever else is open.
 */
function appEnvironment() {
  const env = { ...process.env, AIME_UNATTENDED: "1" };
  const nodeOptions = withoutTsxLoader(env.NODE_OPTIONS ?? "");
  if (nodeOptions === "") delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = nodeOptions;
  if (env.NODE_ENV === "test") delete env.NODE_ENV;
  return env;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Driver profiles this run is responsible for.
 *
 * Only what was created after the run started: the prefix belongs to every
 * Chromium-based process on the machine, so a sweep of the whole pattern could
 * delete the profile of a WebView2 application the user has open right now.
 */
function driverProfilesOfThisRun() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(DRIVER_PROFILE_PREFIX))
    .map((name) => path.join(os.tmpdir(), name))
    .filter((profile) => {
      const stats = fs.statSync(profile, { throwIfNoEntry: false });
      // birthtime reads as 0 on filesystems that do not record one; these
      // folders are written as they are created, so mtime is then the same fact.
      return stats ? (stats.birthtimeMs || stats.mtimeMs) >= startedAt : false;
    });
}

async function removeDriverProfiles() {
  const profiles = driverProfilesOfThisRun();
  if (profiles.length === 0) return;

  let removed = 0;
  for (const profile of profiles) {
    for (let attempt = 1; attempt <= PROFILE_ATTEMPTS; attempt += 1) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        removed += 1;
        break;
      } catch (error) {
        // Still open. Worth waiting for, not worth failing a green run over:
        // the report says what was left behind and where.
        if (attempt === PROFILE_ATTEMPTS) {
          process.stdout.write(`[e2e] ${profile} still locked: ${error.message}\n`);
        } else {
          await sleep(PROFILE_RETRY_MS);
        }
      }
    }
  }
  process.stdout.write(`[e2e] removed ${removed} of ${profiles.length} driver profiles in ${os.tmpdir()}\n`);
}

let tauriDriver;

exports.config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: [path.join(__dirname, "specs", "*.e2e.cjs")],
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": { application, args: [workspace] },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  logLevel: "error",
  // 240 s, because two of these tests wait on real toolchains: the C# one asks
  // for up to 180 s around `dotnet build`, and the Java one boots the real JDT
  // LS twice (verify, then run). 90 s used to cap both from above, which made
  // those longer inner waits dead letters.
  // Four minutes was enough while a Task Run was eight phases; it is not enough
  // now that one drives ten, each with a real suite, a real linter, a repair
  // loop and a delivery gate behind it. Measured: the repair test spends about
  // five minutes when the machine is busy.
  mochaOpts: { ui: "bdd", timeout: 600_000 },

  onPrepare: async () => {
    const nativeDriver = await edgeDriver();
    if (!fs.existsSync(nativeDriver)) {
      throw new Error(`no Edge driver at ${nativeDriver} - see e2e/README.md`);
    }
    // The app inherits its environment from tauri-driver, which spawns it.
    tauriDriver = spawn(tauriDriverPath(), ["--native-driver", nativeDriver], { env: appEnvironment() });
    tauriDriver.stderr.on("data", (chunk) => {
      process.stderr.write(`[tauri-driver] ${chunk}`);
    });
  },

  /**
   * Waits for the editor's own document before a spec touches anything.
   *
   * The greeting window (`splash.html`) is a page of its own, and its document
   * has no storage access. A spec whose setup reaches for `localStorage` the
   * moment the driver attaches can land on it and die with "Access is denied
   * for this document" - which looks like a flake and is really a race with a
   * feature. Waiting here rather than in each spec is the only way it cannot
   * be forgotten by the next spec somebody writes.
   */
  before: async () => {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          try {
            return localStorage.length >= 0;
          } catch {
            return false;
          }
        }),
      { timeout: 60_000, timeoutMsg: "the editor window never took over from the greeting" },
    );
  },

  onComplete: async () => {
    tauriDriver?.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
    await removeDriverProfiles();
  },
};

exports.workspace = workspace;
