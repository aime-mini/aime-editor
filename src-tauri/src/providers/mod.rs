pub mod adapter;
pub mod catalog;
pub mod claude;
pub mod codex;
pub mod generic;
pub mod keys;
pub mod next_run;
pub mod ran_on;

use crate::program::Program;
use adapter::{
    adapter_for, Adapter, ApiKeyRoute, Invocation, OutputSchema, Permission, ToolSet, TurnRequest,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Holds kill handles so running processes can be cancelled by run_id, and
/// the open input of every turn that still takes messages.
#[derive(Default)]
pub struct ProviderState {
    kill_senders: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    inputs: Mutex<HashMap<String, TurnInput>>,
}

/// The stdin of a conversing turn, held open: lines go to the writer task
/// that owns the pipe, and dropping this sender is what closes it.
struct TurnInput {
    adapter: Arc<dyn Adapter>,
    lines: mpsc::UnboundedSender<String>,
    /// Messages handed to the CLI so far, the prompt included. Changed and
    /// read only under the `inputs` lock, so the input never closes between a
    /// message being written and it being counted.
    written: usize,
}

/// The error `ai_steer` answers when the turn takes no more messages: it is
/// over, or its CLI never took any. The frontend keeps the message queued.
const INPUT_CLOSED: &str = "INPUT_CLOSED";

impl ProviderState {
    /// A poisoned lock still holds valid data — recover it instead of panicking.
    fn senders(&self) -> std::sync::MutexGuard<'_, HashMap<String, tokio::sync::oneshot::Sender<()>>> {
        self.kill_senders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn inputs(&self) -> std::sync::MutexGuard<'_, HashMap<String, TurnInput>> {
        self.inputs
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
    /// Which tools the turn has at all; defaults to all of them.
    #[serde(default)]
    pub tools: ToolSet,
    /// A JSON Schema the answer must match; the caller reads the answer as data.
    #[serde(default)]
    pub schema: Option<Value>,
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
/// command line at the first newline, and measured on Windows the
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
pub(super) fn stored_key(app: &AppHandle, provider_id: &str) -> Option<String> {
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
/// with no key configured nothing changes about the CLI's own login. Measured:
/// `claude -p` honours `ANTHROPIC_API_KEY`, and the CLI itself
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

/// Hands the prompt to a spawned CLI. A one-prompt CLI gets the pipe closed
/// right behind it, which is what tells it the prompt is complete; a
/// conversing CLI keeps it, in a writer task that takes further lines until
/// the returned sender is dropped. A failure here means the process died
/// before reading the prompt, so it is reported rather than ignored.
async fn send_prompt(
    child: &mut Child,
    invocation: &Invocation,
) -> Result<Option<mpsc::UnboundedSender<String>>, String> {
    let Some(prompt) = invocation.stdin.as_deref() else {
        return Ok(None);
    };
    let mut stdin = child.stdin.take().ok_or("Failed to open the CLI's stdin")?;
    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| format!("Failed to send the prompt: {e}"))?;
    if !invocation.keeps_input {
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("Failed to finish the prompt: {e}"))?;
        return Ok(None);
    }
    let (lines, mut queue) = mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        while let Some(line) = queue.recv().await {
            if let Err(err) = stdin.write_all(line.as_bytes()).await {
                eprintln!("could not hand a message to the running turn: {err}");
                break;
            }
        }
        // The pipe drops with the task: the end of input the CLI waits for.
    });
    Ok(Some(lines))
}

/// Closes a turn's input if it still had one; the writer task drops the pipe.
fn close_input(app: &AppHandle, run_id: &str) {
    if let Some(state) = app.try_state::<ProviderState>() {
        state.inputs().remove(run_id);
    }
}

/// Closes a turn's input once the CLI is done with every message written to
/// it. Checked under the lock `ai_steer` writes under: a message handed over a
/// moment ago keeps the input open for its answer.
fn close_input_once_read(app: &AppHandle, run_id: &str, read: usize) {
    let Some(state) = app.try_state::<ProviderState>() else {
        return;
    };
    let mut inputs = state.inputs();
    if inputs.get(run_id).is_some_and(|input| input.written <= read) {
        inputs.remove(run_id);
    }
}

/// When a conversing turn stops taking messages: once the CLI has read every
/// message written to it, answered the last one, and nothing it started still
/// runs in the background.
///
/// Closing at the first answer is what stranded the chat behind a dev server.
/// Measured on Claude 2.1.309, twice over:
/// - With a background shell still running, a closed input does not end the
///   process - it waits for the shell, which for a server is forever, and every
///   message written meanwhile sat in the queue. Kept open, a message written
///   after the answer starts the next answer at once, beside the server; when
///   the last task ends the CLI answers once more on its own.
/// - A resumed session whose last turn left a task behind opens with an answer
///   to that task's notification - an empty `result` - before it has read the
///   prompt. Counting that as the answer closed the input before the prompt
///   started its server, and the process hung behind it all the same.
#[derive(Default)]
struct InputGate {
    /// Messages the CLI is done with: read, as its echo says, or taken back
    /// before it was - one taken back is never echoed, and waiting for it
    /// would keep the turn open for good.
    read: usize,
    /// Whether an answer has come since the last message was read.
    answered: bool,
    background: usize,
}

impl InputGate {
    /// Takes in one stdout line. `Some(read)` when the input may close - if
    /// those are all the messages that were written (`close_input_once_read`).
    fn closes_after(&mut self, adapter: &dyn Adapter, event: &Value) -> Option<usize> {
        if adapter.reads_message(event) {
            self.read += 1;
            self.answered = false;
        }
        if adapter.withdrew_message(event) {
            self.read += 1;
        }
        if let Some(count) = adapter.background_tasks(event) {
            self.background = count;
        }
        if adapter.ends_turn(event) && self.read > 0 {
            self.answered = true;
        }
        (self.answered && self.background == 0).then_some(self.read)
    }
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
    // A guarantee the adapter cannot give is refused, not approximated: the
    // frontend maps the prefix to a sentence naming the CLIs that can.
    if options.tools == ToolSet::FilesOnly && !adapter.restricts_tools() {
        return Err(format!("TOOLS_UNRESTRICTED::{provider_id}"));
    }
    // The schema travels both ways a CLI takes it: as text, and as a file
    // under the app's cache named by its content, so equal schemas share one.
    let schema_json = options.schema.as_ref().map(Value::to_string);
    let schema_file = match &schema_json {
        Some(json) => Some(schema_file_for(&app, json)?),
        None => None,
    };
    let schema = schema_json
        .as_deref()
        .zip(schema_file.as_deref())
        .map(|(json, file)| OutputSchema { json, file });
    let invocation = adapter.chat_invocation(&TurnRequest {
        prompt: &prompt,
        cwd: &cwd,
        session_id: session_id.as_deref(),
        model: options.model.as_deref(),
        effort: options.effort.as_deref(),
        permission: options.permission,
        tools: options.tools,
        schema,
    });
    prompt_can_travel(adapter.command(), &invocation)?;
    let mut cmd = cli_command(adapter.command(), &invocation.args);
    apply_api_key(&mut cmd, &app, adapter.as_ref(), &provider_id);
    cmd.current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(stdin_for(&invocation));
    // Stop has to reach what the agent left running too - a dev server
    // started in the background outlives the CLI otherwise, holding its port.
    crate::exec::lead_own_group(&mut cmd);

    // Structured prefix — the frontend maps it to a localized message (ai.cliMissing).
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("CLI_MISSING::{provider_id}::{e}"))?;
    let pid = child.id();
    let input = send_prompt(&mut child, &invocation).await?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let (kill_tx, mut kill_rx) = tokio::sync::oneshot::channel::<()>();
    state.senders().insert(run_id.clone(), kill_tx);
    let conversing = input.is_some();
    if let Some(lines) = input {
        let adapter = adapter.clone();
        state.inputs().insert(
            run_id.clone(),
            TurnInput {
                adapter,
                lines,
                written: 1,
            },
        );
    }

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
            let mut gate = InputGate::default();
            let code: Option<i32>;
            loop {
                tokio::select! {
                    _ = &mut kill_rx => {
                        crate::exec::end_tree(&mut child, pid).await;
                        code = None;
                        break;
                    }
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(text)) => {
                                let event = serde_json::from_str::<Value>(&text)
                                    .unwrap_or_else(|_| serde_json::json!({ "type": "raw", "text": text }));
                                // A conversing CLI only exits once its input is closed;
                                // a message already written by then still runs first.
                                if conversing {
                                    if let Some(read) = gate.closes_after(adapter.as_ref(), &event) {
                                        close_input_once_read(&app, &run_id, read);
                                    }
                                }
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
            close_input(&app, &run_id);
            if let Some(s) = app.try_state::<ProviderState>() {
                s.senders().remove(&run_id);
            }
            // Every turn tells the agent to journal into `.aime/`, so the folder
            // can have just been born in someone else's repository. Guard it
            // here, while the turn that created it is still ending.
            if let Err(err) = crate::aime_dir::ensure_self_ignored(std::path::Path::new(&cwd)) {
                eprintln!("[aime_dir] could not write the .aime guard in '{cwd}': {err}");
            }
            // The turn may have written memories; the mirror is what survives a re-clone.
            crate::memory_mirror::after_turn(&app, std::path::Path::new(&cwd));
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

/// Hands a message to a turn still running, for a CLI that takes one while it
/// works (`Adapter::steer_line`). `INPUT_CLOSED` when the turn takes no more:
/// the frontend keeps the message queued for the turn after, as for any CLI.
#[tauri::command]
pub fn ai_steer(
    state: State<'_, ProviderState>,
    run_id: String,
    text: String,
    id: String,
) -> Result<(), String> {
    let mut inputs = state.inputs();
    let input = inputs.get_mut(&run_id).ok_or(INPUT_CLOSED)?;
    let line = input.adapter.steer_line(&text, &id).ok_or(INPUT_CLOSED)?;
    input.lines.send(line).map_err(|_| INPUT_CLOSED.to_string())?;
    input.written += 1;
    Ok(())
}

/// Asks the CLI to take back a message handed over with `ai_steer` that the
/// AI has not read yet (`Adapter::withdraw_line`); its answer arrives on the
/// turn's stream. `INPUT_CLOSED` when the turn takes no more.
///
/// Not counted in `written`: that counts the messages the CLI will echo, and
/// the answer to this is not one of them.
#[tauri::command]
pub fn ai_withdraw(state: State<'_, ProviderState>, run_id: String, id: String) -> Result<(), String> {
    let inputs = state.inputs();
    let input = inputs.get(&run_id).ok_or(INPUT_CLOSED)?;
    let line = input.adapter.withdraw_line(&id).ok_or(INPUT_CLOSED)?;
    input.lines.send(line).map_err(|_| INPUT_CLOSED.to_string())
}

/// Writes a schema under the app's cache, named by its content, for a CLI
/// that reads schemas from a file.
fn schema_file_for(app: &AppHandle, json: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("schemas");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make the schema folder: {e}"))?;
    let file = dir.join(format!("{:016x}.json", fnv64(json)));
    if !file.exists() {
        std::fs::write(&file, json).map_err(|e| format!("could not write the schema file: {e}"))?;
    }
    Ok(file)
}

/// FNV-1a over the text: a file name for content, short and the same everywhere.
fn fnv64(text: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    text.bytes()
        .fold(OFFSET, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(PRIME))
}

/// Cancels a running AI turn.
#[tauri::command]
pub fn ai_cancel(state: State<'_, ProviderState>, run_id: String) -> Result<(), String> {
    state.inputs().remove(&run_id);
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
    /// Whether a message written during a turn reaches the AI in that turn
    /// (`ai_steer`), rather than only as the next one.
    pub steers: bool,
    /// Whether a message handed over that way can still be taken back until
    /// the AI reads it (`ai_withdraw`).
    pub withdraws: bool,
    /// How this provider takes an API key, if it does. `None` hides the key
    /// field in Settings; the two routes are worded differently there, because
    /// one is Aime's secret to keep and the other replaces the CLI's login.
    pub api_key_route: Option<ApiKeyRoute>,
}

/// Set by automation that drives the person's real CLI - the e2e suite - where
/// a turn nobody asked for would spend their money on every run.
const NO_BACKGROUND_TURNS_VAR: &str = "AIME_NO_BACKGROUND_TURNS";

/// Whether Aime may start turns of its own, such as learning a project it was just opened on.
#[tauri::command]
pub fn background_turns_allowed() -> bool {
    std::env::var_os(NO_BACKGROUND_TURNS_VAR).is_none()
}

/// Whether the adapter's CLI takes a message mid-turn.
fn steers(adapter: &dyn Adapter) -> bool {
    adapter.steer_line("", "").is_some()
}

/// Whether the adapter's CLI gives back a message it has not read yet.
fn withdraws(adapter: &dyn Adapter) -> bool {
    adapter.withdraw_line("").is_some()
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
            steers: steers(&claude::ClaudeAdapter),
            withdraws: withdraws(&claude::ClaudeAdapter),
            api_key_route: claude::ClaudeAdapter.api_key_route(),
        },
        ProviderSummary {
            id: "codex".into(),
            display_name: "Codex".into(),
            built_in: true,
            install_command: "npm install -g @openai/codex".into(),
            parser: "codex".into(),
            text_field: String::new(),
            steers: steers(&codex::CodexAdapter),
            withdraws: withdraws(&codex::CodexAdapter),
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
        steers: steers(adapter.as_ref()),
        withdraws: withdraws(adapter.as_ref()),
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
    "memory": "config-pointer"
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

    /// The lines Claude 2.1.309 printed around a server started with
    /// `run_in_background`, in the order it printed them.
    mod background_run {
        use serde_json::{json, Value};

        pub fn started() -> Value {
            json!({ "type": "system", "subtype": "background_tasks_changed",
                    "tasks": [{ "task_id": "bp0ezkwwf", "task_type": "local_bash" }] })
        }
        pub fn finished() -> Value {
            json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [] })
        }
        pub fn answer() -> Value {
            json!({ "type": "result", "subtype": "success", "result": "STARTED" })
        }
        /// A message of Aime's, echoed as the CLI takes it up.
        pub fn read() -> Value {
            json!({ "type": "user", "message": { "role": "user", "content": "start the server" } })
        }
        /// The CLI's answer to taking a message back, captured from 2.1.310.
        pub fn withdrawal(cancelled: bool) -> Value {
            json!({ "type": "control_response", "response": { "subtype": "success",
                    "request_id": "e6576fcc", "response": { "cancelled": cancelled } } })
        }
        /// A tool's answer travels as a `user` line too, but is not a message.
        pub fn tool_result() -> Value {
            json!({ "type": "user", "message": { "role": "user",
                    "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }] } })
        }
        /// What a resumed session says first when its last turn left a task behind.
        pub fn leftover() -> [Value; 2] {
            [
                json!({ "type": "system", "subtype": "task_notification" }),
                json!({ "type": "result", "subtype": "success", "result": "" }),
            ]
        }
    }

    #[test]
    fn the_input_stays_open_while_the_answer_left_work_running() {
        let claude = claude::ClaudeAdapter;
        let mut gate = InputGate::default();
        assert_eq!(gate.closes_after(&claude, &background_run::read()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::started()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::tool_result()), None);
        assert_eq!(
            gate.closes_after(&claude, &background_run::answer()),
            None,
            "a server still runs: the next message must still reach the CLI"
        );
        assert_eq!(gate.closes_after(&claude, &background_run::read()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::answer()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::finished()), Some(2));
    }

    #[test]
    fn the_input_closes_at_the_answer_when_nothing_runs_behind_it() {
        let claude = claude::ClaudeAdapter;
        let mut gate = InputGate::default();
        assert_eq!(gate.closes_after(&claude, &background_run::read()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::answer()), Some(1));
    }

    #[test]
    fn a_message_taken_back_counts_as_done_with_and_one_already_read_does_not_count_twice() {
        let claude = claude::ClaudeAdapter;
        let mut gate = InputGate::default();
        assert_eq!(gate.closes_after(&claude, &background_run::read()), None);
        assert_eq!(
            gate.closes_after(&claude, &background_run::withdrawal(true)),
            None
        );
        assert_eq!(
            gate.closes_after(&claude, &background_run::answer()),
            Some(2),
            "the prompt and the message taken back are all that was written"
        );

        let mut gate = InputGate::default();
        assert_eq!(gate.closes_after(&claude, &background_run::read()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::read()), None);
        assert_eq!(
            gate.closes_after(&claude, &background_run::withdrawal(false)),
            None
        );
        assert_eq!(gate.closes_after(&claude, &background_run::answer()), Some(2));
    }

    #[test]
    fn an_answer_before_the_prompt_was_read_does_not_close_the_input() {
        let claude = claude::ClaudeAdapter;
        let mut gate = InputGate::default();
        for line in background_run::leftover() {
            assert_eq!(gate.closes_after(&claude, &line), None, "{line}");
        }
        assert_eq!(gate.closes_after(&claude, &background_run::read()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::started()), None);
        assert_eq!(gate.closes_after(&claude, &background_run::answer()), None);
    }

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
            prompt_stdin: false,
            api_key_env: String::new(),
            api_key_login_args: vec![script.to_string_lossy().to_string()],
            models_args: Vec::new(),
            models_url: String::new(),
            light_model: String::new(),
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
