//! Language servers (ARCHITECTURE.md §5). Aime speaks LSP to the same servers
//! VS Code uses, so code intelligence is as good as theirs without us writing
//! a single language analyzer. This module is only the transport: it spawns a
//! server, frames messages both ways, and relays JSON to the window that owns
//! it — protocol semantics live on the frontend, next to Monaco.

use crate::providers::cli_command;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

static SERVER_COUNTER: AtomicU64 = AtomicU64::new(1);

/// One JSON message from a server, relayed verbatim.
const MESSAGE_EVENT: &str = "lsp:message";
/// The server process ended (crash, or our own shutdown).
const EXIT_EVENT: &str = "lsp:exit";

/// A language server Aime knows how to start. Servers are *not* bundled: they
/// are found on PATH, and when one is missing the UI shows `install_hint`
/// rather than silently offering worse completions (same contract as the AI
/// CLIs — a missing tool degrades to guidance, never to a broken feature).
pub struct ServerSpec {
    /// Monaco language id this server serves.
    pub language_id: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub install_hint: &'static str,
    /// How to tell whether this server is installed.
    pub probe: Probe,
}

/// How to tell whether a server is installed. Measured, not assumed
/// (2026-08-02): of the servers Aime ships with, `--version` exits 0 for
/// typescript-language-server, yaml-language-server and bash-language-server,
/// but exits 1 for pyright-langserver, intelephense, sql-language-server and
/// docker-langserver, which answer only to a real LSP session. Trusting
/// `--version` everywhere would report four of them as missing forever, right
/// after the user installed them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Probe {
    /// Present on PATH means installed. Correct for real binaries and for npm
    /// shims, which only exist once their package is installed.
    OnPath,
    /// `--version` must exit 0. Needed where the name on PATH is a launcher
    /// for something that may not be there: `rust-analyzer` is a rustup proxy
    /// that exists even when the component was never added.
    VersionFlag,
}

/// Every server Aime knows how to start, verified to exist (npm and NuGet
/// checked 2026-08-02). Servers that need a toolchain rather than a package -
/// Java's JDT LS, clangd for C/C++ - are deliberately absent: offering a
/// one-click install that cannot work is worse than saying nothing.
///
/// HTML, CSS and JSON are absent for a different reason: Monaco ships language
/// services for them, so adding a server would only duplicate every
/// suggestion.
const SERVERS: &[ServerSpec] = &[
    // TypeScript's server also covers JavaScript, so both ids map to it.
    ServerSpec {
        language_id: "typescript",
        command: "typescript-language-server",
        args: &["--stdio"],
        install_hint: "npm install -g typescript-language-server typescript",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "javascript",
        command: "typescript-language-server",
        args: &["--stdio"],
        install_hint: "npm install -g typescript-language-server typescript",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "python",
        command: "pyright-langserver",
        args: &["--stdio"],
        install_hint: "npm install -g pyright",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "go",
        command: "gopls",
        args: &[],
        install_hint: "go install golang.org/x/tools/gopls@latest",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "rust",
        command: "rust-analyzer",
        args: &[],
        install_hint: "rustup component add rust-analyzer",
        probe: Probe::VersionFlag,
    },
    ServerSpec {
        language_id: "csharp",
        command: "csharp-ls",
        args: &[],
        install_hint: "dotnet tool install --global csharp-ls",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "php",
        command: "intelephense",
        args: &["--stdio"],
        install_hint: "npm install -g intelephense",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "sql",
        command: "sql-language-server",
        args: &["up", "--method", "stdio"],
        install_hint: "npm install -g sql-language-server",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "shell",
        command: "bash-language-server",
        args: &["start"],
        install_hint: "npm install -g bash-language-server",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "yaml",
        command: "yaml-language-server",
        args: &["--stdio"],
        install_hint: "npm install -g yaml-language-server",
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "dockerfile",
        command: "docker-langserver",
        args: &["--stdio"],
        install_hint: "npm install -g dockerfile-language-server-nodejs",
        probe: Probe::OnPath,
    },
    // clangd serves C and C++; it ships inside LLVM rather than as a package.
    ServerSpec {
        language_id: "cpp",
        command: "clangd",
        args: &[],
        install_hint: CLANGD_INSTALL,
        probe: Probe::OnPath,
    },
    ServerSpec {
        language_id: "c",
        command: "clangd",
        args: &[],
        install_hint: CLANGD_INSTALL,
        probe: Probe::OnPath,
    },
    // Eclipse JDT LS is published as an archive, not a package: there is no
    // command Aime could run, so the user gets the download page instead of a
    // button that would only fail.
    ServerSpec {
        language_id: "java",
        command: "jdtls",
        args: &[],
        install_hint: "https://download.eclipse.org/jdtls/snapshots/",
        probe: Probe::OnPath,
    },
];

/// Windows has a package manager for LLVM; elsewhere the system one is the way.
#[cfg(target_os = "windows")]
const CLANGD_INSTALL: &str =
    "winget install --id LLVM.LLVM -e --accept-package-agreements --accept-source-agreements";
#[cfg(target_os = "macos")]
const CLANGD_INSTALL: &str = "brew install llvm";
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const CLANGD_INSTALL: &str = "sudo apt install clangd";

pub fn spec_for(language_id: &str) -> Option<&'static ServerSpec> {
    SERVERS.iter().find(|spec| spec.language_id == language_id)
}

struct Session {
    /// Messages queued for the server's stdin; a writer task owns the pipe.
    outgoing: UnboundedSender<String>,
    /// Ends the driver task, which kills the process.
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    window_label: String,
}

/// Live language servers keyed by server id.
#[derive(Default)]
pub struct LspState(Mutex<HashMap<u64, Session>>);

impl LspState {
    /// A poisoned lock still holds valid data — recover it instead of panicking.
    fn sessions(&self) -> MutexGuard<'_, HashMap<u64, Session>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessagePayload {
    server_id: u64,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    server_id: u64,
}

/// Wraps a JSON message in the `Content-Length` envelope LSP requires.
/// The length counts bytes, not characters — a UTF-8 identifier would
/// otherwise truncate the message.
fn frame(message: &str) -> String {
    format!("Content-Length: {}\r\n\r\n{message}", message.len())
}

/// Reads the byte count out of a header line, ignoring headers we don't use.
/// Header names are case-insensitive per the specification.
fn content_length(header: &str) -> Option<usize> {
    let (name, value) = header.split_once(':')?;
    if !name.trim().eq_ignore_ascii_case("Content-Length") {
        return None;
    }
    value.trim().parse().ok()
}

/// What the UI needs to know about a language: can we start a server, and if
/// not, what does the user install?
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAvailability {
    pub language_id: String,
    pub command: String,
    pub available: bool,
    pub install_hint: String,
}

/// Probes whether the server for a language is on PATH. Called before the
/// first file of that language opens, so the editor never waits on a spawn
/// that cannot succeed.
#[tauri::command]
pub async fn lsp_availability(language_id: String) -> Result<Option<ServerAvailability>, String> {
    let Some(spec) = spec_for(&language_id) else {
        return Ok(None);
    };
    let available = match spec.probe {
        Probe::OnPath => resolves_on_path(spec.command).await,
        Probe::VersionFlag => cli_command(spec.command, ["--version"])
            .output()
            .await
            .is_ok_and(|output| output.status.success()),
    };
    Ok(Some(ServerAvailability {
        language_id: spec.language_id.to_string(),
        command: spec.command.to_string(),
        available,
        install_hint: spec.install_hint.to_string(),
    }))
}

/// Whether the operating system can find this executable at all.
async fn resolves_on_path(command: &str) -> bool {
    let finder = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    cli_command(finder, [command])
        .output()
        .await
        .is_ok_and(|output| output.status.success())
}

/// Starts the language server for `language_id` in `root` and streams its
/// messages to the calling window as `lsp:message`. Returns the server id used
/// by `lsp_send` / `lsp_stop`.
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    window: Window,
    state: State<'_, LspState>,
    language_id: String,
    root: String,
) -> Result<u64, String> {
    let spec = spec_for(&language_id).ok_or_else(|| format!("No language server for {language_id}"))?;

    let mut child = cli_command(spec.command, spec.args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // servers log verbosely; their JSON is what matters
        .spawn()
        .map_err(|e| format!("LSP_MISSING::{}::{e}", spec.command))?;

    let mut stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let server_id = SERVER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();

    // Writer task: owns stdin, so senders never block on the pipe.
    let (outgoing, mut queue) = unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = queue.recv().await {
            if stdin.write_all(frame(&message).as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    // Driver task: relays server output until EOF or shutdown, then reaps.
    let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let app = app.clone();
        let label = label.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    message = read_message(&mut reader) => match message {
                        Ok(Some(message)) => {
                            let payload = MessagePayload { server_id, message };
                            if app.emit_to(&label, MESSAGE_EVENT, payload).is_err() {
                                break;
                            }
                        }
                        _ => break,
                    },
                }
            }
            let _ = child.kill().await;
            if let Some(state) = app.try_state::<LspState>() {
                state.sessions().remove(&server_id);
            }
            let _ = app.emit_to(&label, EXIT_EVENT, ExitPayload { server_id });
        });
    }

    state.sessions().insert(
        server_id,
        Session {
            outgoing,
            shutdown: Some(shutdown),
            window_label: label,
        },
    );
    Ok(server_id)
}

/// Reads one framed message; `None` once the server closes its output.
async fn read_message<R>(reader: &mut BufReader<R>) -> std::io::Result<Option<String>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut length = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await? == 0 {
            return Ok(None); // EOF
        }
        if header.trim().is_empty() {
            break; // blank line ends the header block
        }
        length = content_length(&header).or(length);
    }
    let Some(length) = length else {
        // A header block without a length is unusable; skipping it keeps the
        // stream alive instead of desynchronizing it forever.
        return Ok(Some(String::new()));
    };
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(String::from_utf8_lossy(&body).to_string()))
}

/// Forwards one JSON-RPC message to a running server.
#[tauri::command]
pub fn lsp_send(state: State<'_, LspState>, server_id: u64, message: String) -> Result<(), String> {
    let sessions = state.sessions();
    let session = sessions
        .get(&server_id)
        .ok_or_else(|| format!("language server {server_id} is not running"))?;
    session
        .outgoing
        .send(message)
        .map_err(|_| "language server stopped".to_string())
}

/// Stops a server; the driver task then emits `lsp:exit`.
#[tauri::command]
pub fn lsp_stop(state: State<'_, LspState>, server_id: u64) -> Result<(), String> {
    if let Some(mut session) = state.sessions().remove(&server_id) {
        if let Some(shutdown) = session.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    Ok(())
}

/// Stops every server owned by a window; called when that window is destroyed.
pub fn stop_for_window(window: &Window) {
    let state = window.state::<LspState>();
    let mut sessions = state.sessions();
    sessions.retain(|_, session| {
        if session.window_label == window.label() {
            if let Some(shutdown) = session.shutdown.take() {
                let _ = shutdown.send(());
            }
            false
        } else {
            true
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{content_length, frame, spec_for, Probe};

    #[test]
    fn framing_counts_bytes_not_characters() {
        let message = r#"{"id":1,"method":"tên"}"#;
        let framed = frame(message);
        assert!(framed.starts_with(&format!("Content-Length: {}\r\n\r\n", message.len())));
        assert!(framed.ends_with(message));
        assert!(
            message.len() > message.chars().count(),
            "the fixture is multibyte"
        );
    }

    #[test]
    fn the_header_name_is_case_insensitive() {
        assert_eq!(content_length("Content-Length: 42"), Some(42));
        assert_eq!(content_length("content-length:42\r\n"), Some(42));
        assert_eq!(content_length("CONTENT-LENGTH: 7"), Some(7));
    }

    #[test]
    fn other_headers_and_junk_carry_no_length() {
        assert_eq!(content_length("Content-Type: application/vscode-jsonrpc"), None);
        assert_eq!(content_length("Content-Length: not-a-number"), None);
        assert_eq!(content_length("no colon here"), None);
    }

    #[test]
    fn detection_matches_how_each_server_actually_behaves() {
        // Measured: these exit 1 on --version, so presence is the only signal.
        for language in ["python", "php", "sql", "dockerfile"] {
            assert_eq!(
                spec_for(language).expect("served").probe,
                Probe::OnPath,
                "{language} answers nothing to --version"
            );
        }
        // rust-analyzer is a rustup proxy: on PATH proves nothing.
        assert_eq!(spec_for("rust").expect("served").probe, Probe::VersionFlag);
    }

    #[test]
    fn every_language_the_user_asked_for_is_covered() {
        for language in [
            "csharp",
            "html",
            "css",
            "go",
            "python",
            "java",
            "c",
            "cpp",
            "typescript",
            "rust",
            "php",
            "sql",
        ] {
            // HTML and CSS are served by Monaco itself, so they need no spec.
            let covered = spec_for(language).is_some() || matches!(language, "html" | "css");
            assert!(covered, "{language} has no code intelligence path");
        }
    }

    #[test]
    fn javascript_reuses_the_typescript_server_and_unknown_languages_have_none() {
        let ts = spec_for("typescript").expect("typescript is served");
        let js = spec_for("javascript").expect("javascript is served");
        assert_eq!(ts.command, js.command);
        assert!(spec_for("cobol").is_none());
    }
}
