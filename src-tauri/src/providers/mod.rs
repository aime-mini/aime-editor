pub mod adapter;
pub mod claude;
pub mod codex;
pub mod generic;
pub mod keys;

use crate::program::Program;
use adapter::{adapter_for, Adapter, ApiKeyRoute, Invocation, Permission, TurnRequest};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
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

/// Builds a process for a CLI, spawning it the one way that name can be run.
///
/// A resolved executable is spawned directly, so every argument arrives as
/// written; only a batch shim (`.cmd`/`.bat`, how npm installs a Node CLI on
/// Windows) goes through cmd.exe, and then by absolute path so a folder with a
/// space in its name stays one argument. `program.rs` carries the measurement
/// that made this the shape it is.
pub fn cli_command<I, S>(program: &str, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let resolved = Program::resolve(program);
    let mut cmd = if resolved.is_batch_shim() {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(resolved.path()).args(args);
        cmd
    } else {
        let mut cmd = Command::new(resolved.path());
        cmd.args(args);
        cmd
    };
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// Refuses a turn whose prompt could not survive the trip.
///
/// A prompt carried in an argument cannot reach a batch shim: cmd.exe ends a
/// command line at the first newline, and measured on Windows (2026-09-03) the
/// shim then receives an *empty* argument tail while exiting 0 — the prompt is
/// lost and the run looks successful. Saying so beats answering from nothing,
/// and the message names the one setting that fixes it.
fn prompt_can_travel(command: &str, invocation: &Invocation) -> Result<(), String> {
    if prompt_would_be_lost(invocation, Program::resolve(command).is_batch_shim()) {
        return Err(format!("PROMPT_NEEDS_STDIN::{command}"));
    }
    Ok(())
}

/// The decision itself, apart from the machine it is asked about: all three
/// conditions have to hold, and stdin clears it whatever the target is.
fn prompt_would_be_lost(invocation: &Invocation, through_shell: bool) -> bool {
    through_shell && invocation.stdin.is_none() && invocation.args.iter().any(|arg| arg.contains('\n'))
}

/// Aime's own config folder, where `providers.json` and `api-keys.json` live.
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("Could not locate the config folder: {e}"))
}

/// The key Aime stores for a provider, for the one route where Aime stores it.
fn stored_key(app: &AppHandle, provider_id: &str) -> Option<String> {
    match config_dir(app) {
        Ok(dir) => keys::api_key(&dir, provider_id),
        Err(err) => {
            eprintln!("[providers] no config dir, so no API key for {provider_id}: {err}");
            None
        }
    }
}

/// Puts the provider's API key into one spawn's environment, for CLIs that
/// authenticate that way (`ApiKeyRoute::Env`).
///
/// Only Aime's own spawns get the key: the user's terminals never see it, and
/// with no key configured nothing changes about the CLI's own login. Measured
/// (2026-08-16): `claude -p` honours `ANTHROPIC_API_KEY`, and the CLI itself
/// says the key takes precedence over the claude.ai login for that process.
fn apply_api_key(cmd: &mut Command, app: &AppHandle, adapter: &dyn Adapter, provider_id: &str) {
    let Some(ApiKeyRoute::Env { variable }) = adapter.api_key_route() else {
        return; // no key route, or one whose key the CLI stores itself
    };
    if let Some(key) = stored_key(app, provider_id) {
        cmd.env(variable, key);
    }
}

/// Whether Aime holds a key for this provider. False for a CLI that stores its
/// own key — that credential is the CLI's, and its status probe reports it.
fn api_key_configured(app: &AppHandle, adapter: &dyn Adapter, provider_id: &str) -> bool {
    matches!(adapter.api_key_route(), Some(ApiKeyRoute::Env { .. })) && stored_key(app, provider_id).is_some()
}

/// Runs the CLI's auth probe the way Aime's own turns run — with the API key
/// in the environment, when there is one. Probing a different environment from
/// the one the next turn will use is how a health chip ends up lying.
async fn probe_auth(app: &AppHandle, adapter: &dyn Adapter, provider_id: &str) -> Option<(bool, String)> {
    let probe = adapter.auth_probe_args()?;
    let mut cmd = cli_command(adapter.command(), probe);
    apply_api_key(&mut cmd, app, adapter, provider_id);
    let output = cmd.output().await.ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Some((output.status.success(), stdout))
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
    prompt_can_travel(adapter.command(), &invocation)?;
    let mut cmd = cli_command(adapter.command(), &invocation.args);
    apply_api_key(&mut cmd, &app, adapter.as_ref(), &provider_id);
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
            // Every turn tells the agent to journal into `.aime/`, so the folder
            // can have just been born in someone else's repository. Guard it
            // here, while the turn that created it is still ending.
            if let Err(err) = crate::aime_dir::ensure_self_ignored(std::path::Path::new(&cwd)) {
                eprintln!("[aime_dir] could not write the .aime guard in '{cwd}': {err}");
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
    app: AppHandle,
    provider_id: String,
    prompt: String,
    cwd: String,
    model: Option<String>,
) -> Result<String, String> {
    let adapter = adapter_for(&provider_id)?;
    let invocation = adapter.oneshot_invocation(&prompt, model.as_deref());
    prompt_can_travel(adapter.command(), &invocation)?;
    let mut cmd = cli_command(adapter.command(), &invocation.args);
    apply_api_key(&mut cmd, &app, adapter.as_ref(), &provider_id);
    let mut child = cmd
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
    /// How this provider takes an API key, if it does. `None` hides the key
    /// field in Settings; the two routes are worded differently there, because
    /// one is Aime's secret to keep and the other replaces the CLI's login.
    pub api_key_route: Option<ApiKeyRoute>,
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
            api_key_route: claude::ClaudeAdapter.api_key_route(),
        },
        ProviderSummary {
            id: "codex".into(),
            display_name: "Codex".into(),
            built_in: true,
            install_command: "npm install -g @openai/codex".into(),
            parser: "codex".into(),
            text_field: String::new(),
            api_key_route: codex::CodexAdapter.api_key_route(),
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
        api_key_route: adapter.api_key_route(),
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
    "apiKeyEnv": "GEMINI_API_KEY",
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
    /// True when Aime holds a key for this provider (the `Env` route). A CLI
    /// that stores its own key reports that through `signed_in` instead.
    pub api_key: bool,
}

/// Availability + sign-in probe (`<cli> --version`, then the adapter's auth
/// check) so the UI can guide the user before the first prompt instead of
/// failing mid-conversation.
#[tauri::command]
pub async fn provider_health(app: AppHandle, provider_id: String) -> Result<ProviderHealth, String> {
    let adapter = adapter_for(&provider_id)?;
    let login_command = adapter.login_command();
    let api_key = api_key_configured(&app, adapter.as_ref(), &provider_id);

    let version = match cli_command(adapter.command(), ["--version"]).output().await {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => None,
    };
    if version.is_none() {
        // A key does not install a CLI: missing stays missing, key or not.
        return Ok(ProviderHealth {
            installed: false,
            version: None,
            signed_in: None,
            login_command,
            api_key,
        });
    }

    // The probe runs with the key injected, so it answers about the environment
    // the next turn will actually get.
    let mut signed_in = probe_auth(&app, adapter.as_ref(), &provider_id)
        .await
        .map(|(exit_ok, stdout)| adapter.is_signed_in(exit_ok, &stdout));
    // No probe at all (every configured CLI): then the stored key is the only
    // credential Aime knows of, and it is a real one.
    if signed_in.is_none() && api_key {
        signed_in = Some(true);
    }

    Ok(ProviderHealth {
        installed: true,
        version,
        signed_in,
        login_command,
        api_key,
    })
}

/// What Aime can honestly say about a key it has just accepted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyOutcome {
    /// `Some(true)`: the CLI itself now reports it is using an API key.
    /// `Some(false)`: it answered, and it is not using one — the key never
    /// arrived, which is what a mistyped variable name looks like.
    /// `None`: this CLI says nothing about keys, so Aime claims nothing.
    pub cli_confirmed: Option<bool>,
}

/// Takes an API key for one provider through whichever door its CLI has, then
/// asks that CLI what it now thinks — the closest thing to verification that
/// exists, since no CLI validates a key at the moment it is handed one
/// (measured: `codex login --with-api-key` stored a plainly invalid key and
/// exited 0, and `claude -p` with a bad key retries for minutes before saying
/// anything at all).
///
/// The stored route is write-only by design: the frontend may ask *whether* a
/// key exists (`ProviderHealth::api_key`), never what it is.
#[tauri::command]
pub async fn provider_set_api_key(
    app: AppHandle,
    provider_id: String,
    key: String,
) -> Result<ApiKeyOutcome, String> {
    let adapter = adapter_for(&provider_id)?;
    let route = adapter
        .api_key_route()
        // Storing a key nothing would ever read is a silent lie.
        .ok_or_else(|| format!("{provider_id} does not take an API key through Aime"))?;

    match route {
        ApiKeyRoute::Env { .. } => keys::set_api_key(&config_dir(&app)?, &provider_id, &key)?,
        ApiKeyRoute::CliLogin { args } => {
            if key.trim().is_empty() {
                // This key belongs to the CLI, so only the CLI can drop it.
                return Err(format!(
                    "This key is stored by the CLI itself - sign out with `{}`",
                    adapter.login_command()
                ));
            }
            hand_key_to_cli(adapter.as_ref(), &args, key.trim()).await?;
        }
    }

    Ok(ApiKeyOutcome {
        cli_confirmed: match probe_auth(&app, adapter.as_ref(), &provider_id).await {
            Some((_, stdout)) => adapter.probe_sees_api_key(&stdout),
            None => None,
        },
    })
}

/// Hands a key to a CLI that stores keys itself, on its stdin — never as an
/// argument, which would put the secret in the process list.
async fn hand_key_to_cli(adapter: &dyn Adapter, args: &[String], key: &str) -> Result<(), String> {
    let mut child = cli_command(adapter.command(), args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run `{} {}`: {e}", adapter.command(), args.join(" ")))?;
    {
        // The pipe closes when this handle drops, and only then - `shutdown`
        // alone leaves the CLI waiting on stdin forever (measured: the command
        // never returned until this scope was added). EOF is what tells it the
        // key is complete.
        let mut stdin = child.stdin.take().ok_or("Failed to open the CLI's stdin")?;
        stdin
            .write_all(key.as_bytes())
            .await
            .map_err(|e| format!("Failed to hand the key over: {e}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("Failed to finish handing the key over: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("The CLI did not finish: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    // The CLI's own refusal is the useful half; its stdout is usually empty here.
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("`{}` refused the key", adapter.command())
    } else {
        stderr
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use generic::{GenericAdapter, ProviderConfig};

    /// A configured "CLI" that stores the key it is handed: node, writing its
    /// stdin to a file. The script is a file rather than `node -e …` because on
    /// Windows every argument crosses `cmd /C`, which mangles quotes.
    fn key_sink_adapter(name: &str) -> (GenericAdapter, PathBuf) {
        let dir = std::env::temp_dir().join(format!("aime-login-route-{name}"));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let sink = dir.join("key.txt");
        let script = dir.join("login.cjs");
        std::fs::write(
            &script,
            format!(
                "const fs=require(\"node:fs\");fs.writeFileSync({},fs.readFileSync(0,\"utf8\"));",
                serde_json::to_string(&sink.to_string_lossy()).expect("path as json")
            ),
        )
        .expect("script");

        let config = ProviderConfig {
            id: name.into(),
            display_name: name.into(),
            command: "node".into(),
            args: vec![],
            resume_args: vec![],
            parser: generic::ParserKind::Plain,
            text_field: String::new(),
            login: String::new(),
            install: String::new(),
            memory: generic::MemoryStrategy::default(),
            memory_file: String::new(),
            prompt_stdin: false,
            api_key_env: String::new(),
            api_key_login_args: vec![script.to_string_lossy().to_string()],
        };
        (GenericAdapter { config }, sink)
    }

    #[tokio::test]
    async fn a_key_reaches_the_clis_own_login_command_on_its_stdin() {
        let (adapter, sink) = key_sink_adapter("ok");
        let _ = std::fs::remove_file(&sink);
        let args = vec![adapter.config.api_key_login_args[0].clone()];

        hand_key_to_cli(&adapter, &args, "sk-handed-over")
            .await
            .expect("hand over");

        assert_eq!(
            std::fs::read_to_string(&sink).expect("the CLI never wrote the key"),
            "sk-handed-over"
        );
        let _ = std::fs::remove_dir_all(sink.parent().expect("dir"));
    }

    #[tokio::test]
    async fn a_cli_that_refuses_the_key_says_so_in_its_own_words() {
        let (adapter, sink) = key_sink_adapter("refuses");
        let dir = sink.parent().expect("dir").to_path_buf();
        let script = dir.join("refuse.cjs");
        std::fs::write(&script, "console.error(\"bad key\");process.exit(3);").expect("script");

        let error = hand_key_to_cli(&adapter, &[script.to_string_lossy().to_string()], "sk-bad")
            .await
            .expect_err("a refusing CLI must not report success");

        assert!(
            error.contains("bad key"),
            "the CLI's own refusal was lost: {error}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A prompt lost on the way is worse than a refusal, because the CLI
    /// answers from nothing and exits 0. All three conditions have to hold.
    #[test]
    fn only_a_multi_line_argument_through_a_shell_loses_the_prompt() {
        let multi_line = vec!["-p".to_string(), "line one\nline two".to_string()];
        let one_line = vec!["-p".to_string(), "just the one".to_string()];

        assert!(
            prompt_would_be_lost(&Invocation::plain(multi_line.clone()), true),
            "cmd.exe cannot carry a newline in an argument"
        );
        assert!(
            !prompt_would_be_lost(&Invocation::piped(multi_line.clone(), "line one\nline two"), true),
            "stdin has no such limit, so a shim is fine that way"
        );
        assert!(
            !prompt_would_be_lost(&Invocation::plain(multi_line), false),
            "a directly spawned executable takes every argument as written"
        );
        assert!(
            !prompt_would_be_lost(&Invocation::plain(one_line), true),
            "a single-line argument survives cmd.exe"
        );
    }

    /// The resolver has to keep producing something spawnable, so it is driven
    /// against a real tool rather than trusted: `git` is on PATH wherever this
    /// repository is, and answers the same way on all three platforms.
    #[tokio::test]
    async fn cli_command_runs_a_real_tool_it_resolved_itself() {
        let output = cli_command("git", ["--version"])
            .output()
            .await
            .expect("git runs through cli_command");

        assert!(output.status.success(), "git --version failed");
        assert!(
            String::from_utf8_lossy(&output.stdout).starts_with("git version"),
            "unexpected answer: {:?}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

/// Re-reads `providers.json` and publishes it, so a CLI added while Aime runs
/// shows up without a restart. Returns the new list in the same round trip.
#[tauri::command]
pub fn providers_reload(app: AppHandle) -> Result<Vec<ProviderSummary>, String> {
    let path = config_dir(&app)?.join("providers.json");
    generic::install(generic::load(&path));
    Ok(list_providers())
}
