/**
 * End-to-end configuration: drives the real Aime window.
 *
 * Tauri exposes its WebView to WebDriver through `tauri-driver`, which needs
 * the Edge driver matching the installed WebView2 runtime. The app is launched
 * with a workspace folder as its argument, which is what lets these tests
 * reach the editor at all - the Open Folder button opens a native dialog no
 * driver can click.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const project = path.resolve(__dirname, "..");
const application = path.join(project, "src-tauri", "target", "debug", "ai-mini-editor.exe");
const nativeDriver = process.env.AIME_EDGE_DRIVER ?? path.join(os.homedir(), ".aime-e2e", "msedgedriver.exe");

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
      scripts: { test: 'node -e "console.log(\'the api suite ran here\')"' },
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
  mochaOpts: { ui: "bdd", timeout: 240_000 },

  onPrepare: () => {
    if (!fs.existsSync(nativeDriver)) {
      throw new Error(`no Edge driver at ${nativeDriver} - see e2e/README.md`);
    }
    // AIME_UNATTENDED reaches the app through tauri-driver, which spawns it:
    // the window is parked off the desktop and never takes focus, so a run
    // does not maximize over - and type into - whatever else is open.
    tauriDriver = spawn(tauriDriverPath(), ["--native-driver", nativeDriver], {
      env: { ...process.env, AIME_UNATTENDED: "1" },
    });
    tauriDriver.stderr.on("data", (chunk) => {
      process.stderr.write(`[tauri-driver] ${chunk}`);
    });
  },

  onComplete: async () => {
    tauriDriver?.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
    await removeDriverProfiles();
  },
};

exports.workspace = workspace;
