//! Which debug adapter serves which language, and how Aime gets hold of it.
//!
//! Adapters are not bundled — the same contract as language servers and AI
//! CLIs. The difference is that some are not published as packages at all:
//! js-debug ships as a release archive, so for those Aime fetches the archive
//! into its own data folder rather than asking the user to place a binary on
//! PATH by hand.
//!
//! Only adapters that have been driven end to end appear here. An entry whose
//! arguments were read off a README and never run is exactly the "half a
//! debugger" ARCHITECTURE.md §5 refuses to ship. Node, Python and Go have been;
//! .NET, C++ and Java join them as each one is.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// How Aime reaches an adapter once it is running.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Transport {
    /// The adapter speaks DAP over its own stdin and stdout, and serves one
    /// session for its lifetime.
    Stdio,
    /// The adapter is a server: it prints the address it bound to and every
    /// session is a connection to it.
    TcpServer,
}

/// Where an archive lives, which depends on the adapter's shape.
pub enum ArchiveUrl {
    /// The same asset everywhere — js-debug is a Node script, not a binary.
    Portable(&'static str),
    /// One asset per operating system, keyed by `std::env::consts::OS`.
    PerOs(&'static [(&'static str, &'static str)]),
}

impl ArchiveUrl {
    fn for_this_machine(&self) -> Option<&'static str> {
        match self {
            ArchiveUrl::Portable(url) => Some(url),
            ArchiveUrl::PerOs(assets) => assets
                .iter()
                .find(|(os, _)| *os == std::env::consts::OS)
                .map(|(_, url)| *url),
        }
    }
}

/// An archive Aime downloads because the adapter has no package to install.
pub struct Archive {
    pub url: ArchiveUrl,
    /// Folder the archive unpacks into, relative to Aime's adapter directory.
    /// Used to tell "already downloaded" from "not yet".
    pub unpacks_to: &'static str,
}

/// How to start an adapter, once it is present.
pub enum Runner {
    /// A command the user's own toolchain provides.
    OnPath {
        program: &'static str,
        args: &'static [&'static str],
        /// Arguments that prove the adapter is really usable. Presence on PATH
        /// is not enough when the program is a runtime: `python` exists on
        /// most machines whether or not debugpy was ever installed into it.
        probe_args: &'static [&'static str],
    },
    /// A Node script inside a downloaded archive.
    NodeScript {
        /// Path to the script, relative to Aime's adapter directory.
        script: &'static str,
        args: &'static [&'static str],
    },
    /// A native executable inside a downloaded archive. The path carries no
    /// extension: `.exe` belongs to Windows and is added there.
    ArchiveBinary {
        binary: &'static str,
        args: &'static [&'static str],
    },
}

/// What has to happen before a program can be debugged at all.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Prepare {
    /// The program is the file the user opened, and it is ready to run.
    Nothing,
    /// Build with the .NET SDK and debug what it produced: netcoredbg attaches
    /// to an assembly, and a `.cs` file is not one.
    DotnetBuild,
}

pub struct AdapterSpec {
    pub id: &'static str,
    pub language_ids: &'static [&'static str],
    /// The `type` a launch configuration must carry for this adapter.
    pub config_type: &'static str,
    pub transport: Transport,
    pub runner: Runner,
    pub archive: Option<Archive>,
    pub prepare: Prepare,
    /// Shown when the adapter is missing and Aime cannot fetch it itself.
    pub install_hint: &'static str,
}

/// Pinned rather than "latest": a machine set up today and one set up next
/// month must debug identically, and the archive layout is then a fact instead
/// of a hope. Driven end to end on 2026-08-03.
const JS_DEBUG_ARCHIVE_URL: &str =
    "https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz";

/// netcoredbg is a native binary, so the asset differs per platform. Pinned for
/// the same reason js-debug is. Driven end to end on Windows 2026-08-03; the
/// other two assets are the same release of the same adapter.
const NETCOREDBG_ASSETS: ArchiveUrl = ArchiveUrl::PerOs(&[
    (
        "windows",
        "https://github.com/Samsung/netcoredbg/releases/download/3.2.0-1092/netcoredbg-win64.zip",
    ),
    (
        "macos",
        "https://github.com/Samsung/netcoredbg/releases/download/3.2.0-1092/netcoredbg-osx-arm64.zip",
    ),
    (
        "linux",
        "https://github.com/Samsung/netcoredbg/releases/download/3.2.0-1092/netcoredbg-linux-amd64.tar.gz",
    ),
]);

/// Everything Aime can debug today.
const ADAPTERS: &[AdapterSpec] = &[
    AdapterSpec {
        id: "js-debug",
        // One adapter for the whole Node side: js-debug reads source maps, so a
        // TypeScript program is debugged as the JavaScript it compiles to.
        language_ids: &["javascript", "typescript"],
        config_type: "pwa-node",
        transport: Transport::TcpServer,
        runner: Runner::NodeScript {
            script: "js-debug/src/dapDebugServer.js",
            // Port 0 lets the operating system pick a free port, which the
            // adapter then announces; the explicit host stops it from binding
            // IPv6 only, which it does by default and `127.0.0.1` cannot reach.
            args: &["0", "127.0.0.1"],
        },
        archive: Some(Archive {
            url: ArchiveUrl::Portable(JS_DEBUG_ARCHIVE_URL),
            unpacks_to: "js-debug",
        }),
        prepare: Prepare::Nothing,
        install_hint: "Node.js — https://nodejs.org",
    },
    AdapterSpec {
        id: "delve",
        language_ids: &["go"],
        config_type: "go",
        // Measured: `dlv dap` is headless and TCP only — its own help says so,
        // and it announces "DAP server listening at: 127.0.0.1:PORT".
        transport: Transport::TcpServer,
        runner: Runner::OnPath {
            program: "dlv",
            args: &["dap", "--listen=127.0.0.1:0"],
            // `dlv version` costs nothing and proves the binary runs; delve is
            // installed with `go install`, so a Go toolchain alone proves nothing.
            probe_args: &["version"],
        },
        archive: None,
        prepare: Prepare::Nothing,
        install_hint: "go install github.com/go-delve/delve/cmd/dlv@latest",
    },
    AdapterSpec {
        id: "debugpy",
        language_ids: &["python"],
        config_type: "python",
        // Measured: debugpy runs the whole session over one pair of pipes and
        // never asks for a second one.
        transport: Transport::Stdio,
        runner: Runner::OnPath {
            program: "python",
            args: &["-m", "debugpy.adapter"],
            probe_args: &["-c", "import debugpy"],
        },
        archive: None,
        prepare: Prepare::Nothing,
        install_hint: "pip install debugpy",
    },
    AdapterSpec {
        id: "netcoredbg",
        language_ids: &["csharp"],
        config_type: "coreclr",
        // Measured: `--interpreter=vscode` is DAP over stdin and stdout, and it
        // never asks for a second connection.
        transport: Transport::Stdio,
        runner: Runner::ArchiveBinary {
            binary: "netcoredbg/netcoredbg",
            args: &["--interpreter=vscode"],
        },
        archive: Some(Archive {
            url: NETCOREDBG_ASSETS,
            unpacks_to: "netcoredbg",
        }),
        // A .cs file is not something a CLR debugger can attach to.
        prepare: Prepare::DotnetBuild,
        install_hint: ".NET SDK — https://dotnet.microsoft.com/download",
    },
];

pub fn spec_for(language_id: &str) -> Option<&'static AdapterSpec> {
    ADAPTERS
        .iter()
        .find(|spec| spec.language_ids.contains(&language_id))
}

/// A command line ready to spawn.
pub struct ResolvedCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Where Aime keeps the adapters it downloaded.
pub fn adapters_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("debug-adapters"))
}

/// Tools a language toolchain installs, and how to ask where it put them.
///
/// `go install` writes into `go env GOPATH`/bin. Go users are expected to have
/// that on PATH and often have not — and an adapter that is installed but
/// reported missing is indistinguishable, to the person looking at the panel,
/// from one that was never installed at all.
const TOOLCHAIN_BINS: &[(&str, &str, &[&str])] = &[("dlv", "go", &["env", "GOPATH"])];

/// Asks the toolchain where it installs binaries, and looks for one there.
async fn toolchain_binary(program: &str) -> Option<PathBuf> {
    let (_, toolchain, query) = TOOLCHAIN_BINS.iter().find(|(tool, _, _)| *tool == program)?;
    let output = super::adapter_command(toolchain, *query).output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(root)
        .join("bin")
        .join(format!("{program}{}", std::env::consts::EXE_SUFFIX));
    candidate.is_file().then_some(candidate)
}

/// The name a native binary has on this platform.
fn with_exe_suffix(binary: &str) -> String {
    format!("{binary}{}", std::env::consts::EXE_SUFFIX)
}

async fn runs(program: &str, probe_args: &[&str]) -> bool {
    super::adapter_command(program, probe_args)
        .output()
        .await
        .is_ok_and(|output| output.status.success())
}

impl AdapterSpec {
    /// The name or path that actually starts this adapter, if anything does.
    async fn usable_program(&self) -> Option<String> {
        let Runner::OnPath {
            program, probe_args, ..
        } = &self.runner
        else {
            return None;
        };
        if runs(program, probe_args).await {
            return Some((*program).to_string());
        }
        let fallback = toolchain_binary(program).await?;
        let path = fallback.to_string_lossy().to_string();
        runs(&path, probe_args).await.then_some(path)
    }

    /// The command that starts this adapter on this machine.
    pub async fn resolved_command(&self, app: &AppHandle) -> Result<ResolvedCommand, String> {
        match &self.runner {
            Runner::OnPath { program, args, .. } => Ok(ResolvedCommand {
                program: self
                    .usable_program()
                    .await
                    .ok_or_else(|| format!("DAP_MISSING::{}::{program} is not installed", self.id))?,
                args: args.iter().map(|arg| (*arg).to_string()).collect(),
            }),
            Runner::NodeScript { script, args } => {
                let path = self.downloaded_file(app, script)?;
                let mut all = vec![path.to_string_lossy().to_string()];
                all.extend(args.iter().map(|arg| (*arg).to_string()));
                Ok(ResolvedCommand {
                    program: "node".to_string(),
                    args: all,
                })
            }
            Runner::ArchiveBinary { binary, args } => {
                let path = self.downloaded_file(app, &with_exe_suffix(binary))?;
                Ok(ResolvedCommand {
                    program: path.to_string_lossy().to_string(),
                    args: args.iter().map(|arg| (*arg).to_string()).collect(),
                })
            }
        }
    }

    /// A file inside the downloaded archive, or a "download it first" error.
    fn downloaded_file(&self, app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
        let path = adapters_dir(app)?.join(relative);
        if path.is_file() {
            Ok(path)
        } else {
            Err(format!("DAP_MISSING::{}::not downloaded yet", self.id))
        }
    }

    /// Whether this adapter is ready to run right now.
    async fn is_present(&self, app: &AppHandle) -> bool {
        match &self.runner {
            Runner::OnPath { .. } => self.usable_program().await.is_some(),
            Runner::NodeScript { script, .. } => self.downloaded_file(app, script).is_ok(),
            Runner::ArchiveBinary { binary, .. } => {
                self.downloaded_file(app, &with_exe_suffix(binary)).is_ok()
            }
        }
    }
}

/// What the UI needs to know before offering to debug a file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterAvailability {
    pub adapter_id: String,
    pub language_id: String,
    /// The `type` this adapter's launch configuration must carry — the
    /// frontend builds that configuration, so it needs the value from here
    /// rather than repeating the table.
    pub config_type: String,
    pub available: bool,
    /// Whether Aime can fetch it without the user installing anything.
    pub downloadable: bool,
    /// True when starting a run builds the project first, which the console
    /// says out loud — a debugger that looks frozen for five seconds is worse
    /// than one that reports what it is doing.
    pub builds_first: bool,
    pub install_hint: String,
}

/// Reports whether a language can be debugged, and how to fix it if not.
#[tauri::command]
pub async fn dap_availability(app: AppHandle, language_id: String) -> Option<AdapterAvailability> {
    let spec = spec_for(&language_id)?;
    let available = spec.is_present(&app).await;
    Some(AdapterAvailability {
        adapter_id: spec.id.to_string(),
        language_id,
        config_type: spec.config_type.to_string(),
        available,
        downloadable: spec.archive.is_some(),
        builds_first: spec.prepare != Prepare::Nothing,
        install_hint: spec.install_hint.to_string(),
    })
}

/// Downloads and unpacks the adapter's archive, if it has one and it is not
/// already there. Uses the `curl` and `tar` that ship with Windows 10+, macOS
/// and every Linux distribution Aime targets, so fetching one archive does not
/// pull an HTTP stack and an unpacker into the binary.
#[tauri::command]
pub async fn dap_download(app: AppHandle, language_id: String) -> Result<(), String> {
    let spec = spec_for(&language_id).ok_or_else(|| format!("No debug adapter for {language_id}"))?;
    let archive = spec
        .archive
        .as_ref()
        .ok_or_else(|| format!("{} is installed by its own toolchain", spec.id))?;
    let url = archive
        .url
        .for_this_machine()
        .ok_or_else(|| format!("{} has no build for {}", spec.id, std::env::consts::OS))?;
    let dir = adapters_dir(&app)?;
    if dir.join(archive.unpacks_to).is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    // Into a temporary name first: an interrupted download that left a
    // half-written archive behind would look downloaded forever.
    let partial = dir.join(format!("{}.part", spec.id));
    run(
        "curl",
        &[
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--output",
            &partial.to_string_lossy(),
            url,
        ],
    )
    .await
    .map_err(|e| format!("Could not download the {} debug adapter: {e}", spec.id))?;

    // `-xf`, not `-xzf`: one flag set reads both .tar.gz and .zip, and the
    // adapters need both. The tool matters more than the flags — see `unpacker`.
    let extracted = run(
        &unpacker(),
        &["-xf", &partial.to_string_lossy(), "-C", &dir.to_string_lossy()],
    )
    .await;
    let _ = std::fs::remove_file(&partial);
    extracted.map_err(|e| format!("Could not unpack the {} debug adapter: {e}", spec.id))?;

    if !dir.join(archive.unpacks_to).is_dir() {
        return Err(format!(
            "The {} archive did not contain {}",
            spec.id, archive.unpacks_to
        ));
    }
    Ok(())
}

/// The archiver to unpack with.
///
/// Windows ships bsdtar as the `tar.exe` in its System32 folder, and bsdtar
/// reads zip as happily as tar.gz. Plain `tar` on PATH is not necessarily that
/// one: Git for Windows puts GNU tar there, and GNU tar cannot read a zip at
/// all ("This does not look like a tar archive" — measured against
/// netcoredbg's own asset). So on Windows the system copy is named outright;
/// elsewhere `tar` is bsdtar on macOS and GNU tar on Linux, and every asset
/// Aime fetches for those is a tarball.
fn unpacker() -> String {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        format!(r"{root}\System32\tar.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        "tar".to_string()
    }
}

/// What the debugger should actually be pointed at.
///
/// For most adapters that is the file in front of the user. netcoredbg attaches
/// to an assembly, so for .NET the project is built first and the artifact is
/// what gets debugged — `dotnet msbuild -t:Build -getProperty:TargetPath` does
/// both in one call and prints the exact path, which beats guessing at
/// `bin/Debug/<framework>/`.
#[tauri::command]
pub async fn dap_program(language_id: String, root: String, file: String) -> Result<String, String> {
    let spec = spec_for(&language_id).ok_or_else(|| format!("No debug adapter for {language_id}"))?;
    match spec.prepare {
        Prepare::Nothing => Ok(file),
        Prepare::DotnetBuild => {
            let output = super::adapter_command(
                "dotnet",
                [
                    "msbuild",
                    "-t:Build",
                    "-getProperty:TargetPath",
                    "-v:q",
                    "-nologo",
                ],
            )
            .current_dir(&root)
            .output()
            .await
            .map_err(|e| format!("dotnet is not available: {e}"))?;

            if !output.status.success() {
                // The build log is the useful part of a failed build.
                let reason = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "The build failed.
{}",
                    pick_message(&reason, &stderr)
                ));
            }
            let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if target.is_empty() {
                return Err("The build produced no assembly to debug.".to_string());
            }
            Ok(target)
        }
    }
}

/// Whichever stream the tool explained itself on.
fn pick_message(stdout: &str, stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        stdout.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// Runs a helper program, turning a non-zero exit into its own message —
/// `curl` and `tar` both explain themselves on stderr.
async fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = super::adapter_command(program, args)
        .output()
        .await
        .map_err(|e| format!("{program} is not available: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if reason.is_empty() {
        format!("{program} failed")
    } else {
        reason
    })
}

#[cfg(test)]
mod tests {
    use super::{spec_for, ArchiveUrl, Prepare, Runner, Transport, ADAPTERS, TOOLCHAIN_BINS};

    #[test]
    fn node_and_typescript_share_the_one_adapter_that_reads_source_maps() {
        let js = spec_for("javascript").expect("javascript is served");
        let ts = spec_for("typescript").expect("typescript is served");
        assert_eq!(js.id, ts.id);
        assert_eq!(js.config_type, "pwa-node");
    }

    #[test]
    fn a_language_with_no_verified_adapter_says_so_instead_of_guessing() {
        for language in ["cobol", "java", "cpp"] {
            assert!(
                spec_for(language).is_none(),
                "{language} must not be offered until its adapter is driven for real"
            );
        }
    }

    /// A runtime being installed says nothing about the adapter inside it, and
    /// reporting Python as debuggable on every machine that has Python would
    /// send users straight into a spawn failure.
    #[test]
    fn a_runtime_adapter_is_probed_for_the_adapter_not_for_the_runtime() {
        let Runner::OnPath {
            program, probe_args, ..
        } = &spec_for("python").expect("python is served").runner
        else {
            panic!("debugpy runs from the user's own Python");
        };
        assert_eq!(*program, "python");
        assert!(
            probe_args.iter().any(|arg| arg.contains("import debugpy")),
            "the probe must import the adapter, not just find python"
        );
    }

    /// delve is a headless TCP server by its own documentation, and it must be
    /// asked for a free port on IPv4 - the same trap js-debug sets.
    #[test]
    fn delve_is_reached_over_tcp_on_a_port_the_os_picks() {
        let spec = spec_for("go").expect("go is served");
        assert_eq!(spec.id, "delve");
        assert_eq!(spec.transport, Transport::TcpServer);
        let Runner::OnPath {
            program,
            args,
            probe_args,
        } = &spec.runner
        else {
            panic!("delve is installed by the Go toolchain, not downloaded");
        };
        assert_eq!(*program, "dlv");
        assert!(args.contains(&"dap"), "the DAP server is a subcommand: {args:?}");
        assert!(
            args.iter().any(|arg| arg.contains("--listen=127.0.0.1:0")),
            "delve must be given an IPv4 address and a port the OS picks: {args:?}"
        );
        assert!(
            !probe_args.is_empty(),
            "a Go toolchain alone does not prove delve is there"
        );
    }

    /// A tool listed as toolchain-installed has to be a tool the catalog looks
    /// for on PATH, or the fallback lookup can never run.
    #[test]
    fn every_toolchain_installed_tool_is_one_the_catalog_looks_up() {
        for (tool, toolchain, query) in TOOLCHAIN_BINS {
            assert!(
                !query.is_empty(),
                "{toolchain} needs a query to answer where {tool} lands"
            );
            assert!(
                ADAPTERS.iter().any(|spec| matches!(
                    spec.runner,
                    Runner::OnPath { program, .. } if program == *tool
                )),
                "{tool} is not a program any adapter runs"
            );
        }
    }

    #[test]
    fn only_the_adapter_that_needs_a_second_connection_is_a_server() {
        assert_eq!(
            spec_for("python").expect("python is served").transport,
            Transport::Stdio,
            "debugpy was measured to need one connection"
        );
    }

    #[test]
    fn js_debug_is_reached_over_tcp_and_asked_for_a_free_port_on_ipv4() {
        let spec = spec_for("javascript").expect("javascript is served");
        assert_eq!(spec.transport, Transport::TcpServer);
        let Runner::NodeScript { args, .. } = &spec.runner else {
            panic!("js-debug is a Node script inside a downloaded archive");
        };
        // Measured: without the host it binds ::1 only, and 127.0.0.1 fails.
        assert_eq!(*args, ["0", "127.0.0.1"]);
    }

    /// The download and the launch must agree on where the files land, or the
    /// adapter is fetched successfully and then reported as missing forever.
    /// .NET is the one language here whose debugger attaches to a build
    /// artifact; every other adapter takes the file the user opened.
    #[test]
    fn only_dotnet_has_to_be_built_before_it_can_be_debugged() {
        assert_eq!(
            spec_for("csharp").expect("csharp is served").prepare,
            Prepare::DotnetBuild
        );
        for language in ["javascript", "typescript", "python", "go"] {
            assert_eq!(
                spec_for(language).expect("served").prepare,
                Prepare::Nothing,
                "{language} debugs the file in front of the user"
            );
        }
    }

    /// A native adapter needs an asset for the machine it will run on, and
    /// forgetting one turns into "no build for linux" at download time.
    #[test]
    fn every_downloadable_adapter_has_an_asset_for_every_platform_aime_ships_on() {
        for spec in ADAPTERS {
            let Some(archive) = &spec.archive else { continue };
            let ArchiveUrl::PerOs(assets) = &archive.url else {
                continue;
            };
            for os in ["windows", "macos", "linux"] {
                assert!(
                    assets.iter().any(|(candidate, _)| *candidate == os),
                    "{} has no asset for {os}",
                    spec.id
                );
            }
        }
    }

    #[test]
    fn what_the_archive_unpacks_to_is_where_the_runner_looks() {
        for spec in ADAPTERS {
            let Some(archive) = &spec.archive else { continue };
            let url = archive
                .url
                .for_this_machine()
                .unwrap_or_else(|| panic!("{} has no asset for {}", spec.id, std::env::consts::OS));
            assert!(
                url.starts_with("https://"),
                "{} would be fetched in clear",
                spec.id
            );
            let inside = match &spec.runner {
                Runner::NodeScript { script, .. } => script,
                Runner::ArchiveBinary { binary, .. } => binary,
                Runner::OnPath { .. } => continue,
            };
            assert!(
                inside.starts_with(&format!("{}/", archive.unpacks_to)),
                "{} looks for {inside}, but its archive unpacks to {}",
                spec.id,
                archive.unpacks_to
            );
        }
    }
}
