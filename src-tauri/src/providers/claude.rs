use serde_json::Value;
use std::path::{Path, PathBuf};

use super::adapter::{
    explicit, Adapter, ApiKeyRoute, Invocation, Permission, ToolSet, TurnRequest, PROGRESS_MEMORY_PROMPT,
};
use crate::mcp::{tokenize_command, McpServer, McpServerSpec};

/// Adapter for the Claude Code CLI (headless mode), verified against 2.1.220.
pub struct ClaudeAdapter;

pub const COMMAND: &str = "claude";

/// The variable the CLI reads a key from, and the exact string it echoes back
/// in `claude auth status` when it has picked one up.
const API_KEY_VARIABLE: &str = "ANTHROPIC_API_KEY";

/// One-shot calls (commit messages, ghost text, conflict merges) ask for one
/// answer and can touch nothing, so the agent persona is dead weight in every
/// request.
const ONESHOT_SYSTEM_PROMPT: &str = "You are a precise assistant inside a code editor. \
Answer exactly what is asked, with no preamble, no explanation and no markdown fences.";

/// The tools a files-only turn keeps: reading, searching and editing the
/// project. Measured 2026-09-06 with `-p --permission-mode plan --tools
/// Read,Glob,Grep`: the CLI answered that Bash "was not available" - the tool is
/// gone, not merely refused - where plan mode alone had run the command.
const FILE_TOOLS: &str = "Read,Glob,Grep,Edit,Write";

/// A read-only files turn has no writing tool at all. Plan mode alone lets
/// `Write` put the CLI's own plan file under `~/.claude/plans` (seen in the
/// first real deploy survey, 2026-09-06); without the tool there is nothing
/// to write it with.
const READ_TOOLS: &str = "Read,Glob,Grep";

/// `-p` combined with `--output-format stream-json` requires `--verbose`.
/// The permission level maps onto `--permission-mode` (choices verified
/// against 2.1.220): full bypass (headless-verified with
/// `permission_denials: []`), auto-accepted edits, or plan mode, which
/// researches and answers without touching the working tree - but still runs
/// commands, which is what `tools` is for.
pub fn build_args(
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    permission: Permission,
    tools: ToolSet,
) -> Vec<String> {
    let permission_mode = match permission {
        Permission::Full => "bypassPermissions",
        Permission::Edits => "acceptEdits",
        Permission::ReadOnly => "plan",
    };
    // `-p` with no prompt argument makes the CLI read it from stdin.
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--permission-mode".into(),
        permission_mode.into(),
        "--append-system-prompt".into(),
        PROGRESS_MEMORY_PROMPT.into(),
    ];
    if tools == ToolSet::FilesOnly {
        args.push("--tools".into());
        args.push(
            if permission == Permission::ReadOnly {
                READ_TOOLS
            } else {
                FILE_TOOLS
            }
            .into(),
        );
    }
    if let Some(model) = explicit(model) {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(effort) = explicit(effort) {
        args.push("--effort".into());
        args.push(effort.into());
    }
    if let Some(id) = session_id {
        args.push("--resume".into());
        args.push(id.into());
    }
    args
}

/// `claude mcp list` prints `<name>: <target> - <status>` per server, after a
/// health-check header. Anything that does not carry a `name:` is a header or
/// a hint, and is skipped rather than guessed at.
fn parse_mcp_list(stdout: &str) -> Vec<McpServer> {
    stdout
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.trim().split_once(": ")?;
            if name.is_empty() || rest.is_empty() {
                return None;
            }
            // The status is the last " - " group; a command may contain others.
            let (target, status) = rest.rsplit_once(" - ").unwrap_or((rest, ""));
            Some(McpServer {
                name: name.to_string(),
                target: target.trim().to_string(),
                status: status.trim().to_string(),
            })
        })
        .collect()
}

impl Adapter for ClaudeAdapter {
    fn command(&self) -> &str {
        COMMAND
    }

    fn chat_invocation(&self, req: &TurnRequest<'_>) -> Invocation {
        Invocation::piped(
            build_args(req.session_id, req.model, req.effort, req.permission, req.tools),
            req.prompt,
        )
    }

    fn restricts_tools(&self) -> bool {
        true
    }

    fn oneshot_invocation(&self, prompt: &str, model: Option<&str>) -> Invocation {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "json".into(),
            "--tools".into(),
            String::new(), // no tools: fast, cheap, and side-effect free
            // Replacing the agent persona a one-shot never uses measured 40%
            // cheaper per call ($0.0085 -> $0.0045 on haiku, same answer).
            "--system-prompt".into(),
            ONESHOT_SYSTEM_PROMPT.into(),
        ];
        if let Some(model) = explicit(model) {
            args.push("--model".into());
            args.push(model.into());
        }
        Invocation::piped(args, prompt)
    }

    fn parse_oneshot(&self, stdout: &str) -> Result<String, String> {
        let parsed: Value =
            serde_json::from_str(stdout).map_err(|e| format!("Unexpected CLI output: {e}"))?;
        parsed
            .get("result")
            .and_then(Value::as_str)
            .map(|text| text.trim().to_string())
            .ok_or_else(|| "CLI returned no result".into())
    }

    fn auth_probe_args(&self) -> Option<&'static [&'static str]> {
        Some(&["auth", "status"])
    }

    /// `claude auth status` exits 0 even when signed out — the JSON decides.
    fn is_signed_in(&self, exit_ok: bool, stdout: &str) -> bool {
        exit_ok
            && serde_json::from_str::<Value>(stdout)
                .ok()
                .and_then(|status| status.get("loggedIn").and_then(Value::as_bool))
                .unwrap_or(false)
    }

    /// Documented in the CLI's own help, and verified against the real binary:
    /// with this variable set, `claude -p` answers from the key — printing
    /// "ANTHROPIC_API_KEY … takes precedence over your claude.ai login".
    fn api_key_route(&self) -> Option<ApiKeyRoute> {
        Some(ApiKeyRoute::Env {
            variable: API_KEY_VARIABLE.into(),
        })
    }

    /// The CLI names the key's source in its status, which is how Aime can show
    /// that the variable it injects really did arrive (measured 2026-08-17:
    /// `apiKeySource: "ANTHROPIC_API_KEY"` appears only when it is set).
    /// It is not a validity check — no field of this status reports that.
    fn probe_sees_api_key(&self, stdout: &str) -> Option<bool> {
        let status: Value = serde_json::from_str(stdout).ok()?;
        Some(status.get("apiKeySource").and_then(Value::as_str) == Some(API_KEY_VARIABLE))
    }

    fn login_command(&self) -> String {
        "claude auth login".into()
    }

    fn global_memory_path(&self, home: &Path) -> PathBuf {
        home.join(".claude").join("CLAUDE.md")
    }

    fn mcp_list_args(&self) -> Vec<String> {
        vec!["mcp".into(), "list".into()]
    }

    fn parse_mcp_list(&self, stdout: &str) -> Vec<McpServer> {
        parse_mcp_list(stdout)
    }

    fn mcp_add_args(&self, spec: &McpServerSpec) -> Vec<String> {
        let mut args: Vec<String> = vec!["mcp".into(), "add".into()];
        if spec.is_http() {
            args.push("--transport".into());
            args.push("http".into());
            args.push(spec.name.clone());
            args.push(spec.target.trim().into());
            return args;
        }
        args.push(spec.name.clone());
        for variable in &spec.env {
            args.push("-e".into());
            args.push(variable.clone());
        }
        args.push("--".into());
        args.extend(tokenize_command(&spec.target));
        args
    }

    fn mcp_remove_args(&self, name: &str) -> Vec<String> {
        vec!["mcp".into(), "remove".into(), name.into()]
    }

    fn mcp_login_command(&self, name: &str) -> String {
        format!("{COMMAND} mcp login {name}")
    }
}

#[cfg(test)]
mod tests {
    use super::{build_args, Adapter, ApiKeyRoute, ClaudeAdapter, McpServerSpec, Permission, ToolSet};

    #[test]
    fn fresh_session_has_progress_memory_but_no_resume() {
        let args = build_args(None, None, None, Permission::Full, ToolSet::Everything);
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn each_permission_level_maps_to_its_own_cli_mode() {
        let mode_of = |permission| {
            let args = build_args(None, None, None, permission, ToolSet::Everything);
            let at = args
                .iter()
                .position(|a| a == "--permission-mode")
                .expect("--permission-mode present");
            args[at + 1].clone()
        };
        assert_eq!(mode_of(Permission::Full), "bypassPermissions");
        assert_eq!(mode_of(Permission::Edits), "acceptEdits");
        assert_eq!(mode_of(Permission::ReadOnly), "plan");
    }

    #[test]
    fn a_files_only_turn_names_its_tools_and_a_full_one_does_not() {
        let cut = build_args(None, None, None, Permission::Edits, ToolSet::FilesOnly);
        let at = cut.iter().position(|a| a == "--tools").expect("--tools present");
        assert_eq!(cut[at + 1], "Read,Glob,Grep,Edit,Write");
        assert!(
            !cut[at + 1].contains("Bash"),
            "the shell is the tool being removed"
        );

        let whole = build_args(None, None, None, Permission::Edits, ToolSet::Everything);
        assert!(!whole.contains(&"--tools".to_string()));

        let reading = build_args(None, None, None, Permission::ReadOnly, ToolSet::FilesOnly);
        let at = reading
            .iter()
            .position(|a| a == "--tools")
            .expect("--tools present");
        assert_eq!(
            reading[at + 1],
            "Read,Glob,Grep",
            "nothing that writes, not even a plan file"
        );
    }

    #[test]
    fn resumed_session_appends_resume_id_last() {
        let args = build_args(Some("abc-123"), None, None, Permission::Full, ToolSet::Everything);
        let resume_at = args
            .iter()
            .position(|a| a == "--resume")
            .expect("--resume present");
        assert_eq!(args.get(resume_at + 1).map(String::as_str), Some("abc-123"));
    }

    #[test]
    fn oneshot_sends_the_prompt_on_stdin_with_no_tools() {
        let call = ClaudeAdapter.oneshot_invocation("write a commit message", None);
        assert_eq!(call.stdin.as_deref(), Some("write a commit message"));
        assert!(!call.args.iter().any(|arg| arg.contains("commit message")));
        assert!(call.args.contains(&"--tools".to_string()));
        assert!(call.args.contains(&"--system-prompt".to_string()));
    }

    #[test]
    fn model_and_effort_are_forwarded_when_set() {
        let args = build_args(
            None,
            Some("opus"),
            Some("high"),
            Permission::Full,
            ToolSet::Everything,
        );
        let model_at = args.iter().position(|a| a == "--model").expect("--model present");
        assert_eq!(args.get(model_at + 1).map(String::as_str), Some("opus"));
        let effort_at = args
            .iter()
            .position(|a| a == "--effort")
            .expect("--effort present");
        assert_eq!(args.get(effort_at + 1).map(String::as_str), Some("high"));
    }

    #[test]
    fn empty_overrides_fall_back_to_cli_defaults() {
        let args = build_args(None, Some(""), Some(""), Permission::Full, ToolSet::Everything);
        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn oneshot_result_is_read_from_the_result_field() {
        let text = ClaudeAdapter
            .parse_oneshot(r#"{"type":"result","result":"  fix: guard null path  "}"#)
            .expect("parsed");
        assert_eq!(text, "fix: guard null path");
    }

    #[test]
    fn oneshot_without_a_result_field_is_an_error() {
        assert!(ClaudeAdapter.parse_oneshot(r#"{"type":"result"}"#).is_err());
    }

    #[test]
    fn mcp_list_reads_name_target_and_status_and_skips_the_header() {
        let stdout = "Checking MCP server health…\n\n\
            claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication\n\
            local-fs: npx -y server-filesystem . - ✓ Connected\n";
        let servers = ClaudeAdapter.parse_mcp_list(stdout);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "claude.ai Notion");
        assert_eq!(servers[0].target, "https://mcp.notion.com/mcp");
        assert_eq!(servers[0].status, "! Needs authentication");
        assert_eq!(servers[1].target, "npx -y server-filesystem .");
    }

    #[test]
    fn an_mcp_server_without_a_status_still_lists() {
        let servers = ClaudeAdapter.parse_mcp_list("solo: https://example.com/mcp\n");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].status, "");
    }

    #[test]
    fn http_and_stdio_servers_use_the_flags_the_cli_documents() {
        let http = ClaudeAdapter.mcp_add_args(&McpServerSpec {
            name: "sentry".into(),
            target: "https://mcp.sentry.dev/mcp".into(),
            env: Vec::new(),
        });
        assert_eq!(
            http,
            vec![
                "mcp",
                "add",
                "--transport",
                "http",
                "sentry",
                "https://mcp.sentry.dev/mcp"
            ]
        );

        let stdio = ClaudeAdapter.mcp_add_args(&McpServerSpec {
            name: "gh".into(),
            target: "npx -y server-github".into(),
            env: vec!["TOKEN=abc".into()],
        });
        assert_eq!(
            stdio,
            vec![
                "mcp",
                "add",
                "gh",
                "-e",
                "TOKEN=abc",
                "--",
                "npx",
                "-y",
                "server-github"
            ]
        );
    }

    #[test]
    fn sign_in_state_comes_from_the_status_json_not_the_exit_code() {
        assert!(ClaudeAdapter.is_signed_in(true, r#"{"loggedIn":true}"#));
        assert!(!ClaudeAdapter.is_signed_in(true, r#"{"loggedIn":false}"#));
        assert!(!ClaudeAdapter.is_signed_in(false, r#"{"loggedIn":true}"#));
        assert!(!ClaudeAdapter.is_signed_in(true, "unexpected output"));
    }

    #[test]
    fn the_api_key_rides_the_variable_the_cli_documents() {
        // Verified against the real binary (2026-08-16): with this set,
        // `claude -p` answers from the key and says it overrides the login.
        assert_eq!(
            ClaudeAdapter.api_key_route(),
            Some(ApiKeyRoute::Env {
                variable: "ANTHROPIC_API_KEY".into()
            })
        );
    }

    #[test]
    fn the_status_says_whether_the_injected_key_arrived() {
        // Both shapes captured from the real CLI (2026-08-17).
        let with_key = r#"{"loggedIn":true,"authMethod":"claude.ai","apiKeySource":"ANTHROPIC_API_KEY"}"#;
        let without = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}"#;
        assert_eq!(ClaudeAdapter.probe_sees_api_key(with_key), Some(true));
        assert_eq!(ClaudeAdapter.probe_sees_api_key(without), Some(false));
        // Not JSON at all: the CLI told us nothing, so Aime claims nothing.
        assert_eq!(ClaudeAdapter.probe_sees_api_key("command not found"), None);
    }
}
