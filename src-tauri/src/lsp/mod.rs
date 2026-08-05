//! Language servers (ARCHITECTURE.md §5). Aime speaks LSP to the same servers
//! VS Code uses, so code intelligence is as good as theirs without us writing
//! a single language analyzer. This module is only the transport: it spawns a
//! server, frames messages both ways, and relays JSON to the window that owns
//! it — protocol semantics live on the frontend, next to Monaco.

pub mod edits;

use crate::providers::cli_command;
use crate::wire::{frame, read_message};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::io::{AsyncWriteExt, BufReader};
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
    /// Set when the server has no package to install and Aime fetches it itself
    /// (`archive.rs`), the same contract the debug adapters use.
    pub archive: Option<ServerArchive>,
    /// A notification the server needs after `initialized` before it will
    /// analyse anything. Roslyn is the case: without it the workspace is empty
    /// and every completion request answers nothing (measured).
    pub project_open: Option<ProjectOpen>,
}

/// `ProjectOpen`, as the frontend receives it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenMethods {
    pub solution_method: String,
    pub project_method: String,
}

/// A server distributed as an archive rather than as a package.
pub struct ServerArchive {
    pub url: &'static str,
    /// Folder under Aime's servers directory this archive is unpacked into. A
    /// nupkg spills `content/`, `lib/` and `_rels/` straight into the current
    /// directory, so each one gets its own room.
    pub folder: &'static str,
    /// A folder the archive must create inside that one - how "downloaded" is
    /// told from "not yet".
    pub contains: &'static str,
    /// The executable, relative to the servers directory.
    pub binary: &'static str,
    /// Roughly how big the download is, for the sentence shown before it runs.
    pub size_hint: &'static str,
}

/// How a server is told which project to analyse. Two methods because the
/// argument shape differs: a solution is one uri, projects are a list (measured
/// against Roslyn - handing a `.csproj` to `solution/open` throws
/// `InvalidProjectFileException` inside MSBuild).
#[derive(Clone, Copy)]
pub struct ProjectOpen {
    pub solution_method: &'static str,
    pub project_method: &'static str,
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
    /// Aime downloaded it: the binary in its own data folder is the answer, and
    /// PATH has nothing to do with it.
    Archive,
    /// Present on PATH means installed. Correct for real binaries and for npm
    /// shims, which only exist once their package is installed.
    OnPath,
    /// `--version` must exit 0. Needed where the name on PATH is a launcher
    /// for something that may not be there: `rust-analyzer` is a rustup proxy
    /// that exists even when the component was never added.
    VersionFlag,
}

/// The Roslyn language server, pinned like every other archive Aime fetches: a
/// machine set up today and one set up next month must behave the same.
///
/// Measured 2026-08-04: the runnable build is in `content/LanguageServer/win-x64`
/// of the platform package - `lib/net9.0` alone cannot start (it is missing
/// `System.CommandLine`). The whole recipe is in ARCHITECTURE.md §5.
const ROSLYN_PACKAGE_URL: &str = "https://api.nuget.org/v3-flatcontainer/microsoft.codeanalysis.languageserver.win-x64/5.0.0-1.25277.114/microsoft.codeanalysis.languageserver.win-x64.5.0.0-1.25277.114.nupkg";

/// Where the executable lands, relative to Aime's servers directory. The nupkg
/// unpacks into `content/`, so the folder Aime watches for is that.
const ROSLYN_BINARY: &str = "roslyn/content/LanguageServer/win-x64/Microsoft.CodeAnalysis.LanguageServer.exe";

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
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "javascript",
        command: "typescript-language-server",
        args: &["--stdio"],
        install_hint: "npm install -g typescript-language-server typescript",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "python",
        command: "pyright-langserver",
        args: &["--stdio"],
        install_hint: "npm install -g pyright",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "go",
        command: "gopls",
        args: &[],
        install_hint: "go install golang.org/x/tools/gopls@latest",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "rust",
        command: "rust-analyzer",
        args: &[],
        install_hint: "rustup component add rust-analyzer",
        probe: Probe::VersionFlag,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "csharp",
        // The Roslyn language server, which is what VS Code's C# extension runs.
        // `--logLevel` and `--extensionLogDirectory` are both required by the
        // server itself, and `{logDir}` is filled in with Aime's own data folder.
        command: ROSLYN_BINARY,
        args: &[
            "--stdio",
            "--logLevel",
            "Information",
            "--extensionLogDirectory",
            "{logDir}",
        ],
        install_hint: "Roslyn language server (65 MB, Aime downloads it)",
        probe: Probe::Archive,
        archive: Some(ServerArchive {
            url: ROSLYN_PACKAGE_URL,
            folder: "roslyn",
            contains: "content",
            binary: ROSLYN_BINARY,
            size_hint: "65 MB",
        }),
        project_open: Some(ProjectOpen {
            solution_method: "solution/open",
            project_method: "project/open",
        }),
    },
    ServerSpec {
        language_id: "php",
        command: "intelephense",
        args: &["--stdio"],
        install_hint: "npm install -g intelephense",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "sql",
        command: "sql-language-server",
        args: &["up", "--method", "stdio"],
        install_hint: "npm install -g sql-language-server",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "shell",
        command: "bash-language-server",
        args: &["start"],
        install_hint: "npm install -g bash-language-server",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "yaml",
        command: "yaml-language-server",
        args: &["--stdio"],
        install_hint: "npm install -g yaml-language-server",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "dockerfile",
        command: "docker-langserver",
        args: &["--stdio"],
        install_hint: "npm install -g dockerfile-language-server-nodejs",
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    // clangd serves C and C++; it ships inside LLVM rather than as a package.
    ServerSpec {
        language_id: "cpp",
        command: "clangd",
        args: &[],
        install_hint: CLANGD_INSTALL,
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
    },
    ServerSpec {
        language_id: "c",
        command: "clangd",
        args: &[],
        install_hint: CLANGD_INSTALL,
        probe: Probe::OnPath,
        archive: None,
        project_open: None,
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
        archive: None,
        project_open: None,
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

/// What the UI needs to know about a language: can we start a server, and if
/// not, what does the user install?
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAvailability {
    pub language_id: String,
    pub command: String,
    pub available: bool,
    pub install_hint: String,
    /// Set when the server needs to be told which project to analyse after
    /// `initialized`; the two method names differ by argument shape.
    pub project_open: Option<ProjectOpenMethods>,
    /// True when Aime downloads this server itself rather than the user.
    pub downloadable: bool,
    /// Whether the program that would perform the install is on this machine.
    ///
    /// False means the hint is documentation rather than something Aime can run:
    /// `go install …` without Go, a JDK download page. Offering a command that
    /// cannot work is worse than not offering one - that case belongs to the AI,
    /// which can install the toolchain first.
    pub installable: bool,
}

/// Where Aime keeps the language servers it downloaded itself.
pub fn servers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("language-servers"))
}

/// Where a downloaded server is told to write its own logs. Its own folder, so
/// a server that logs generously does not bury the rest of Aime's data.
fn server_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = servers_dir(app)?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The command that starts a server on this machine: the name on PATH, or the
/// executable Aime unpacked. `None` means a downloadable server is not here yet.
fn resolved_command(app: &AppHandle, spec: &ServerSpec) -> Option<String> {
    let Some(archive) = &spec.archive else {
        return Some(spec.command.to_string());
    };
    let binary = servers_dir(app).ok()?.join(archive.binary);
    binary.is_file().then(|| binary.to_string_lossy().to_string())
}

/// Fills the one placeholder a server's arguments may carry.
fn resolved_args(app: &AppHandle, spec: &ServerSpec) -> Result<Vec<String>, String> {
    let log_dir = if spec.args.iter().any(|arg| arg.contains("{logDir}")) {
        server_log_dir(app)?.to_string_lossy().to_string()
    } else {
        String::new()
    };
    Ok(spec
        .args
        .iter()
        .map(|arg| arg.replace("{logDir}", &log_dir))
        .collect())
}

/// Downloads a server that has no package to install, reporting every step.
#[tauri::command]
pub async fn lsp_download(app: AppHandle, language_id: String) -> Result<(), String> {
    let spec = spec_for(&language_id).ok_or_else(|| format!("No language server for {language_id}"))?;
    let archive = spec
        .archive
        .as_ref()
        .ok_or_else(|| format!("{} is installed with its own package manager", spec.command))?;
    let dir = servers_dir(&app)?.join(archive.folder);
    crate::archive::fetch_and_unpack(archive.url, &dir, archive.contains, archive.folder, |_| ()).await
}

/// The solution or projects a server should be told to open.
///
/// A solution wins when there is one: it is what the toolchain itself considers
/// the unit of work, and Roslyn loads every project in it. Otherwise every
/// project file found near the root is offered, because a repository with two of
/// them has two, and analysing one is analysing half the code.
#[tauri::command]
pub fn lsp_project_files(root: String) -> ProjectFiles {
    let root = std::path::Path::new(&root);
    let mut solutions = Vec::new();
    let mut projects = Vec::new();
    // Two levels: `src/Api/Api.csproj` is normal, deeper is somebody else's tree.
    for dir in [root.to_path_buf()]
        .into_iter()
        .chain(child_dirs(root))
        .chain(child_dirs(root).flat_map(|dir| child_dirs(&dir).collect::<Vec<_>>()))
    {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.to_string_lossy().to_lowercase();
            if name.ends_with(".sln") || name.ends_with(".slnx") {
                solutions.push(path.to_string_lossy().to_string());
            } else if name.ends_with(".csproj") || name.ends_with(".fsproj") {
                projects.push(path.to_string_lossy().to_string());
            }
        }
    }
    solutions.sort();
    projects.sort();
    ProjectFiles { solutions, projects }
}

/// Directories worth looking inside, skipping the noisy ones.
fn child_dirs(dir: &std::path::Path) -> impl Iterator<Item = PathBuf> + use<> {
    let entries = std::fs::read_dir(dir).ok();
    entries.into_iter().flatten().flatten().filter_map(|entry| {
        let path = entry.path();
        let keep = path.is_dir()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with('.') && !crate::fs_cmds::IGNORED_DIRS.contains(&name));
        keep.then_some(path)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    pub solutions: Vec<String>,
    pub projects: Vec<String>,
}

/// Probes whether the server for a language is on PATH. Called before the
/// first file of that language opens, so the editor never waits on a spawn
/// that cannot succeed.
#[tauri::command]
pub async fn lsp_availability(
    app: AppHandle,
    language_id: String,
) -> Result<Option<ServerAvailability>, String> {
    let Some(spec) = spec_for(&language_id) else {
        return Ok(None);
    };
    let available = match spec.probe {
        Probe::Archive => spec
            .archive
            .as_ref()
            .is_some_and(|_| resolved_command(&app, spec).is_some()),
        Probe::OnPath => resolves_on_path(spec.command).await,
        Probe::VersionFlag => cli_command(spec.command, ["--version"])
            .output()
            .await
            .is_ok_and(|output| output.status.success()),
    };
    // Only asked when it matters: a server that is already here needs no install.
    let installable = if available {
        true
    } else {
        match spec.install_hint.split_whitespace().next() {
            Some(program) if !program.starts_with("http") => {
                crate::environment::version_of(program).await.is_some()
            }
            _ => false,
        }
    };
    Ok(Some(ServerAvailability {
        project_open: spec.project_open.map(|open| ProjectOpenMethods {
            solution_method: open.solution_method.to_string(),
            project_method: open.project_method.to_string(),
        }),
        downloadable: spec.archive.is_some(),
        language_id: spec.language_id.to_string(),
        command: spec.command.to_string(),
        available,
        install_hint: spec.install_hint.to_string(),
        installable,
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

    let program = resolved_command(&app, spec)
        .ok_or_else(|| format!("LSP_MISSING::{}::not downloaded yet", spec.command))?;
    let args = resolved_args(&app, spec)?;
    // The long form of the path: measured, the Roslyn project loader throws
    // ("Unexpected false - LanguageServerProjectLoader.cs line 193") when it is
    // handed an 8.3 short path such as `C:\\Users\\LINHPH~1.STS`, which is exactly
    // what a Windows temp folder looks like.
    let root = dunce::canonicalize(&root)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or(root);
    let mut child = cli_command(&program, &args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // servers log verbosely; their JSON is what matters
        .spawn()
        .map_err(|e| format!("LSP_MISSING::{program}::{e}"))?;

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
    use super::{spec_for, Probe};

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
