# End-to-end tests

These drive the real Aime window through WebDriver, which is the only place
where React, Monaco and the Rust side are all running together - and where the
bugs that reach users actually live. The first run of this suite found one:
opening a project crashed the app because a picker read `options[0].label`
while its options were still loading.

## What you need once

```bash
cargo install tauri-driver --locked
```

The Edge WebDriver has to match the installed WebView2 runtime, and the runner
sees to that itself. It reads the runtime's version out of
`C:\Program Files (x86)\Microsoft\EdgeWebView\Application`, asks every
`msedgedriver*.exe` in `~/.aime-e2e` for its own, and takes the one whose major
matches. When none does - WebView2 updates itself in the background - it
downloads `https://msedgedriver.microsoft.com/<version>/edgedriver_<arch>.zip`
for this machine's architecture and keeps it there as `msedgedriver-edge<major>.exe`,
next to the older ones. Measured 2026-09-24: with no 153 driver in the folder, the
run fetched 153.0.4234.48 for a 153.0.4234.48 runtime and went on green.

Point `AIME_EDGE_DRIVER` at a driver kept somewhere else; it still wins.

## Running

The debug binary must exist and the dev server must be up, because that binary
loads `http://localhost:1420`:

```bash
npm run tauri dev      # in one terminal, leave it running
npm run test:e2e       # in another
```

## Why the tests enter through the Recent list

`Open Folder` raises a native dialog that no WebDriver can click. The suite
seeds a recent entry and clicks that instead - a path users take every day
anyway - which is also why the app must never be reached only through dialogs.

## Two ways a whole green suite turns red at once

Both cost an afternoon once, so they are written down rather than rediscovered:

1. **The dev server is not running.** The debug binary loads `http://localhost:1420`, so with Vite
   down every spec fails at once - and the error is not "connection refused" but
   `Failed to read the 'localStorage' property from 'Window': Access is denied for this document`,
   because the webview is sitting on an error page. Start `npm run tauri dev` (or just `npm run dev`
   if the debug binary already exists) before the suite.
2. **The Rust binary is stale.** `npm run test:e2e` runs `src-tauri/target/debug/ai-mini-editor.exe`
   and never builds it. `npm run tauri dev` rebuilds it while it is running; without that, a new
   `#[tauri::command]` does not exist in the app and every test that reaches it fails with a command
   error. Run `cargo build` in `src-tauri` after changing Rust, then the suite.

## Typing while the suite runs

The test window is parked off-screen (`AIME_UNATTENDED`) but it still takes
keyboard focus, so anything typed at the machine lands in whichever field the
spec is filling. Measured 2026-08-24: the word "làm" arrived inside a board URL
(`lhttp://127.0.0.1:51291àm`) and the connect step failed as if the product were
broken. Specs therefore type through `fill()` in `e2e/support/fields.cjs`, which
reads the field back and retries; use it for every value the app then acts on
rather than `setValue` directly.

Two places a guard cannot reach: text typed into Monaco and into the terminal
goes in keystroke by keystroke with no field to read back. If one of those turns
red for no reason, suspect the keyboard first.

## What the app inherits, and what it does not

The app is started by tauri-driver, which `wdio.conf.cjs` spawns - so whatever
is in the runner's environment reaches every process the app starts: the
program being debugged, js-debug, language servers, the AI CLIs. wdio puts two
things there for itself (`NODE_ENV=test`, and `--import <tsx>` in
`NODE_OPTIONS`), and until 2026-09-24 both leaked through: every Node program
under test ran through tsx, and a top-level `throw` read as handled because
tsx's loader had wrapped it. `appEnvironment()` takes both back out, so the app
sees the environment the suite was started from, plus `AIME_UNATTENDED`.

A program the app runs is also slower here than on a desktop, by design of the
run rather than of Aime: the window is off-screen and never focused. Measured
the same day, the same bare DAP client printing 20,000 lines through js-debug
took 1.9 s from a terminal and 4.0 s from inside the test app. Time what the
suite does against the suite, never against a figure taken at a desk.
