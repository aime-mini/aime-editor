use serde_json::Value;
use std::path::{Path, PathBuf};

use super::adapter::{
    explicit, Adapter, ApiKeyRoute, Invocation, Permission, ToolSet, TurnRequest, PROGRESS_MEMORY_PROMPT,
};
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
/// Codex cannot drop its shell, so a files-only turn keeps the sandbox and
/// closes the network: a command it runs then reaches nothing outside the
/// working tree - not a cloud, not a package registry.
const NETWORK_OFF: &str = "sandbox_workspace_write.network_access=false";

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
    fn command(&self) -> &str {
        COMMAND
    }

    fn chat_invocation(&self, req: &TurnRequest<'_>) -> Invocation {
        let mut args: Vec<String> = vec!["exec".into()];
        if req.session_id.is_some() {
            args.push("resume".into());
        }
        // Aime opens plain folders too, so the git-repo requirement must go.
        args.push("--json".into());
        args.push("--skip-git-repo-check".into());

        match (req.permission, req.tools) {
            (Permission::Full, ToolSet::Everything) => {
                args.push("--dangerously-bypass-approvals-and-sandbox".into());
            }
            // `exec resume` accepts no --sandbox/--ask-for-approval flags, so the
            // guarded levels are expressed as config overrides, which both accept.
            // A files-only turn is guarded whatever its permission says: the
            // sandbox is the only fence this CLI has.
            (permission, tools) => {
                let sandbox = if permission == Permission::ReadOnly {
                    SANDBOX_READ_ONLY
                } else {
                    SANDBOX_WORKSPACE
                };
                args.push("-c".into());
                args.push(sandbox.into());
                args.push("-c".into());
                args.push(APPROVAL_NEVER.into());
                if tools == ToolSet::FilesOnly {
                    args.push("-c".into());
                    args.push(NETWORK_OFF.into());
                }
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

        // `exec resume` takes the thread id positionally; the prompt itself is
        // read from stdin, which the CLI does when no prompt argument is given.
        if let Some(id) = req.session_id {
            args.push("--".into());
            args.push(id.into());
        }
        Invocation::piped(args, prompt_with_progress_rule(req.prompt))
    }

    fn restricts_tools(&self) -> bool {
        true
    }

    fn oneshot_invocation(&self, prompt: &str, model: Option<&str>) -> Invocation {
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
        Invocation::piped(args, prompt)
    }

    fn parse_oneshot(&self, stdout: &str) -> Result<String, String> {
        last_agent_message(stdout)
            .map(|text| text.trim().to_string())
            .ok_or_else(|| "CLI returned no result".into())
    }

    fn auth_probe_args(&self) -> Option<&'static [&'static str]> {
        Some(&["login", "status"])
    }

    /// Codex ignores `OPENAI_API_KEY` while it has a stored login (measured
    /// 2026-08-16: `codex exec` answered from the ChatGPT login with an invalid
    /// key in the environment), so the only key Aime can hand it is one the CLI
    /// stores itself. Aime keeps no copy of it.
    fn api_key_route(&self) -> Option<ApiKeyRoute> {
        Some(ApiKeyRoute::CliLogin {
            args: vec!["login".into(), "--with-api-key".into()],
        })
    }

    /// `codex login status` names the credential in use — "Logged in using an
    /// API key - sk-proj-***" versus "Logged in using ChatGPT" (both captured
    /// from the real CLI, 2026-08-17).
    fn probe_sees_api_key(&self, stdout: &str) -> Option<bool> {
        if !stdout.contains("Logged in") {
            return None; // signed out, or a message Aime does not know
        }
        Some(stdout.contains("API key"))
    }

    fn login_command(&self) -> String {
        "codex login".into()
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
    use super::super::adapter::{Adapter, ApiKeyRoute, TurnRequest};
    use super::{CodexAdapter, McpServerSpec, Permission, ToolSet};

    #[test]
    fn codex_takes_a_key_only_through_its_own_login() {
        // Measured (2026-08-16): `codex exec` with an invalid OPENAI_API_KEY in
        // the environment still answered from the ChatGPT login - the variable
        // is ignored, so injecting it would only pretend to authenticate.
        assert_eq!(
            CodexAdapter.api_key_route(),
            Some(ApiKeyRoute::CliLogin {
                args: vec!["login".into(), "--with-api-key".into()]
            })
        );
    }

    #[test]
    fn the_login_status_names_the_credential_in_use() {
        // Three real outputs (2026-08-17), including the one that follows
        // `codex login --with-api-key`.
        assert_eq!(
            CodexAdapter.probe_sees_api_key("Logged in using an API key - sk-proj-***ement"),
            Some(true)
        );
        assert_eq!(
            CodexAdapter.probe_sees_api_key("Logged in using ChatGPT"),
            Some(false)
        );
        assert_eq!(CodexAdapter.probe_sees_api_key("Not logged in"), None);
    }

    fn turn(session_id: Option<&'static str>, permission: Permission) -> TurnRequest<'static> {
        TurnRequest {
            prompt: "hello",
            cwd: "",
            session_id,
            model: None,
            effort: None,
            permission,
            tools: ToolSet::Everything,
        }
    }

    #[test]
    fn a_files_only_turn_keeps_the_sandbox_and_closes_the_network() {
        let args = CodexAdapter
            .chat_invocation(&TurnRequest {
                tools: ToolSet::FilesOnly,
                ..turn(None, Permission::Full)
            })
            .args;
        assert!(
            !args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()),
            "full permission does not lift the fence of a files-only turn"
        );
        assert!(args.contains(&"sandbox_mode=workspace-write".to_string()));
        assert!(args.contains(&"sandbox_workspace_write.network_access=false".to_string()));
    }

    fn index_of(args: &[String], needle: &str) -> Option<usize> {
        args.iter().position(|a| a == needle)
    }

    #[test]
    fn fresh_turn_uses_exec_and_carries_the_progress_rule() {
        let call = CodexAdapter.chat_invocation(&turn(None, Permission::Full));
        assert_eq!(call.args.first().map(String::as_str), Some("exec"));
        assert!(!call.args.contains(&"resume".to_string()));
        let prompt = call.stdin.expect("prompt on stdin");
        assert!(prompt.contains(".aime/PROGRESS.md"));
        assert!(prompt.ends_with("hello"));
    }

    /// The regression this guards: passed as an argument, a multi-line prompt
    /// loses every line but the first on Windows (see `Invocation`).
    #[test]
    fn the_prompt_never_travels_as_an_argument() {
        let call = CodexAdapter.chat_invocation(&turn(None, Permission::Full));
        assert!(!call.args.iter().any(|arg| arg.contains("hello")));
        assert!(call.stdin.is_some());
    }

    #[test]
    fn resumed_turn_passes_the_thread_id_positionally() {
        let call = CodexAdapter.chat_invocation(&turn(Some("thread-1"), Permission::Full));
        assert_eq!(call.args.get(1).map(String::as_str), Some("resume"));
        let end_of_options = index_of(&call.args, "--").expect("-- separator");
        assert_eq!(
            call.args.get(end_of_options + 1).map(String::as_str),
            Some("thread-1")
        );
        assert_eq!(call.args.len(), end_of_options + 2, "the id is the last argument");
    }

    #[test]
    fn each_permission_level_maps_to_its_own_sandbox() {
        let full = CodexAdapter.chat_invocation(&turn(None, Permission::Full)).args;
        assert!(full.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(!full.iter().any(|a| a.starts_with("sandbox_mode")));

        let edits = CodexAdapter.chat_invocation(&turn(None, Permission::Edits)).args;
        assert!(!edits.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(edits.contains(&"sandbox_mode=workspace-write".to_string()));
        assert!(edits.contains(&"approval_policy=never".to_string()));

        let read_only = CodexAdapter
            .chat_invocation(&turn(None, Permission::ReadOnly))
            .args;
        assert!(read_only.contains(&"sandbox_mode=read-only".to_string()));
        assert!(read_only.contains(&"approval_policy=never".to_string()));
    }

    #[test]
    fn model_and_effort_are_forwarded_when_set() {
        let args = CodexAdapter
            .chat_invocation(&TurnRequest {
                model: Some("gpt-5.6-sol"),
                effort: Some("high"),
                ..turn(None, Permission::Full)
            })
            .args;
        let model_at = index_of(&args, "-m").expect("-m present");
        assert_eq!(args.get(model_at + 1).map(String::as_str), Some("gpt-5.6-sol"));
        assert!(args.contains(&"model_reasoning_effort=high".to_string()));
    }

    #[test]
    fn empty_overrides_fall_back_to_cli_defaults() {
        let args = CodexAdapter
            .chat_invocation(&TurnRequest {
                model: Some(""),
                effort: Some(""),
                ..turn(None, Permission::Full)
            })
            .args;
        assert!(!args.contains(&"-m".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("model_reasoning_effort")));
    }

    #[test]
    fn oneshot_runs_read_only_and_never_asks() {
        let call = CodexAdapter.oneshot_invocation("write a commit message", None);
        assert!(call.args.contains(&"sandbox_mode=read-only".to_string()));
        assert!(call.args.contains(&"approval_policy=never".to_string()));
        assert_eq!(call.stdin.as_deref(), Some("write a commit message"));
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
