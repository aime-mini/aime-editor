//! What Aime found on this machine, reported before a folder is even open.
//!
//! The welcome screen is where a new user decides whether the app works for
//! them; discovering a missing CLI three clicks later is worse than being told
//! up front. Nothing here installs anything — Aime reports and gives the exact
//! command, the same contract the AI panel already follows.

use crate::providers::{adapter::adapter_for, cli_command, provider_health};
use serde::Serialize;

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
    for language in ["typescript", "python", "go", "rust"] {
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
    report
}

/// Signs in to a provider by handing its own login command to the caller —
/// the welcome screen runs it in a terminal, exactly like the AI panel.
#[tauri::command]
pub fn login_command_for(provider_id: String) -> Result<String, String> {
    Ok(adapter_for(&provider_id)?.login_command().to_string())
}
