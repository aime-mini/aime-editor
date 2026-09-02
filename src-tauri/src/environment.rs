//! What Aime found on this machine, reported before a folder is even open.
//!
//! The welcome screen is where a new user decides whether the app works for
//! them; discovering a missing CLI three clicks later is worse than being told
//! up front. Nothing here installs anything — Aime reports and gives the exact
//! command, the same contract the AI panel already follows.

use crate::mcp::tokenize_command;
use crate::providers::{adapter::adapter_for, cli_command, provider_health};
use serde::Serialize;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

/// One tool Aime can use, and whether this machine has it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub version: Option<String>,
    /// `None` when the tool has no sign-in, or offers no way to check.
    pub signed_in: Option<bool>,
    /// How to get it; empty when the tool ships with the operating system.
    pub install_hint: String,
    /// true when Aime is unusable without it, false when it only adds features.
    pub required: bool,
    /// Whether Aime could run the install here: the hint is a command, and the
    /// program that command runs is on this machine. A download page is not an
    /// install, and `go install …` without Go is a spawn failure - offering
    /// either as a button is a promise the row cannot keep.
    pub installable: bool,
}

/// What can be done about a missing tool, read from its hint alone.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InstallRoute {
    /// Aime fetches it itself (`archive.rs`), so nothing else has to be present.
    Download,
    /// A command line, named by the program that would run it.
    Command(String),
    /// A page for a person to read: a JDK, Git, LLVM. Not something to run.
    Documentation,
}

pub(crate) fn install_route(install_hint: &str) -> InstallRoute {
    if install_hint.contains(crate::lsp::AIME_DOWNLOADS) {
        return InstallRoute::Download;
    }
    match install_hint.split_whitespace().next() {
        Some(program) if !program.starts_with("http") => InstallRoute::Command(program.to_string()),
        _ => InstallRoute::Documentation,
    }
}

/// Whether Aime could run this install right now. One rule for the environment
/// rows, the language chips and the banner in the editor, so the three can never
/// disagree about whether a button would work.
pub(crate) async fn can_run_install(install_hint: &str) -> bool {
    match install_route(install_hint) {
        InstallRoute::Download => true,
        InstallRoute::Command(program) => version_of(&program).await.is_some(),
        InstallRoute::Documentation => false,
    }
}

/// AI CLIs, reported with their sign-in state.
const PROVIDERS: [(&str, &str, &str); 2] = [
    (
        "claude",
        "Claude Code",
        "npm install -g @anthropic-ai/claude-code",
    ),
    ("codex", "Codex", "npm install -g @openai/codex"),
];

/// Everything else Aime shells out to.
const TOOLS: [(&str, &str, &str, bool); 2] = [
    ("git", "Git", "https://git-scm.com/downloads", true),
    ("node", "Node.js", "https://nodejs.org", false),
];

/// First line of `<tool> --version`, or `None` when the tool cannot be run.
pub(crate) async fn version_of(command: &str) -> Option<String> {
    let output = cli_command(command, ["--version"]).output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.lines().next().unwrap_or_default().trim().to_string())
}

/// Probes every tool Aime relies on. Never fails: a machine missing
/// everything still gets a full report, which is the point.
#[tauri::command]
pub async fn environment_report(app: AppHandle) -> Vec<ToolStatus> {
    let mut report = Vec::new();

    for (id, label, install_hint) in PROVIDERS {
        // Reuse the AI panel's own probe, so the two can never disagree.
        let health = provider_health(app.clone(), id.to_string()).await.ok();
        let installed = health.as_ref().is_some_and(|h| h.installed);
        report.push(ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            installed,
            version: health.as_ref().and_then(|h| h.version.clone()),
            signed_in: health.as_ref().and_then(|h| h.signed_in),
            installable: !installed && can_run_install(install_hint).await,
            install_hint: install_hint.to_string(),
            // AI is optional by design (ARCHITECTURE.md §1.6).
            required: false,
        });
    }

    for (id, label, install_hint, required) in TOOLS {
        let version = version_of(id).await;
        let installed = version.is_some();
        report.push(ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            installed,
            version,
            signed_in: None,
            installable: !installed && can_run_install(install_hint).await,
            install_hint: install_hint.to_string(),
            required,
        });
    }

    report
}

/// Language servers Aime knows about, for the same "what do I have?" view.
#[tauri::command]
pub async fn language_server_report(app: AppHandle) -> Vec<ToolStatus> {
    let mut report = Vec::new();
    // One row per server, not per language: typescript and javascript share one.
    for language in [
        "typescript",
        "python",
        "go",
        "rust",
        "csharp",
        "php",
        "sql",
        "shell",
        "yaml",
        "dockerfile",
        "cpp",
        "java",
    ] {
        let Ok(Some(availability)) = crate::lsp::lsp_availability(app.clone(), language.to_string()).await
        else {
            continue;
        };
        report.push(ToolStatus {
            id: language.to_string(),
            label: availability.command.clone(),
            installed: availability.available,
            version: None,
            signed_in: None,
            installable: availability.installable,
            install_hint: availability.install_hint,
            required: false,
        });
    }
    // Monaco ships the same language services VS Code uses for these, so a
    // server would only duplicate every suggestion. Listed anyway, because
    // "is my language covered?" deserves an answer rather than a silence.
    for (id, label) in [("html", "HTML"), ("css", "CSS"), ("json", "JSON")] {
        report.push(ToolStatus {
            id: id.to_string(),
            label: format!("{label} (built in)"),
            installed: true,
            version: None,
            signed_in: None,
            installable: false,
            install_hint: String::new(),
            required: false,
        });
    }

    report
}

/// Languages Aime sets itself up for, and the program each install needs.
///
/// The user's list of what must simply work after installing Aime: go, node,
/// TypeScript, JavaScript, HTML, CSS, Python, Rust, C# and SQL. Four of those
/// need nothing at all - Monaco carries HTML, CSS, JavaScript and TypeScript
/// itself - and the rest are here.
///
/// The line is drawn at installs that need no elevation and no toolchain the
/// machine does not already have. npm packages land in the user's own prefix in
/// seconds. `gopls`, `rust-analyzer` and `csharp-ls` are the same kind of thing
/// *provided the toolchain is there* - `go install` without Go is a spawn
/// failure, so the runtime is checked first and the language is simply left
/// alone otherwise. Nothing here pulls a toolchain: a JDK or LLVM stays an
/// explicit offer, and a language with no runtime at all is the AI's job
/// (`lib/aiSetup.ts`), not a bare command in a status bar.
const UNATTENDED_SERVERS: &[(&str, &str)] = &[
    ("typescript", "npm"),
    ("python", "npm"),
    ("php", "npm"),
    ("sql", "npm"),
    ("shell", "npm"),
    ("yaml", "npm"),
    ("dockerfile", "npm"),
    ("go", "go"),
    ("rust", "rustup"),
];

/// Tools Aime sets up by itself on first launch.
#[tauri::command]
pub async fn unattended_setup_targets(app: AppHandle) -> Vec<String> {
    let mut targets = Vec::new();
    for (language, runtime) in UNATTENDED_SERVERS {
        // The install command has to be the one that runtime runs: a table that
        // drifted would otherwise mean checking for `npm` and running `go`.
        let matches_runtime = install_command_for(language)
            .is_some_and(|command| command.split_whitespace().next() == Some(runtime));
        if !matches_runtime || version_of(runtime).await.is_none() {
            continue;
        }
        let missing = matches!(
            crate::lsp::lsp_availability(app.clone(), (*language).to_string()).await,
            Ok(Some(ref availability)) if !availability.available
        );
        if missing {
            targets.push((*language).to_string());
        }
    }
    targets
}

/// Signs in to a provider by handing its own login command to the caller —
/// the welcome screen runs it in a terminal, exactly like the AI panel.
#[tauri::command]
pub fn login_command_for(provider_id: String) -> Result<String, String> {
    Ok(adapter_for(&provider_id)?.login_command().to_string())
}

/// One line of an install run, relayed live so the user watches it happen.
const INSTALL_OUTPUT_EVENT: &str = "install:output";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallLine {
    tool_id: String,
    line: String,
}

/// The install command Aime is willing to run for a tool. Commands come from
/// Aime's own tables, never from the caller: the UI asks to install a known
/// tool, it does not hand over a command line to execute.
fn install_command_for(tool_id: &str) -> Option<String> {
    if let Some(spec) = crate::lsp::spec_for(tool_id) {
        return Some(spec.install_hint.to_string());
    }
    if let Some(hint) = crate::cloud::install_hint_for(tool_id) {
        return Some(hint);
    }
    PROVIDERS
        .iter()
        .find(|(id, _, _)| *id == tool_id)
        .map(|(_, _, hint)| (*hint).to_string())
}

/// Runs the install for a known tool, streaming every line to the window, and
/// answers with the exit code. Nothing is installed silently and nothing is
/// installed that Aime did not itself propose.
#[tauri::command]
pub async fn install_tool(app: AppHandle, tool_id: String) -> Result<i32, String> {
    // A server Aime fetches itself is not a command line: it is a download, and
    // the same log window reports it line by line.
    if let Some(spec) = crate::lsp::spec_for(&tool_id) {
        if let Some(archive) = &spec.archive {
            let emit = |line: String| {
                let _ = app.emit(
                    INSTALL_OUTPUT_EVENT,
                    InstallLine {
                        tool_id: tool_id.clone(),
                        line,
                    },
                );
            };
            emit(format!("Downloading {} ({})", spec.command, archive.size_hint));
            crate::lsp::lsp_download(app.clone(), tool_id.clone()).await?;
            emit("done".to_string());
            return Ok(0);
        }
    }
    let command = install_command_for(&tool_id).ok_or_else(|| format!("Nothing to install for {tool_id}"))?;
    let tokens = tokenize_command(&command);
    let (program, args) = tokens
        .split_first()
        .ok_or_else(|| "Empty install command".to_string())?;
    // A URL is documentation, not something to run (Git, Node).
    if program.starts_with("http") {
        return Err(format!("{command} must be installed by hand"));
    }
    // Every install command needs its own runtime - npm, go, rustup. Saying
    // which one is missing beats letting the user read a spawn failure.
    if version_of(program).await.is_none() {
        return Err(format!("RUNTIME_MISSING::{program}"));
    }

    let emit = |line: String| {
        let _ = app.emit(
            INSTALL_OUTPUT_EVENT,
            InstallLine {
                tool_id: tool_id.clone(),
                line,
            },
        );
    };
    emit(format!("$ {command}"));

    let mut child = cli_command(program, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("{program} is not available: {e}"))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut errors = BufReader::new(stderr).lines();

    // Installers write progress to both streams; the user wants to see both.
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(text)) => emit(text),
                _ => break,
            },
            line = errors.next_line() => {
                if let Ok(Some(text)) = line {
                    emit(text);
                }
            },
        }
    }
    while let Ok(Some(text)) = errors.next_line().await {
        emit(text);
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(-1))
}

#[cfg(test)]
mod tests {
    use super::{install_route, InstallRoute, UNATTENDED_SERVERS};

    /// The three shapes a hint comes in, since which button the UI shows hangs on
    /// this one function: a download Aime performs needs no package manager, a
    /// command needs its own runtime checked, and a link is for a person to read.
    #[test]
    fn a_hint_is_read_as_a_download_a_command_or_a_page() {
        assert_eq!(
            install_route("Eclipse JDT LS (45 MB, Aime downloads it)"),
            InstallRoute::Download
        );
        assert_eq!(
            install_route("npm install -g pyright"),
            InstallRoute::Command("npm".to_string())
        );
        assert_eq!(
            install_route("go install golang.org/x/tools/gopls@latest"),
            InstallRoute::Command("go".to_string())
        );
        assert_eq!(
            install_route("https://git-scm.com/downloads"),
            InstallRoute::Documentation
        );
    }

    /// Every language Aime installs for itself must have a command in the LSP
    /// table, and that command must be the one its declared runtime runs -
    /// otherwise Aime checks for one program and then runs another.
    #[test]
    fn every_unattended_install_is_run_by_the_runtime_it_is_checked_for() {
        for (language, runtime) in UNATTENDED_SERVERS {
            let spec = crate::lsp::spec_for(language)
                .unwrap_or_else(|| panic!("{language} has no language server in the table"));
            assert_eq!(
                spec.install_hint.split_whitespace().next(),
                Some(*runtime),
                "{language} is installed by {}, not by {runtime}",
                spec.install_hint
            );
        }
    }

    /// The ten languages the user asked to simply work: the four Monaco carries
    /// on its own are absent because they need nothing, and C# because its server
    /// is a download worth asking about. The rest install themselves.
    #[test]
    fn the_languages_that_must_work_out_of_the_box_are_covered() {
        let covered: Vec<&str> = UNATTENDED_SERVERS.iter().map(|(language, _)| *language).collect();
        for language in ["typescript", "python", "go", "rust", "sql"] {
            assert!(
                covered.contains(&language),
                "{language} is not set up on first launch"
            );
        }
        // C# is covered by an explicit offer instead: its server is Roslyn, and a
        // 65 MB download is not something to do behind someone's back.
        assert!(
            !covered.contains(&"csharp"),
            "Roslyn belongs to a one-click offer with a size in the sentence, not to first launch"
        );
        for monaco_own in ["html", "css", "javascript"] {
            assert!(
                !covered.contains(&monaco_own),
                "{monaco_own} needs no server: Monaco brings its own language service"
            );
        }
    }
}
