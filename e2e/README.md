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

Plus the Edge WebDriver matching the installed WebView2 runtime. Find the
version under `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`, then:

```bash
curl -L -o edgedriver.zip https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip
unzip edgedriver.zip -d ~/.aime-e2e
```

Point `AIME_EDGE_DRIVER` at it if you keep it elsewhere.

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
