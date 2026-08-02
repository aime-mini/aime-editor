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
const nativeDriver =
  process.env.AIME_EDGE_DRIVER ?? path.join(os.homedir(), ".aime-e2e", "msedgedriver.exe");

/** A throwaway project, so the tests never depend on what is on this machine. */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aime-e2e-"));
fs.writeFileSync(path.join(workspace, "hello.ts"), 'export const greeting = "hello";\n');
fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n\nsecond file\n");

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
  mochaOpts: { ui: "bdd", timeout: 90_000 },

  onPrepare: () => {
    tauriDriver = spawn(path.join(os.homedir(), ".cargo", "bin", "tauri-driver"), [
      "--native-driver",
      nativeDriver,
    ]);
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
