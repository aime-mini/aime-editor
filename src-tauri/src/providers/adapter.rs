use super::{claude, codex};
use crate::mcp::{McpServer, McpServerSpec};
use std::path::{Path, PathBuf};

/// How much the agent may do on its own. This is a setting rather than a
/// per-call dialog by decision (session 3): an Allow/Deny popup needs a Node
/// sidecar running the Claude Agent SDK, which only one CLI supports and which
/// contradicts the "genuinely light" principle (ARCHITECTURE.md §1.2). Each
/// adapter maps these three levels onto its own CLI's flags.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// Every tool runs unprompted — the fastest, least guarded mode.
    #[default]
    Full,
    /// File edits run unprompted; commands stay sandboxed to the workspace.
    Edits,
    /// Reads and explains only: no file changes, no writes anywhere.
    ReadOnly,
}

/// Everything an adapter needs to build the arguments of one chat turn.
pub struct TurnRequest<'a> {
    pub prompt: &'a str,
    /// Provider-side conversation id; `Some` means "continue that conversation".
    pub session_id: Option<&'a str>,
    /// UI overrides — `None` or empty leaves the CLI's own default in place.
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub permission: Permission,
}

/// One headless AI CLI. Adapters only build arguments and read the CLI's
/// output shape — spawning, streaming and cancellation are shared (mod.rs),
/// and normalizing events into the UI event set happens on the frontend
/// (ARCHITECTURE.md §4).
pub trait Adapter: Send + Sync {
    /// Executable name, resolved through PATH.
    fn command(&self) -> &'static str;

    /// Arguments of a streaming chat turn.
    fn chat_args(&self, req: &TurnRequest<'_>) -> Vec<String>;

    /// Arguments of a one-shot, side-effect-free call (e.g. commit messages).
    fn oneshot_args(&self, prompt: &str, model: Option<&str>) -> Vec<String>;

    /// Extracts the answer text from a completed one-shot run's stdout.
    fn parse_oneshot(&self, stdout: &str) -> Result<String, String>;

    /// A cheap "is the user signed in?" probe. `None` = this CLI offers none,
    /// so the UI must not claim anything about the sign-in state.
    fn auth_probe_args(&self) -> Option<&'static [&'static str]>;

    /// Reads the probe's outcome. Most CLIs answer with their exit code;
    /// adapters whose CLI reports a signed-out state on exit 0 override this.
    fn is_signed_in(&self, exit_ok: bool, _stdout: &str) -> bool {
        exit_ok
    }

    /// Command that signs the user in. Every provider must be reachable this
    /// way — Aime runs it in an integrated terminal so the CLI keeps sole
    /// ownership of the credentials (user rule, session 3).
    fn login_command(&self) -> &'static str;

    /// The CLI's own user-level memory file — the one it reads for every
    /// project of this user.
    fn global_memory_path(&self, home: &Path) -> PathBuf;

    // --- MCP: every CLI already manages its own servers, health checks and
    // OAuth, so Aime drives those commands instead of editing config files.
    fn mcp_list_args(&self) -> Vec<String>;
    fn parse_mcp_list(&self, stdout: &str) -> Vec<McpServer>;
    fn mcp_add_args(&self, spec: &McpServerSpec) -> Vec<String>;
    fn mcp_remove_args(&self, name: &str) -> Vec<String>;
    /// Interactive sign-in for one server; Aime runs it in a terminal.
    fn mcp_login_command(&self, name: &str) -> String;
}

/// Injected into every turn, by every adapter. Chat context can be compacted or
/// lost (limits, restarts, new sessions) — a progress file that the agent
/// re-reads each turn cannot. One journal per project, shared by all providers.
pub const PROGRESS_MEMORY_PROMPT: &str = "You maintain the file .aime/PROGRESS.md as this project's \
working memory. Before starting a task, read it if it exists. Whenever you complete meaningful \
work or make a decision, update it concisely: goal, done, in progress, next steps, open issues — \
newest first. It must always allow a fresh session with no chat history to resume the work. \
Keep it under 150 lines by compacting older entries.";

/// Resolves a provider id to its adapter.
pub fn adapter_for(provider_id: &str) -> Result<&'static dyn Adapter, String> {
    match provider_id {
        "claude" => Ok(&claude::ClaudeAdapter),
        "codex" => Ok(&codex::CodexAdapter),
        other => Err(format!("Unsupported provider: {other}")),
    }
}

/// Drops overrides the UI leaves on "Auto" so the CLI's own default applies.
pub fn explicit(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}
