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
async fn version_of(command: &str) -> Option<String> {
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
pub async fn environment_report() -> Vec<ToolStatus> {
    let mut report = Vec::new();

    for (id, label, install_hint) in PROVIDERS {
        // Reuse the AI panel's own probe, so the two can never disagree.
        let health = provider_health(id.to_string()).await.ok();
        report.push(ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            installed: health.as_ref().is_some_and(|h| h.installed),
            version: health.as_ref().and_then(|h| h.version.clone()),
            signed_in: health.as_ref().and_then(|h| h.signed_in),
            install_hint: install_hint.to_string(),
            // AI is optional by design (ARCHITECTURE.md §1.6).
            required: false,
        });
    }

    for (id, label, install_hint, required) in TOOLS {
        let version = version_of(id).await;
        report.push(ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            installed: version.is_some(),
            version,
            signed_in: None,
            install_hint: install_hint.to_string(),
            required,
        });
    }

    report
}

/// Language servers Aime knows about, for the same "what do I have?" view.
#[tauri::command]
pub async fn language_server_report() -> Vec<ToolStatus> {
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
        let Ok(Some(availability)) = crate::lsp::lsp_availability(language.to_string()).await else {
            continue;
        };
        report.push(ToolStatus {
            id: language.to_string(),
            label: availability.command.clone(),
            installed: availability.available,
            version: None,
            signed_in: None,
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
            install_hint: String::new(),
            required: false,
        });
    }

    report
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
