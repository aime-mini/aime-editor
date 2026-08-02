use serde_json::Value;
use std::path::{Path, PathBuf};

use super::adapter::{explicit, Adapter, Permission, TurnRequest, PROGRESS_MEMORY_PROMPT};
use crate::mcp::{tokenize_command, McpServer, McpServerSpec};

/// Adapter for the OpenAI Codex CLI, verified against codex-cli 0.146.0:
/// `codex exec --json` streams `ThreadEvent` JSONL, `codex exec resume <id>`
/// continues a thread, and `codex login status` reports the sign-in state.
pub struct CodexAdapter;

pub const COMMAND: &str = "codex";

/// `-c` values are parsed as TOML and fall back to the raw literal when that
/// fails — so plain, unquoted values keep the arguments free of quote
/// characters, which would otherwise have to survive Windows' `cmd /C`.
const SANDBOX_WORKSPACE: &str = "sandbox_mode=workspace-write";
const SANDBOX_READ_ONLY: &str = "sandbox_mode=read-only";
const APPROVAL_NEVER: &str = "approval_policy=never";

/// Codex has no `--append-system-prompt`, and overriding its base instructions
/// file would replace them wholesale — so the journal rule rides along with the
/// prompt itself (the "prompt-inject" memory strategy of ARCHITECTURE.md §4).
fn prompt_with_progress_rule(prompt: &str) -> String {
    format!("{PROGRESS_MEMORY_PROMPT}\n\n---\n\n{prompt}")
}

/// The answer of a one-shot run: the text of the last completed agent message.
fn last_agent_message(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("item.completed"))
        .filter_map(|event| {
            let item = event.get("item")?;
            (item.get("type").and_then(Value::as_str) == Some("agent_message"))
                .then(|| item.get("text").and_then(Value::as_str).map(str::to_string))?
        })
        .next_back()
}

/// One entry of `codex mcp list --json` (schema verified against 0.146.0):
/// `{ name, enabled, disabled_reason, transport: { type, command, args, url },
/// auth_status }`. Fields are read defensively so a schema addition cannot
/// empty the server list.
fn describe_server(entry: &Value) -> Option<McpServer> {
    let name = entry.get("name")?.as_str()?.to_string();
    let transport = entry.get("transport");
    let target = transport
        .and_then(|t| t.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            let transport = transport?;
            let command = transport.get("command")?.as_str()?;
            let args: Vec<&str> = transport
                .get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            Some(std::iter::once(command).chain(args).collect::<Vec<_>>().join(" "))
        })
        .unwrap_or_default();

    let disabled = entry.get("enabled").and_then(Value::as_bool) == Some(false);
    let status = if disabled {
        entry
            .get("disabled_reason")
            .and_then(Value::as_str)
            .unwrap_or("disabled")
            .to_string()
    } else {
        // "unsupported" only means the server needs no sign-in — not a status.
        match entry.get("auth_status").and_then(Value::as_str) {
            Some("unsupported") | None => String::new(),
            Some(auth) => auth.to_string(),
        }
    };
    Some(McpServer { name, target, status })
}

fn parse_mcp_list(stdout: &str) -> Vec<McpServer> {
    serde_json::from_str::<Vec<Value>>(stdout)
        .unwrap_or_default()
        .iter()
        .filter_map(describe_server)
        .collect()
}

impl Adapter for CodexAdapter {
    fn command(&self) -> &'static str {
        COMMAND
    }

    fn chat_args(&self, req: &TurnRequest<'_>) -> Vec<String> {
        let mut args: Vec<String> = vec!["exec".into()];
        if req.session_id.is_some() {
            args.push("resume".into());
        }
        // Aime opens plain folders too, so the git-repo requirement must go.
        args.push("--json".into());
        args.push("--skip-git-repo-check".into());

        match req.permission {
            Permission::Full => args.push("--dangerously-bypass-approvals-and-sandbox".into()),
            // `exec resume` accepts no --sandbox/--ask-for-approval flags, so the
            // guarded levels are expressed as config overrides, which both accept.
            Permission::Edits | Permission::ReadOnly => {
                let sandbox = if req.permission == Permission::Edits {
                    SANDBOX_WORKSPACE
                } else {
                    SANDBOX_READ_ONLY
                };
                args.push("-c".into());
                args.push(sandbox.into());
                args.push("-c".into());
                args.push(APPROVAL_NEVER.into());
            }
        }
        if let Some(model) = explicit(req.model) {
            args.push("-m".into());
            args.push(model.into());
        }
        if let Some(effort) = explicit(req.effort) {
            args.push("-c".into());
            args.push(format!("model_reasoning_effort={effort}"));
        }

        // Everything after `--` is positional, so prompts may start with a dash.
        args.push("--".into());
        if let Some(id) = req.session_id {
            args.push(id.into());
        }
        args.push(prompt_with_progress_rule(req.prompt));
        args
    }

    fn oneshot_args(&self, prompt: &str, model: Option<&str>) -> Vec<String> {
        // Codex cannot run tool-less; a read-only sandbox with no approvals is
        // the equivalent guarantee that a one-shot call changes nothing.
        let mut args: Vec<String> = vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "-c".into(),
            SANDBOX_READ_ONLY.into(),
            "-c".into(),
            APPROVAL_NEVER.into(),
        ];
        if let Some(model) = explicit(model) {
            args.push("-m".into());
            args.push(model.into());
        }
        args.push("--".into());
        args.push(prompt.into());
        args
    }

    fn parse_oneshot(&self, stdout: &str) -> Result<String, String> {
        last_agent_message(stdout)
            .map(|text| text.trim().to_string())
            .ok_or_else(|| "CLI returned no result".into())
    }

    fn auth_probe_args(&self) -> Option<&'static [&'static str]> {
        Some(&["login", "status"])
    }

    fn login_command(&self) -> &'static str {
        "codex login"
    }

    fn global_memory_path(&self, home: &Path) -> PathBuf {
        home.join(".codex").join("AGENTS.md")
    }

    fn mcp_list_args(&self) -> Vec<String> {
        vec!["mcp".into(), "list".into(), "--json".into()]
    }

    fn parse_mcp_list(&self, stdout: &str) -> Vec<McpServer> {
        parse_mcp_list(stdout)
    }

    fn mcp_add_args(&self, spec: &McpServerSpec) -> Vec<String> {
        let mut args: Vec<String> = vec!["mcp".into(), "add".into(), spec.name.clone()];
        if spec.is_http() {
            args.push("--url".into());
            args.push(spec.target.trim().into());
            return args;
        }
        for variable in &spec.env {
            args.push("--env".into());
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
    use super::super::adapter::{Adapter, TurnRequest};
    use super::{CodexAdapter, McpServerSpec, Permission};

    fn turn(session_id: Option<&'static str>, permission: Permission) -> TurnRequest<'static> {
        TurnRequest {
            prompt: "hello",
            cwd: "",
            session_id,
            model: None,
            effort: None,
            permission,
        }
    }

    fn index_of(args: &[String], needle: &str) -> Option<usize> {
        args.iter().position(|a| a == needle)
    }

    #[test]
    fn fresh_turn_uses_exec_and_carries_the_progress_rule() {
        let args = CodexAdapter.chat_args(&turn(None, Permission::Full));
        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(!args.contains(&"resume".to_string()));
        assert!(args.last().expect("prompt").contains(".aime/PROGRESS.md"));
        assert!(args.last().expect("prompt").ends_with("hello"));
    }

    #[test]
    fn resumed_turn_passes_the_thread_id_before_the_prompt() {
        let args = CodexAdapter.chat_args(&turn(Some("thread-1"), Permission::Full));
        assert_eq!(args.get(1).map(String::as_str), Some("resume"));
        let end_of_options = index_of(&args, "--").expect("-- separator");
        assert_eq!(args.get(end_of_options + 1).map(String::as_str), Some("thread-1"));
        assert!(args.get(end_of_options + 2).expect("prompt").ends_with("hello"));
    }

    #[test]
    fn each_permission_level_maps_to_its_own_sandbox() {
        let full = CodexAdapter.chat_args(&turn(None, Permission::Full));
        assert!(full.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(!full.iter().any(|a| a.starts_with("sandbox_mode")));

        let edits = CodexAdapter.chat_args(&turn(None, Permission::Edits));
        assert!(!edits.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(edits.contains(&"sandbox_mode=workspace-write".to_string()));
        assert!(edits.contains(&"approval_policy=never".to_string()));

        let read_only = CodexAdapter.chat_args(&turn(None, Permission::ReadOnly));
        assert!(read_only.contains(&"sandbox_mode=read-only".to_string()));
        assert!(read_only.contains(&"approval_policy=never".to_string()));
    }

    #[test]
    fn model_and_effort_are_forwarded_when_set() {
        let args = CodexAdapter.chat_args(&TurnRequest {
            model: Some("gpt-5.6-sol"),
            effort: Some("high"),
            ..turn(None, Permission::Full)
        });
        let model_at = index_of(&args, "-m").expect("-m present");
        assert_eq!(args.get(model_at + 1).map(String::as_str), Some("gpt-5.6-sol"));
        assert!(args.contains(&"model_reasoning_effort=high".to_string()));
    }

    #[test]
    fn empty_overrides_fall_back_to_cli_defaults() {
        let args = CodexAdapter.chat_args(&TurnRequest {
            model: Some(""),
            effort: Some(""),
            ..turn(None, Permission::Full)
        });
        assert!(!args.contains(&"-m".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("model_reasoning_effort")));
    }

    #[test]
    fn oneshot_runs_read_only_and_never_asks() {
        let args = CodexAdapter.oneshot_args("write a commit message", None);
        assert!(args.contains(&"sandbox_mode=read-only".to_string()));
        assert!(args.contains(&"approval_policy=never".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("write a commit message"));
    }

    #[test]
    fn oneshot_reads_the_last_agent_message() {
        let stdout = concat!(
            r#"{"type":"thread.started","thread_id":"t1"}"#,
            "\n",
            r#"{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"thinking"}}"#,
            "\n",
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"first"}}"#,
            "\n",
            r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"  final  "}}"#,
            "\n",
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}"#,
        );
        assert_eq!(CodexAdapter.parse_oneshot(stdout).expect("parsed"), "final");
    }

    #[test]
    fn mcp_list_json_becomes_name_target_status() {
        // Shape captured from a real `codex mcp list --json` run (0.146.0).
        let stdout = r#"[
            {"name":"fs","enabled":true,"disabled_reason":null,
             "transport":{"type":"stdio","command":"npx","args":["-y","server-filesystem","."],"env":{}},
             "auth_status":"unsupported"},
            {"name":"sentry","enabled":true,"disabled_reason":null,
             "transport":{"type":"streamable_http","url":"https://mcp.sentry.dev/mcp"},
             "auth_status":"logged_out"},
            {"name":"old","enabled":false,"disabled_reason":"startup failed",
             "transport":{"type":"stdio","command":"node","args":[]},"auth_status":"unsupported"}
        ]"#;
        let servers = CodexAdapter.parse_mcp_list(stdout);
        assert_eq!(servers.len(), 3);
        assert_eq!(servers[0].target, "npx -y server-filesystem .");
        assert_eq!(servers[0].status, "", "no sign-in support is not a status");
        assert_eq!(servers[1].target, "https://mcp.sentry.dev/mcp");
        assert_eq!(servers[1].status, "logged_out");
        assert_eq!(servers[2].status, "startup failed");
    }

    #[test]
    fn unreadable_mcp_output_lists_nothing_instead_of_failing() {
        assert!(CodexAdapter.parse_mcp_list("not json").is_empty());
    }

    #[test]
    fn http_and_stdio_servers_use_the_flags_the_cli_documents() {
        let http = CodexAdapter.mcp_add_args(&McpServerSpec {
            name: "sentry".into(),
            target: "https://mcp.sentry.dev/mcp".into(),
            env: Vec::new(),
        });
        assert_eq!(
            http,
            vec!["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]
        );

        let stdio = CodexAdapter.mcp_add_args(&McpServerSpec {
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
                "--env",
                "TOKEN=abc",
                "--",
                "npx",
                "-y",
                "server-github"
            ]
        );
    }

    #[test]
    fn oneshot_without_an_agent_message_is_an_error() {
        let stdout = r#"{"type":"turn.failed","error":{"message":"not logged in"}}"#;
        assert!(CodexAdapter.parse_oneshot(stdout).is_err());
    }
}
