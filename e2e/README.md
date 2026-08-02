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
