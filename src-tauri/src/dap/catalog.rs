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
//! debugger" ARCHITECTURE.md §5 refuses to ship, so Node is the whole table
//! today; Python, Go and .NET join it as each one is verified.

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

/// An archive Aime downloads because the adapter has no package to install.
pub struct Archive {
    pub url: &'static str,
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
}

pub struct AdapterSpec {
    pub id: &'static str,
    pub language_ids: &'static [&'static str],
    /// The `type` a launch configuration must carry for this adapter.
    pub config_type: &'static str,
    pub transport: Transport,
    pub runner: Runner,
    pub archive: Option<Archive>,
    /// Shown when the adapter is missing and Aime cannot fetch it itself.
    pub install_hint: &'static str,
}

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
        // Port 0 lets the operating system pick a free port, which the adapter
        // then announces; the explicit host stops it from binding IPv6 only,
        // which it does by default and which `127.0.0.1` cannot reach.
        args: &["0", "127.0.0.1"],
    },
    // Pinned rather than "latest": a machine set up today and one set up next
    // month must debug identically, and the archive layout below is then a
    // fact instead of a hope. Driven end to end on 2026-08-03.
    archive: Some(Archive {
        url: "https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz",
        unpacks_to: "js-debug",
    }),
    install_hint: "Node.js — https://nodejs.org",
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
        install_hint: "pip install debugpy",
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

impl AdapterSpec {
    /// The command that starts this adapter on this machine.
    pub fn resolved_command(&self, app: &AppHandle) -> Result<ResolvedCommand, String> {
        match &self.runner {
            Runner::OnPath { program, args, .. } => Ok(ResolvedCommand {
                program: (*program).to_string(),
                args: args.iter().map(|arg| (*arg).to_string()).collect(),
            }),
            Runner::NodeScript { script, args } => {
                let path = adapters_dir(app)?.join(script);
                if !path.is_file() {
                    return Err(format!("DAP_MISSING::{}::not downloaded yet", self.id));
                }
                let mut all = vec![path.to_string_lossy().to_string()];
                all.extend(args.iter().map(|arg| (*arg).to_string()));
                Ok(ResolvedCommand {
                    program: "node".to_string(),
                    args: all,
                })
            }
        }
    }

    /// Whether this adapter is ready to run right now.
    async fn is_present(&self, app: &AppHandle) -> bool {
        match &self.runner {
            Runner::OnPath {
                program, probe_args, ..
            } => super::adapter_command(program, *probe_args)
                .output()
                .await
                .is_ok_and(|output| output.status.success()),
            Runner::NodeScript { script, .. } => adapters_dir(app)
                .map(|dir| dir.join(script).is_file())
                .unwrap_or(false),
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
            archive.url,
        ],
    )
    .await
    .map_err(|e| format!("Could not download the {} debug adapter: {e}", spec.id))?;

    let extracted = run(
        "tar",
        &["-xzf", &partial.to_string_lossy(), "-C", &dir.to_string_lossy()],
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
    use super::{spec_for, Runner, Transport, ADAPTERS};

    #[test]
    fn node_and_typescript_share_the_one_adapter_that_reads_source_maps() {
        let js = spec_for("javascript").expect("javascript is served");
        let ts = spec_for("typescript").expect("typescript is served");
        assert_eq!(js.id, ts.id);
        assert_eq!(js.config_type, "pwa-node");
    }

    #[test]
    fn a_language_with_no_verified_adapter_says_so_instead_of_guessing() {
        for language in ["cobol", "go", "csharp", "java"] {
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
    #[test]
    fn what_the_archive_unpacks_to_is_where_the_runner_looks() {
        for spec in ADAPTERS {
            let Some(archive) = &spec.archive else { continue };
            assert!(
                archive.url.starts_with("https://"),
                "{} would be fetched in clear",
                spec.id
            );
            let Runner::NodeScript { script, .. } = &spec.runner else {
                continue;
            };
            assert!(
                script.starts_with(&format!("{}/", archive.unpacks_to)),
                "{} looks for {script}, but its archive unpacks to {}",
                spec.id,
                archive.unpacks_to
            );
        }
    }
}
