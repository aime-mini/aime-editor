use serde_json::Value;
use std::path::{Path, PathBuf};

use super::adapter::{explicit, Adapter, Invocation, Permission, TurnRequest, PROGRESS_MEMORY_PROMPT};
use crate::mcp::{tokenize_command, McpServer, McpServerSpec};

/// Adapter for the Claude Code CLI (headless mode), verified against 2.1.220.
pub struct ClaudeAdapter;

pub const COMMAND: &str = "claude";

/// `-p` combined with `--output-format stream-json` requires `--verbose`.
/// The permission level maps onto `--permission-mode` (choices verified
/// against 2.1.220): full bypass (headless-verified with
/// `permission_denials: []`), auto-accepted edits, or plan mode, which
/// researches and answers without touching the working tree.
pub fn build_args(
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    permission: Permission,
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
    fn command(&self) -> &'static str {
        COMMAND
    }

    fn chat_invocation(&self, req: &TurnRequest<'_>) -> Invocation {
        Invocation::piped(
            build_args(req.session_id, req.model, req.effort, req.permission),
            req.prompt,
        )
    }

    fn oneshot_invocation(&self, prompt: &str, model: Option<&str>) -> Invocation {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "json".into(),
            "--tools".into(),
            String::new(), // no tools: fast, cheap, and side-effect free
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

    fn login_command(&self) -> &'static str {
        "claude auth login"
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
    use super::{build_args, Adapter, ClaudeAdapter, McpServerSpec, Permission};

    #[test]
    fn fresh_session_has_progress_memory_but_no_resume() {
        let args = build_args(None, None, None, Permission::Full);
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn each_permission_level_maps_to_its_own_cli_mode() {
        let mode_of = |permission| {
            let args = build_args(None, None, None, permission);
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
    fn resumed_session_appends_resume_id_last() {
        let args = build_args(Some("abc-123"), None, None, Permission::Full);
        let resume_at = args
            .iter()
            .position(|a| a == "--resume")
            .expect("--resume present");
        assert_eq!(args.get(resume_at + 1).map(String::as_str), Some("abc-123"));
    }

    #[test]
    fn model_and_effort_are_forwarded_when_set() {
        let args = build_args(None, Some("opus"), Some("high"), Permission::Full);
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
        let args = build_args(None, Some(""), Some(""), Permission::Full);
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
}
