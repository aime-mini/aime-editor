use super::{claude, codex, generic};
use crate::mcp::{McpServer, McpServerSpec};
use serde::Serialize;
use std::sync::Arc;

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
    /// No file changes. Commands may still run - see `ToolSet` for the level
    /// that removes them.
    ReadOnly,
}

/// Which of the CLI's tools a turn has at all.
///
/// Orthogonal to `Permission`, which says how freely the tools act: measured
/// 2026-09-06, Claude Code's plan mode (`ReadOnly`) still ran a command through
/// its Bash tool, so "read-only" is a statement about files, and a turn that
/// must not reach a cloud, a network or a shell needs the tools themselves cut
/// down. Only the files-only shape exists because only one caller - the deploy,
/// whose commands Aime runs itself - needs a guarantee the prompt cannot give.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum ToolSet {
    /// Everything the CLI has.
    #[default]
    Everything,
    /// Reading, searching and editing files in the project - no shell, no
    /// network. `Permission` still decides whether the edits happen.
    FilesOnly,
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
    pub tools: ToolSet,
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

/// How a CLI can be authenticated with an API key. Both doors were measured
/// against the real binaries (2026-08-17) rather than assumed, because they
/// behave nothing alike.
#[derive(Clone, Serialize, PartialEq, Eq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiKeyRoute {
    /// The CLI reads the key from this variable on every run. Aime stores the
    /// key and injects it into its own spawns only; the CLI's stored login is
    /// left untouched. `claude -p` works this way, and says so: with the
    /// variable set, `claude auth status` reports `apiKeySource`.
    Env { variable: String },
    /// The CLI stores keys itself, so Aime hands the key over once, on the
    /// CLI's own stdin, and keeps no copy — `codex login --with-api-key`.
    ///
    /// This door **replaces** whatever that CLI was signed in with (measured:
    /// a ChatGPT login became "Logged in using an API key"), so the UI must
    /// warn before using it. The CLI does not validate the key here — the same
    /// measurement stored a plainly invalid one and exited 0.
    CliLogin { args: Vec<String> },
}

/// One headless AI CLI. Adapters only build invocations and read the CLI's
/// output shape — spawning, streaming and cancellation are shared (mod.rs),
/// and normalizing events into the UI event set happens on the frontend
/// (ARCHITECTURE.md §4).
pub trait Adapter: Send + Sync {
    /// Executable name, resolved through PATH.
    fn command(&self) -> &str;

    /// One streaming chat turn.
    fn chat_invocation(&self, req: &TurnRequest<'_>) -> Invocation;

    /// Whether `ToolSet::FilesOnly` is a real constraint at this CLI.
    ///
    /// False by default: a CLI Aime knows only from a configuration file has no
    /// flag to map it onto, and a turn that needs the guarantee must be refused
    /// rather than launched with a sentence in the prompt standing in for it.
    fn restricts_tools(&self) -> bool {
        false
    }

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

    /// How this CLI takes an API key, if it takes one at all. `None` = Aime
    /// offers no key field for it, because there is no door it could open.
    fn api_key_route(&self) -> Option<ApiKeyRoute> {
        None
    }

    /// Whether the auth probe's output shows the CLI is using an API key.
    ///
    /// This is the only honest verification Aime can offer: running a real turn
    /// to test a key is unusable (measured — `claude -p` with an invalid key
    /// retries for minutes before saying anything), and no CLI validates a key
    /// at the moment it is handed one. `None` = this CLI says nothing about its
    /// key, so the UI must claim nothing either.
    fn probe_sees_api_key(&self, _stdout: &str) -> Option<bool> {
        None
    }

    /// Command that signs the user in. Every provider must be reachable this
    /// way — Aime runs it in an integrated terminal so the CLI keeps sole
    /// ownership of the credentials (user rule, session 3).
    fn login_command(&self) -> String;

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
/// lost (limits, restarts, new sessions) - memories kept as files cannot, and
/// Aime hands each turn their index to choose from (`lib/knowledge.ts`). One
/// memory per fact, shared by every provider.
pub const MEMORY_PROMPT: &str = "This project keeps its memory in .aime/memory/, one fact per file. \
Aime attaches the index of every memory to each turn in an <aime_memory> block; open the ones that \
bear on the request before you act. Write a memory, without being asked, when the user states a \
decision or a preference, and when the user corrects you - a correction is a decision (kind: \
decision); when you learn how this codebase does something (convention), when you hit a trap or fix \
a bug whose cause was not obvious (pitfall), and when you stop with work unfinished (work). Each \
file is .aime/memory/<name>.md and starts with this header, one field per line: ---, name: \
<kebab-case>, kind: <decision|convention|pitfall|work>, scope: <the folder it applies to, / for the \
whole project>, summary: <the fact itself in one sentence - it is the line every later turn reads in \
the index>, files: <comma-separated paths it can be checked against>, updated: <YYYY-MM-DD>, --- and \
then a few lines of detail: why, and how to apply it. \
Write only what the user said or what you saw in the code yourself - never a guess, an assumption \
or something a tool did not show you - and cite the files that prove it. A memory is a claim, not \
a fact: where it matters, confirm it in the code before relying on it, and when the code says \
otherwise, fix or delete the memory instead of following it. \
One fact per file, named after it. Change the existing memory rather than writing a second one \
about the same thing, and merge two that say the same; delete a work memory when the work is done \
and any memory that proved wrong. To delete a memory, overwrite its file with nothing - Aime removes \
it; when a fact changes so much that its name no longer fits, write it under a new name and empty \
the old file. A memory marked STALE: check it against the code, then update or delete it. Memory \
is yours to keep: never ask the user to touch these files, and do not report keeping them in your \
answer. Never write a secret into a \
memory. If .aime/PROGRESS.md or .aime/PROJECT.md exist from before, move what still matters into \
memories and delete them.";

/// Resolves a provider id to its adapter.
///
/// Shared ownership rather than a borrow: a configured provider can be replaced
/// while Aime runs (the user edits `providers.json`), and a turn already in
/// flight must keep talking to the adapter it started with.
pub fn adapter_for(provider_id: &str) -> Result<Arc<dyn Adapter>, String> {
    match provider_id {
        "claude" => Ok(Arc::new(claude::ClaudeAdapter)),
        "codex" => Ok(Arc::new(codex::CodexAdapter)),
        other => generic::find(other)
            .map(|adapter| adapter as Arc<dyn Adapter>)
            .ok_or_else(|| format!("Unsupported provider: {other}")),
    }
}

/// Drops overrides the UI leaves on "Auto" so the CLI's own default applies.
pub fn explicit(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}
