/**
 * The app window under test, reached the way the desktop reaches it.
 *
 * WebDriver's own window commands act on the webview it is attached to, not
 * on the window holding it: with several workspaces in one window as webviews
 * (`src-tauri/src/workspaces.rs`), `setWindowRect` shrank the page and left
 * the window - and every other tab in it - as it was (measured 2026-09-27). A
 * person drags the window's edge; this does what that drag does, to the one
 * app this run started and never to an Aime the user has open.
 *
 * Windows only, like the suite: it runs on WebView2's driver.
 */
const { spawnSync } = require("node:child_process");

/** The app this run's driver started - never another Aime on the machine. */
const FIND_APP = [
  // The Edge driver is kept under a name per version (msedgedriver-edge153.exe).
  "$drivers = @(Get-Process | Where-Object { $_.Name -eq 'tauri-driver' -or $_.Name -like 'msedgedriver*' } | ForEach-Object { $_.Id })",
  "$app = Get-CimInstance Win32_Process -Filter \"Name='ai-mini-editor.exe'\" | Where-Object { $drivers -contains $_.ParentProcessId } | Select-Object -First 1",
  'if (-not $app) { throw "no app started by this run (drivers: $drivers)" }',
  "$window = (Get-Process -Id $app.ProcessId).MainWindowHandle",
  'if ($window -eq [System.IntPtr]::Zero) { throw "the app has no window" }',
];

const SET_WINDOW_POS =
  "Add-Type -Namespace Aime -Name Window -MemberDefinition '" +
  '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr window, System.IntPtr after, int x, int y, int width, int height, uint flags); ' +
  '[DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr context);' +
  "'";

/**
 * DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. PowerShell is not DPI aware, so
 * Windows scales whatever it asks for by the display's scale - at 150 % a
 * window asked to be 1300 wide came out 1950 (measured 2026-09-27). Aware, the
 * size given is the size in physical pixels, the unit the app reports in.
 */
const PER_MONITOR_AWARE = -4;

/** SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE: a size, and nothing else - no focus taken. */
const SIZE_ONLY = 0x0002 | 0x0004 | 0x0010;

/** Sets the outer size of the app's window, in physical pixels, as dragging its edge would. */
function resizeAppWindow(width, height) {
  const script = [
    SET_WINDOW_POS,
    `[void][Aime.Window]::SetThreadDpiAwarenessContext([System.IntPtr]${PER_MONITOR_AWARE})`,
    ...FIND_APP,
    `if (-not [Aime.Window]::SetWindowPos($window, [System.IntPtr]::Zero, 0, 0, ${width}, ${height}, ${SIZE_ONLY})) { throw "SetWindowPos refused" }`,
  ].join("\n");
  const shell = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  if (shell.status !== 0) throw new Error(`could not resize the app window: ${shell.stderr}`);
}

module.exports = { resizeAppWindow };
