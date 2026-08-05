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

/** A throwaway project, so the tests never depend on what is on this machine. */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-"));
fs.writeFileSync(path.join(workspace, "hello.ts"), 'export const greeting = "hello";\n');
fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n\nsecond file\n");
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

  onComplete: () => {
    tauriDriver?.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  },
};

exports.workspace = workspace;
