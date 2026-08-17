use super::{claude, codex, generic};
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
    /// Workspace root: some adapters must read the project's own memory.
    pub cwd: &'a str,
    /// Provider-side conversation id; `Some` means "continue that conversation".
    pub session_id: Option<&'a str>,
    /// UI overrides — `None` or empty leaves the CLI's own default in place.
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub permission: Permission,
}

/// One call to a CLI: its arguments, and the prompt when that travels on stdin.
///
/// The distinction is not cosmetic. On Windows every CLI is launched through
/// `cmd /C`, because npm installs them as batch shims, and cmd.exe ends a
/// command line at the first newline - so a multi-line prompt passed as an
/// argument silently arrives with every line but the first missing. Both
/// built-in CLIs read their prompt from stdin, which has no such limit and no
/// length ceiling either.
pub struct Invocation {
    pub args: Vec<String>,
    /// `Some` = write this to the child's stdin, then close it.
    pub stdin: Option<String>,
}

impl Invocation {
    /// The prompt travels on stdin - correct for any CLI that accepts it.
    pub fn piped(args: Vec<String>, prompt: impl Into<String>) -> Self {
        Self {
            args,
            stdin: Some(prompt.into()),
        }
    }

    /// The prompt is already inside `args`, the way that CLI requires.
    pub fn plain(args: Vec<String>) -> Self {
        Self { args, stdin: None }
    }
}

/// One headless AI CLI. Adapters only build invocations and read the CLI's
/// output shape — spawning, streaming and cancellation are shared (mod.rs),
/// and normalizing events into the UI event set happens on the frontend
/// (ARCHITECTURE.md §4).
pub trait Adapter: Send + Sync {
    /// Executable name, resolved through PATH.
    fn command(&self) -> &'static str;

    /// One streaming chat turn.
    fn chat_invocation(&self, req: &TurnRequest<'_>) -> Invocation;

    /// One side-effect-free call (e.g. commit messages).
    fn oneshot_invocation(&self, prompt: &str, model: Option<&str>) -> Invocation;

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

    /// The environment variable this CLI reads an API key from, when Aime can
    /// authenticate it that way at all. `None` = Aime never injects a key for
    /// this CLI. Measured before shipping (2026-08-16): `claude -p` honours
    /// `ANTHROPIC_API_KEY` (and says so — the key takes precedence over the
    /// claude.ai login for that process), while `codex exec` ignores
    /// `OPENAI_API_KEY` when a ChatGPT login exists; Codex's supported route is
    /// its own `codex login --with-api-key`, which stays the CLI's business.
    fn api_key_env(&self) -> Option<&str> {
        None
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
        other => generic::find(other)
            .map(|adapter| adapter as &'static dyn Adapter)
            .ok_or_else(|| format!("Unsupported provider: {other}")),
    }
}

/// Drops overrides the UI leaves on "Auto" so the CLI's own default applies.
pub fn explicit(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}
