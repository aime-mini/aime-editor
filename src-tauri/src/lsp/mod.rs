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
use std::path::{Path, PathBuf};
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
    /// What the unpacked archive gives Aime to start.
    pub binary: ServerBinary,
    /// Roughly how big the download is, for the sentence shown before it runs.
    pub size_hint: &'static str,
}

/// The two shapes an archive comes in.
pub enum ServerBinary {
    /// An executable of its own, at this path under the servers directory: the
    /// Roslyn server is one, and the file being there is what proves the unpack.
    Executable(&'static str),
    /// No executable at all. The archive is code for the runtime named by
    /// `ServerSpec::command`, which has to be on the machine already and no older
    /// than this major version: JDT LS is a set of OSGi jars, so the program is
    /// the JVM and the jars reach it through the arguments. Aime does not install
    /// runtimes - a machine without a JDK is the agent's job, not a bare command.
    ForRuntime { least_major_version: u32 },
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

/// Eclipse JDT LS, pinned for the same reason Roslyn is.
///
/// 1.39.0 and not the newest: 1.40 and later require a JVM of 21 or newer, while
/// 1.39.0 asks only for 17 - so this build serves the widest set of machines, and
/// it is the one measured against this project's Java debugging (ARCHITECTURE §5).
const JDTLS_URL: &str =
    "https://download.eclipse.org/jdtls/milestones/1.39.0/jdt-language-server-1.39.0-202408291433.tar.gz";

/// Folder the tarball is unpacked into, under Aime's servers directory.
const JDTLS_FOLDER: &str = "jdtls";

/// The oldest JVM that can run it, which its own launcher script enforces too.
const JDTLS_LEAST_JAVA: u32 = 17;

/// The release ships one configuration directory per platform.
#[cfg(target_os = "windows")]
const JDTLS_CONFIG_DIR: &str = "config_win";
#[cfg(target_os = "macos")]
const JDTLS_CONFIG_DIR: &str = "config_mac";
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const JDTLS_CONFIG_DIR: &str = "config_linux";

/// How JDT LS is started - read from the launcher script the release ships
/// (`bin/jdtls.py`) rather than invented, because none of it is a matter of taste.
///
/// The OSGi properties are the part worth knowing: the configuration directory
/// inside the release is *shared and read-only*, and each instance keeps its own
/// writable copy under `-data`. So Aime never writes into the install, and the
/// second JDT LS on this machine - the one that hosts the Java debug adapter
/// (§5) - cannot collide with the one serving completions.
const JDTLS_ARGS: &[&str] = &[
    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
    "-Dosgi.bundles.defaultStartLevel=4",
    "-Declipse.product=org.eclipse.jdt.ls.core.product",
    "-Dosgi.checkConfiguration=true",
    "-Dosgi.sharedConfiguration.area={jdtlsConfig}",
    "-Dosgi.sharedConfiguration.area.readOnly=true",
    "-Dosgi.configuration.cascaded=true",
    "-Xms1G",
    "--add-modules=ALL-SYSTEM",
    "--add-opens",
    "java.base/java.util=ALL-UNNAMED",
    "--add-opens",
    "java.base/java.lang=ALL-UNNAMED",
    "-jar",
    "{jdtlsLauncher}",
    "-data",
    "{jdtlsWorkspace}",
];

/// Placeholders `resolved_args` fills in, each only when an argument names it.
const LOG_DIR: &str = "{logDir}";
const JDTLS_CONFIG: &str = "{jdtlsConfig}";
const JDTLS_LAUNCHER: &str = "{jdtlsLauncher}";
const JDTLS_WORKSPACE: &str = "{jdtlsWorkspace}";

/// The phrase that marks a hint Aime can act on by itself (`environment.rs`
/// reads it, and a test keeps every archive's hint saying it).
pub(crate) const AIME_DOWNLOADS: &str = "Aime downloads it";

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
            binary: ServerBinary::Executable(ROSLYN_BINARY),
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
    // Eclipse JDT LS is published as an archive and runs on the JVM, so `java` is
    // the program and the jars are arguments. Measured 2026-08-06: handed nothing
    // but Aime's own `initialize`, it answers 44 completions for `System.out.`
    // and 50 for a String in a folder with no Maven or Gradle in sight - it builds
    // an "invisible project" for loose sources - which is why no `project_open` is
    // needed here and no settings are sent.
    ServerSpec {
        language_id: "java",
        command: "java",
        args: JDTLS_ARGS,
        install_hint: "Eclipse JDT LS (45 MB, Aime downloads it)",
        probe: Probe::Archive,
        archive: Some(ServerArchive {
            url: JDTLS_URL,
            folder: JDTLS_FOLDER,
            contains: "plugins",
            binary: ServerBinary::ForRuntime {
                least_major_version: JDTLS_LEAST_JAVA,
            },
            size_hint: "45 MB",
        }),
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

/// The command that starts a server on this machine: the name on PATH, the
/// executable Aime unpacked, or the runtime that loads what Aime unpacked.
/// `None` means a downloadable server is not on this machine yet.
fn resolved_command(app: &AppHandle, spec: &ServerSpec) -> Option<String> {
    let Some(archive) = &spec.archive else {
        return Some(spec.command.to_string());
    };
    match archive.binary {
        ServerBinary::Executable(binary) => {
            let path = servers_dir(app).ok()?.join(binary);
            path.is_file().then(|| path.to_string_lossy().to_string())
        }
        // The runtime is the program; the archive only has to be somewhere.
        ServerBinary::ForRuntime { .. } => unpacked_home(app, archive).map(|_| spec.command.to_string()),
    }
}

/// Where an archive is unpacked on this machine, if it is here at all.
///
/// Two folders, both Aime's own: where a download of its own lands, and where the
/// debug adapters live. The second one is not a guess - one program can hold both
/// jobs. JDT LS is the Java language server *and* the process the java-debug
/// bundle runs inside (ARCHITECTURE §5), so a machine already set up for Java
/// debugging has these 68 MB, and fetching a second copy of them would be Aime
/// wasting the user's disk.
fn unpacked_home(app: &AppHandle, archive: &ServerArchive) -> Option<PathBuf> {
    [
        servers_dir(app).ok()?,
        crate::dap::catalog::adapters_dir(app).ok()?,
    ]
    .into_iter()
    .map(|dir| dir.join(archive.folder))
    .find(|home| home.join(archive.contains).is_dir())
}

/// The Equinox launcher jar inside a JDT LS install.
///
/// Found rather than named, exactly as the release's own launcher script does it:
/// the file carries its own version (`org.eclipse.equinox.launcher_1.6.900…jar`),
/// and the install Aime reuses may be a different JDT LS build than the pinned one.
fn jdtls_launcher(home: &Path) -> Result<PathBuf, String> {
    let plugins = home.join("plugins");
    let mut jars: Vec<PathBuf> = std::fs::read_dir(&plugins)
        .map_err(|e| format!("Could not read {}: {e}", plugins.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            name.starts_with("org.eclipse.equinox.launcher_") && name.ends_with(".jar")
        })
        .collect();
    // Sorted, so a folder holding two builds always starts the same one.
    jars.sort();
    jars.pop()
        .ok_or_else(|| format!("No Equinox launcher in {}", plugins.display()))
}

/// One JDT LS workspace per project, created on demand.
///
/// Per project because the workspace is that project's index: sharing one would
/// make two projects fight over the same lock, and JDT LS's own launcher derives
/// it from the working directory for the same reason. The name keeps the folder
/// recognisable and adds a digest of the full path, so two checkouts called
/// `api` never land in one workspace.
fn jdtls_workspace(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let name = root
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("project");
    let readable: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = servers_dir(app)?
        .join("jdtls-workspaces")
        .join(format!("{readable}-{:x}", path_digest(root)));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A stable digest of a project path.
///
/// FNV-1a, written out rather than taken from `DefaultHasher`, whose output the
/// standard library is free to change between Rust releases: that would silently
/// orphan every workspace Aime had already built. Case is folded because Windows
/// hands out the same directory under more than one spelling.
fn path_digest(path: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    path.to_lowercase()
        .bytes()
        .fold(OFFSET, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(PRIME))
}

/// Fills the placeholders a server's arguments carry.
///
/// Each value is worked out only when an argument names it: two of them create a
/// directory, and a server that never mentions them must not pay for that.
fn resolved_args(app: &AppHandle, spec: &ServerSpec, root: &str) -> Result<Vec<String>, String> {
    let jdtls_home = || {
        spec.archive
            .as_ref()
            .and_then(|archive| unpacked_home(app, archive))
            .ok_or_else(|| format!("{} is not on this machine", spec.command))
    };
    let mut args = Vec::with_capacity(spec.args.len());
    for arg in spec.args {
        let filled = if arg.contains(LOG_DIR) {
            arg.replace(LOG_DIR, &path_text(server_log_dir(app)?))
        } else if arg.contains(JDTLS_CONFIG) {
            arg.replace(JDTLS_CONFIG, &path_text(jdtls_home()?.join(JDTLS_CONFIG_DIR)))
        } else if arg.contains(JDTLS_LAUNCHER) {
            arg.replace(JDTLS_LAUNCHER, &path_text(jdtls_launcher(&jdtls_home()?)?))
        } else if arg.contains(JDTLS_WORKSPACE) {
            arg.replace(JDTLS_WORKSPACE, &path_text(jdtls_workspace(app, root)?))
        } else {
            (*arg).to_string()
        };
        args.push(filled);
    }
    Ok(args)
}

fn path_text(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
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

/// Restores NuGet packages for the solution or projects a language server
/// asked the client to fetch (`workspace/_roslyn_projectNeedsRestore`).
///
/// Roslyn never restores on its own — that is the client's job, exactly as in
/// VS Code. Without it a project loads with every reference missing (measured
/// 2026-08-12 on a project with no `project.assets.json`: 132× CS0234, member
/// completions empty while keyword completions work). Paths run one at a time
/// because two restores fight over NuGet's own locks.
#[tauri::command]
pub async fn lsp_restore(paths: Vec<String>) -> Result<(), String> {
    for path in &paths {
        let output = cli_command("dotnet", ["restore", path])
            .output()
            .await
            .map_err(|e| format!("Could not run dotnet restore: {e}"))?;
        if !output.status.success() {
            // NuGet writes its verdict to stdout; stderr is often empty.
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = if stderr.trim().is_empty() { stdout } else { stderr };
            let last_line = detail.lines().rev().find(|line| !line.trim().is_empty());
            return Err(format!(
                "dotnet restore failed for {path}: {}",
                last_line.unwrap_or("no output").trim()
            ));
        }
    }
    Ok(())
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
    // A runtime-hosted server needs its runtime as much as its own files, so both
    // questions decide every answer below: without a JDK, 45 MB of JDT LS jars
    // cannot serve one completion, and offering that download would be a promise
    // Aime could not keep.
    let runtime = runtime_ready(spec).await;
    let available = match spec.probe {
        Probe::Archive => runtime && resolved_command(&app, spec).is_some(),
        Probe::OnPath => resolves_on_path(spec.command).await,
        Probe::VersionFlag => cli_command(spec.command, ["--version"])
            .output()
            .await
            .is_ok_and(|output| output.status.success()),
    };
    // Only asked when it matters: a server that is already here needs no install.
    let installable = available || (runtime && crate::environment::can_run_install(spec.install_hint).await);
    Ok(Some(ServerAvailability {
        project_open: spec.project_open.map(|open| ProjectOpenMethods {
            solution_method: open.solution_method.to_string(),
            project_method: open.project_method.to_string(),
        }),
        downloadable: spec.archive.is_some() && runtime,
        language_id: spec.language_id.to_string(),
        command: spec.command.to_string(),
        available,
        install_hint: spec.install_hint.to_string(),
        installable,
    }))
}

/// Whether a server that runs on a runtime has one it can run on.
///
/// True for every other server: they either are the executable or bring it. The
/// only runtime today is a JVM, so that is the one version string read; a second
/// one would need its own reading of what it prints about itself.
async fn runtime_ready(spec: &ServerSpec) -> bool {
    let Some(ServerBinary::ForRuntime { least_major_version }) =
        spec.archive.as_ref().map(|archive| &archive.binary)
    else {
        return true;
    };
    java_major_version(spec.command)
        .await
        .is_some_and(|major| major >= *least_major_version)
}

/// The major version of a JVM, from what it says about itself.
///
/// Measured 2026-08-06: `java -version` writes `java version "20.0.1" …` to
/// **stderr**, which every JDK has done since 1.0, while `java --version` on
/// stdout only exists from 9 onwards - so the old form is the one that answers
/// for all of them, and both streams are read because a wrapper may relay either.
async fn java_major_version(command: &str) -> Option<u32> {
    let output = cli_command(command, ["-version"]).output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    java_major_of(&format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    ))
}

/// Reads the major version out of a JVM's own version line. Every JDK quotes it,
/// and `1.8.0_401` means 8 rather than 1 - the old naming for Java 8 and older.
fn java_major_of(spoken: &str) -> Option<u32> {
    let mut parts = spoken.split('"').nth(1)?.split('.');
    let first = parts.next()?.parse::<u32>().ok()?;
    if first == 1 {
        return parts.next()?.parse::<u32>().ok();
    }
    Some(first)
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
    // The long form of the path: measured, the Roslyn project loader throws
    // ("Unexpected false - LanguageServerProjectLoader.cs line 193") when it is
    // handed an 8.3 short path such as `C:\\Users\\LINHPH~1.STS`, which is exactly
    // what a Windows temp folder looks like. Resolved before the arguments are,
    // so a per-project workspace is named after the path the server will see.
    let root = dunce::canonicalize(&root)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or(root);
    let args = resolved_args(&app, spec, &root)?;
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
    use super::{
        java_major_of, path_digest, spec_for, Probe, ServerBinary, AIME_DOWNLOADS, JDTLS_ARGS, JDTLS_CONFIG,
        JDTLS_LAUNCHER, JDTLS_LEAST_JAVA, JDTLS_WORKSPACE, SERVERS,
    };

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

    /// The phrase is the contract between the table and `environment.rs`: a
    /// download whose hint forgot to say it offers no button anywhere in the UI,
    /// because every install button asks `can_run_install` first.
    #[test]
    fn every_server_aime_downloads_says_so_in_its_hint() {
        for spec in SERVERS.iter().filter(|spec| spec.archive.is_some()) {
            assert!(
                spec.install_hint.contains(AIME_DOWNLOADS),
                "{} is downloaded by Aime but its hint does not say so: {}",
                spec.language_id,
                spec.install_hint
            );
        }
    }

    /// JDT LS is the one server that is not a program: `java` runs it, and every
    /// path it needs arrives as a placeholder. A missing one would be passed to
    /// the JVM verbatim, which fails with an Equinox error nobody can read.
    #[test]
    fn java_is_started_by_the_jvm_with_every_path_it_needs() {
        let java = spec_for("java").expect("java is served");
        assert_eq!(java.command, "java");
        assert!(matches!(
            java.archive.as_ref().map(|archive| &archive.binary),
            Some(ServerBinary::ForRuntime { least_major_version }) if *least_major_version == JDTLS_LEAST_JAVA
        ));
        for placeholder in [JDTLS_CONFIG, JDTLS_LAUNCHER, JDTLS_WORKSPACE] {
            assert!(
                JDTLS_ARGS.iter().any(|arg| arg.contains(placeholder)),
                "JDT LS is started without {placeholder}"
            );
        }
    }

    /// Measured strings, one per JDK generation, because the shape changed at 9.
    #[test]
    fn a_jvm_version_line_is_read_the_way_every_jdk_writes_it() {
        assert_eq!(java_major_of("java version \"20.0.1\" 2023-04-18"), Some(20));
        assert_eq!(java_major_of("openjdk version \"21.0.3\" 2024-04-16"), Some(21));
        // Java 8 and older name themselves 1.x; the major version is the second part.
        assert_eq!(java_major_of("java version \"1.8.0_401\""), Some(8));
        assert_eq!(java_major_of("bash: java: command not found"), None);
    }

    /// The digest names a workspace folder, so it has to be stable for the same
    /// project and different for another - including the same name elsewhere.
    #[test]
    fn a_project_workspace_is_named_the_same_way_every_time() {
        assert_eq!(path_digest(r"C:\Projects\api"), path_digest(r"c:\projects\API"));
        assert_ne!(path_digest(r"C:\Projects\api"), path_digest(r"C:\Work\api"));
    }

    #[test]
    fn javascript_reuses_the_typescript_server_and_unknown_languages_have_none() {
        let ts = spec_for("typescript").expect("typescript is served");
        let js = spec_for("javascript").expect("javascript is served");
        assert_eq!(ts.command, js.command);
        assert!(spec_for("cobol").is_none());
    }

    /// Nothing asked for means nothing to run - and no `dotnet` spawned to say so.
    #[tokio::test]
    async fn restoring_nothing_succeeds_without_running_anything() {
        assert_eq!(super::lsp_restore(Vec::new()).await, Ok(()));
    }

    /// The error carries NuGet's own last line, which is the part worth reading.
    /// (Runs the real `dotnet`; the machine this repo develops on has it.)
    #[tokio::test]
    async fn a_failed_restore_reports_which_project_and_why() {
        let missing = r"C:\does\not\exist\Nope.csproj";
        let error = super::lsp_restore(vec![missing.to_string()])
            .await
            .expect_err("restoring a project that does not exist must fail");
        assert!(error.contains("Nope.csproj"), "error names the project: {error}");
    }
}
