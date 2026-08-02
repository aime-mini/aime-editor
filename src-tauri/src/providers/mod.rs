pub mod adapter;
pub mod claude;
pub mod codex;
pub mod generic;

use adapter::{adapter_for, Invocation, Permission, TurnRequest};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Holds kill handles so running processes can be cancelled by run_id.
#[derive(Default)]
pub struct ProviderState {
    kill_senders: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

impl ProviderState {
    /// A poisoned lock still holds valid data — recover it instead of panicking.
    fn senders(&self) -> std::sync::MutexGuard<'_, HashMap<String, tokio::sync::oneshot::Sender<()>>> {
        self.kill_senders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Per-turn provider overrides chosen in the UI; `None`/empty = CLI default.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// How much the agent may do on its own; defaults to the least guarded.
    #[serde(default)]
    pub permission: Permission,
}

#[derive(Clone, Serialize)]
struct StreamPayload {
    run_id: String,
    event: Value,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    run_id: String,
    code: Option<i32>,
}

/// Builds a process for a CLI. On Windows, npm-installed CLIs are `.cmd`
/// shims — they must be run through `cmd /C`.
pub fn cli_command<I, S>(program: &str, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program).args(args);
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    }
}

/// Whether the child needs a writable stdin, given how its prompt travels.
fn stdin_for(invocation: &Invocation) -> Stdio {
    if invocation.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    }
}

/// Hands the prompt to a spawned CLI and closes the pipe, which is what tells
/// the CLI the prompt is complete. A failure here means the process died before
/// reading it, so it is reported rather than ignored.
async fn send_prompt(child: &mut Child, invocation: &Invocation) -> Result<(), String> {
    let Some(prompt) = invocation.stdin.as_deref() else {
        return Ok(());
    };
    let mut stdin = child.stdin.take().ok_or("Failed to open the CLI's stdin")?;
    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| format!("Failed to send the prompt: {e}"))?;
    stdin
        .shutdown()
        .await
        .map_err(|e| format!("Failed to finish the prompt: {e}"))
}

/// Sends a prompt to an AI provider and streams each JSONL line to the frontend
/// via the `ai:stream` event. Emits `ai:exit` when done. Returns the run_id immediately.
#[tauri::command]
pub async fn ai_send_prompt(
    app: AppHandle,
    state: State<'_, ProviderState>,
    provider_id: String,
    prompt: String,
    cwd: String,
    session_id: Option<String>,
    options: PromptOptions,
) -> Result<String, String> {
    let run_id = format!("run-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed));

    let adapter = adapter_for(&provider_id)?;
    let invocation = adapter.chat_invocation(&TurnRequest {
        prompt: &prompt,
        cwd: &cwd,
        session_id: session_id.as_deref(),
        model: options.model.as_deref(),
        effort: options.effort.as_deref(),
        permission: options.permission,
    });
    let mut cmd = cli_command(adapter.command(), &invocation.args);
    cmd.current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(stdin_for(&invocation));

    // Structured prefix — the frontend maps it to a localized message (ai.cliMissing).
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("CLI_MISSING::{provider_id}::{e}"))?;
    send_prompt(&mut child, &invocation).await?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let (kill_tx, mut kill_rx) = tokio::sync::oneshot::channel::<()>();
    state.senders().insert(run_id.clone(), kill_tx);

    // stderr goes to its own event stream for debugging
    {
        let app = app.clone();
        let run_id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "ai:stderr",
                    StreamPayload {
                        run_id: run_id.clone(),
                        event: Value::String(line),
                    },
                );
            }
        });
    }

    // stdout JSONL → ai:stream; wait for process exit or a cancel signal
    {
        let app = app.clone();
        let run_id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let code: Option<i32>;
            loop {
                tokio::select! {
                    _ = &mut kill_rx => {
                        let _ = child.kill().await;
                        code = None;
                        break;
                    }
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(text)) => {
                                let event = serde_json::from_str::<Value>(&text)
                                    .unwrap_or_else(|_| serde_json::json!({ "type": "raw", "text": text }));
                                let _ = app.emit("ai:stream", StreamPayload { run_id: run_id.clone(), event });
                            }
                            _ => {
                                code = child.wait().await.ok().and_then(|s| s.code());
                                break;
                            }
                        }
                    }
                }
            }
            if let Some(s) = app.try_state::<ProviderState>() {
                s.senders().remove(&run_id);
            }
            let _ = app.emit(
                "ai:exit",
                ExitPayload {
                    run_id: run_id.clone(),
                    code,
                },
            );
        });
    }

    Ok(run_id)
}

/// Cancels a running AI turn.
#[tauri::command]
pub fn ai_cancel(state: State<'_, ProviderState>, run_id: String) -> Result<(), String> {
    if let Some(tx) = state.senders().remove(&run_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// One-shot AI call (e.g. commit-message generation) — separate from the chat
/// session so it never pollutes conversation history, and constrained by each
/// adapter so it cannot change anything on disk.
#[tauri::command]
pub async fn ai_oneshot(
    provider_id: String,
    prompt: String,
    cwd: String,
    model: Option<String>,
) -> Result<String, String> {
    let adapter = adapter_for(&provider_id)?;
    let invocation = adapter.oneshot_invocation(&prompt, model.as_deref());
    let mut child = cli_command(adapter.command(), &invocation.args)
        .current_dir(&cwd)
        .stdin(stdin_for(&invocation))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("CLI_MISSING::{provider_id}::{e}"))?;
    send_prompt(&mut child, &invocation).await?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("AI call failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "AI call failed".into()
        } else {
            stderr
        });
    }
    adapter.parse_oneshot(&String::from_utf8_lossy(&output.stdout))
}

/// One provider the UI can offer, whether built in or configured.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub display_name: String,
    /// Built-in providers have a capability table in the UI; configured ones
    /// get the neutral defaults, since Aime cannot know their models.
    pub built_in: bool,
    pub install_command: String,
    /// "plain" or "jsonl": how the frontend should read this CLI's output.
    pub parser: String,
    /// For jsonl: the field carrying assistant text.
    pub text_field: String,
}

/// Every provider Aime can talk to right now.
#[tauri::command]
pub fn list_providers() -> Vec<ProviderSummary> {
    let mut providers = vec![
        ProviderSummary {
            id: "claude".into(),
            display_name: "Claude Code".into(),
            built_in: true,
            install_command: "npm install -g @anthropic-ai/claude-code".into(),
            parser: "claude".into(),
            text_field: String::new(),
        },
        ProviderSummary {
            id: "codex".into(),
            display_name: "Codex".into(),
            built_in: true,
            install_command: "npm install -g @openai/codex".into(),
            parser: "codex".into(),
            text_field: String::new(),
        },
    ];
    providers.extend(generic::configured().iter().map(|adapter| ProviderSummary {
        id: adapter.config.id.clone(),
        display_name: adapter.config.display_name.clone(),
        built_in: false,
        install_command: adapter.config.install.clone(),
        parser: match adapter.config.parser {
            generic::ParserKind::Plain => "plain".into(),
            generic::ParserKind::Jsonl => "jsonl".into(),
        },
        text_field: adapter.config.text_field.clone(),
    }));
    providers
}

/// A ready-to-edit example, written the first time the user asks for it: an
/// empty file teaches nothing, and a wrong guess at the schema costs more time
/// than it saves.
const PROVIDERS_TEMPLATE: &str = r#"[
  {
    "id": "gemini",
    "displayName": "Gemini CLI",
    "command": "gemini",
    "args": ["-p", "{prompt}"],
    "promptStdin": false,
    "resumeArgs": [],
    "parser": "plain",
    "login": "gemini auth login",
    "install": "npm install -g @google/gemini-cli",
    "memory": "config-pointer",
    "memoryFile": ".gemini/GEMINI.md"
  }
]
"#;

/// Where the user writes their own provider definitions. Creates the file with
/// a working example on first use, and returns the path either way.
#[tauri::command]
pub fn providers_config_path(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("providers.json");
    if !path.exists() {
        std::fs::write(&path, PROVIDERS_TEMPLATE).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub installed: bool,
    pub version: Option<String>,
    /// `None` = the CLI offers no sign-in probe, so the state is unknown.
    pub signed_in: Option<bool>,
    /// Command that signs the user in, offered as a one-click terminal action.
    pub login_command: String,
}

/// Availability + sign-in probe (`<cli> --version`, then the adapter's auth
/// check) so the UI can guide the user before the first prompt instead of
/// failing mid-conversation.
#[tauri::command]
pub async fn provider_health(provider_id: String) -> Result<ProviderHealth, String> {
    let adapter = adapter_for(&provider_id)?;
    let login_command = adapter.login_command().to_string();

    let version = match cli_command(adapter.command(), ["--version"]).output().await {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => None,
    };
    if version.is_none() {
        return Ok(ProviderHealth {
            installed: false,
            version: None,
            signed_in: None,
            login_command,
        });
    }

    let mut signed_in = None;
    if let Some(probe) = adapter.auth_probe_args() {
        if let Ok(output) = cli_command(adapter.command(), probe).output().await {
            let stdout = String::from_utf8_lossy(&output.stdout);
            signed_in = Some(adapter.is_signed_in(output.status.success(), stdout.trim()));
        }
    }

    Ok(ProviderHealth {
        installed: true,
        version,
        signed_in,
        login_command,
    })
}
