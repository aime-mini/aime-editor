//! What a CLI will run the next turn on - its model and reasoning effort -
//! asked of the CLI itself before anything is sent.
//!
//! `ran_on` answers once a turn has run; until then a picker left on Auto -
//! the effort under a model just chosen, or both in a new conversation - could
//! only say "Auto" (reported 2026-10-19). Nor can the answer be worked out
//! from the settings files: measured on Claude Code 2.1.303, the effort comes
//! out of per-model settings, server-pushed defaults and caps, and Sonnet 5.5
//! runs at `medium` while `effortLevel` says `high`. So each CLI is asked,
//! without a prompt and without spending a token:
//!
//! - **Claude Code** answers the `get_settings` control request of its
//!   stream-json mode with `applied: {model, effort}`, the CLI's own
//!   resolution for that model in that folder (2.1.303: about 2 s, and no
//!   session file is written).
//! - **Codex** answers over `app-server`: `model/list` marks the default model
//!   and gives each model's `defaultReasoningEffort`, `config/read` the
//!   effective `model` and `model_reasoning_effort` as seen from the project
//!   (0.146.0: about 0.3 s).
//!
//! A configured CLI offers no such question; its picker learns from `ran_on`.

use super::adapter::adapter_for;
use super::ran_on::RanOn;
use super::{apply_api_key, cli_command};
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;

/// Covers a cold start of either CLI, with room to spare.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(20);

const CLAUDE_REQUEST_ID: &str = "aime-next-run";

const CODEX_INITIALIZE_ID: u64 = 1;
const CODEX_MODEL_LIST_ID: u64 = 2;
const CODEX_CONFIG_READ_ID: u64 = 3;

/// The model and effort the provider's CLI would run the next turn on in
/// `cwd`, with `model` chosen or (None) left to the CLI; None when the
/// provider cannot be asked.
#[tauri::command]
pub async fn provider_next_run(
    app: AppHandle,
    provider_id: String,
    model: Option<String>,
    cwd: String,
) -> Result<Option<RanOn>, String> {
    let model = model.filter(|chosen| !chosen.is_empty());
    let asked = async {
        match provider_id.as_str() {
            "claude" => ask_claude(&app, model.as_deref(), &cwd).await,
            "codex" => ask_codex(&app, model.as_deref(), &cwd).await,
            _ => Ok(None),
        }
    };
    tokio::time::timeout(ANSWER_TIMEOUT, asked)
        .await
        .map_err(|_| format!("{provider_id} did not say what it would run on within {ANSWER_TIMEOUT:?}"))?
}

// ---- Claude Code -------------------------------------------------------------

async fn ask_claude(app: &AppHandle, model: Option<&str>, cwd: &str) -> Result<Option<RanOn>, String> {
    let mut args = vec![
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ];
    if let Some(model) = model {
        args.extend(["--model", model]);
    }
    let request = json!({
        "type": "control_request",
        "request_id": CLAUDE_REQUEST_ID,
        "request": { "subtype": "get_settings" },
    });
    exchange(spawn(app, "claude", &args, cwd)?, &[request], claude_applied).await
}

/// What the answer to Aime's `get_settings` says is applied; Some(None) for an
/// answer that carries none - an error, say - so the wait still ends.
fn claude_applied(message: &Value) -> Option<Option<RanOn>> {
    let response = message.get("response")?;
    let ours = message.get("type")?.as_str()? == "control_response"
        && response.get("request_id")?.as_str()? == CLAUDE_REQUEST_ID;
    ours.then(|| {
        response.pointer("/response/applied").map(|applied| RanOn {
            model: text_at(applied, "/model"),
            effort: text_at(applied, "/effort"),
        })
    })
}

// ---- Codex -------------------------------------------------------------------

async fn ask_codex(app: &AppHandle, chosen: Option<&str>, cwd: &str) -> Result<Option<RanOn>, String> {
    let requests = [
        json!({
            "jsonrpc": "2.0",
            "id": CODEX_INITIALIZE_ID,
            "method": "initialize",
            "params": { "clientInfo": { "name": "aime", "version": env!("CARGO_PKG_VERSION") } },
        }),
        json!({ "jsonrpc": "2.0", "method": "initialized" }),
        json!({ "jsonrpc": "2.0", "id": CODEX_MODEL_LIST_ID, "method": "model/list", "params": {} }),
        json!({ "jsonrpc": "2.0", "id": CODEX_CONFIG_READ_ID, "method": "config/read", "params": { "cwd": cwd } }),
    ];
    let mut models = None;
    let mut config = None;
    exchange(spawn(app, "codex", &["app-server"], cwd)?, &requests, |message| {
        // An error answers too: its missing result leaves that part unknown.
        let result = || message.get("result").cloned().unwrap_or(Value::Null);
        match message.get("id").and_then(Value::as_u64) {
            Some(CODEX_MODEL_LIST_ID) => models = Some(result()),
            Some(CODEX_CONFIG_READ_ID) => config = Some(result()),
            _ => return None,
        }
        Some(codex_next_run(models.as_ref()?, config.as_ref()?, chosen))
    })
    .await
}

/// The chosen model, else the configured one, else the catalog's default - at
/// the configured effort, else that model's own default.
fn codex_next_run(models: &Value, config: &Value, chosen: Option<&str>) -> Option<RanOn> {
    let listed = models
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let configured = |key: &str| text_at(config, &format!("/config/{key}"));
    let model = chosen
        .map(str::to_string)
        .or_else(|| configured("model"))
        .or_else(|| {
            listed
                .iter()
                .find(|entry| entry.get("isDefault").and_then(Value::as_bool) == Some(true))
                .and_then(|entry| text_at(entry, "/model"))
        })?;
    let default_effort = listed
        .iter()
        .find(|entry| entry.get("model").and_then(Value::as_str) == Some(model.as_str()))
        .and_then(|entry| text_at(entry, "/defaultReasoningEffort"));
    Some(RanOn {
        effort: configured("model_reasoning_effort").or(default_effort),
        model: Some(model),
    })
}

// ---- Shared ------------------------------------------------------------------

/// The provider's CLI in `cwd`, speaking JSON lines over stdin and stdout, with
/// the key Aime holds for it - a turn would run with the same.
fn spawn(app: &AppHandle, provider_id: &str, args: &[&str], cwd: &str) -> Result<Child, String> {
    let adapter = adapter_for(provider_id)?;
    let mut cmd = cli_command(adapter.command(), args);
    apply_api_key(&mut cmd, app, adapter.as_ref(), provider_id);
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("CLI_MISSING::{provider_id}::{e}"))
}

/// Writes `requests`, then reads answers until `answer` has what it needs.
///
/// Stdin stays open until then - closing it early, measured on Codex 0.146.0,
/// ends the server before its later answers are out. Dropping it afterwards
/// is what tells either CLI to exit, which also ends one started through a
/// batch shim, where `kill_on_drop` only reaches cmd.exe.
async fn exchange<T>(
    mut child: Child,
    requests: &[Value],
    mut answer: impl FnMut(&Value) -> Option<T>,
) -> Result<T, String> {
    let mut stdin = child.stdin.take().ok_or("the CLI's stdin was not captured")?;
    let stdout = child.stdout.take().ok_or("the CLI's stdout was not captured")?;
    for request in requests {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| format!("the question could not be sent: {e}"))?;
    }
    stdin
        .flush()
        .await
        .map_err(|e| format!("the question could not be sent: {e}"))?;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("the answer could not be read: {e}"))?
    {
        // Notices and events come and go on the same stream; only JSON is read.
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(found) = answer(&message) {
            return Ok(found);
        }
    }
    Err("the CLI exited without answering".into())
}

fn text_at(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer)?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Answers captured 2026-10-19 (Claude Code 2.1.303, Codex 0.146.0), with
    // the settings dump, the descriptions and the per-file origins cut out.
    const CLAUDE_ANSWER: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"aime-next-run","response":{"effective":{"effortLevel":"high"},"sources":[],"remote_control_policy_lock_reason":"Remote Control is disabled by your organization's policy. Contact your organization admin for access.","applied":{"model":"claude-haiku-5-5","effort":"medium","advisor":null,"ultracode":false,"ultracodeRequested":false,"ultracodeAvailable":true}}}}"#;

    const CODEX_MODELS: &str = r#"{"id":2,"result":{"data":[{"id":"gpt-5.6-terra","model":"gpt-5.6-terra","upgrade":null,"displayName":"GPT-5.6-Terra","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"medium","isDefault":true},{"id":"gpt-5.6-luna","model":"gpt-5.6-luna","upgrade":null,"displayName":"GPT-5.6-Luna","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"low","isDefault":false}],"nextCursor":null}}"#;

    const CODEX_CONFIG: &str = r#"{"id":3,"result":{"config":{"model":null,"model_reasoning_effort":null,"model_provider":null,"profile":null},"origins":{}}}"#;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("fixture is JSON")
    }

    fn ran_on(model: &str, effort: &str) -> Option<RanOn> {
        Some(RanOn {
            model: Some(model.into()),
            effort: Some(effort.into()),
        })
    }

    #[test]
    fn claude_says_what_it_applies_where_settings_say_otherwise() {
        assert_eq!(
            claude_applied(&json(CLAUDE_ANSWER)),
            Some(ran_on("claude-haiku-5-5", "medium"))
        );
    }

    #[test]
    fn claude_lines_that_answer_something_else_are_passed_over() {
        let other = CLAUDE_ANSWER.replace(CLAUDE_REQUEST_ID, "someone-else");
        assert_eq!(claude_applied(&json(&other)), None);
        assert_eq!(
            claude_applied(&json(r#"{"type":"system","subtype":"init"}"#)),
            None
        );
    }

    #[test]
    fn a_claude_error_ends_the_wait_without_an_answer() {
        let error = r#"{"type":"control_response","response":{"subtype":"error","request_id":"aime-next-run","error":"unknown"}}"#;
        assert_eq!(claude_applied(&json(error)), Some(None));
    }

    #[test]
    fn codex_runs_its_default_model_at_that_models_default_effort() {
        let models = json(CODEX_MODELS)["result"].clone();
        let config = json(CODEX_CONFIG)["result"].clone();
        assert_eq!(
            codex_next_run(&models, &config, None),
            ran_on("gpt-5.6-terra", "medium")
        );
        assert_eq!(
            codex_next_run(&models, &config, Some("gpt-5.6-luna")),
            ran_on("gpt-5.6-luna", "low")
        );
    }

    #[test]
    fn codex_config_overrides_the_catalog_defaults() {
        let models = json(CODEX_MODELS)["result"].clone();
        let config = json(r#"{"config":{"model":"gpt-5.6-luna","model_reasoning_effort":"high"}}"#);
        assert_eq!(
            codex_next_run(&models, &config, None),
            ran_on("gpt-5.6-luna", "high")
        );
        assert_eq!(
            codex_next_run(&models, &config, Some("gpt-5.6-terra")),
            ran_on("gpt-5.6-terra", "high")
        );
    }

    #[test]
    fn codex_with_nothing_to_go_on_says_nothing() {
        assert_eq!(codex_next_run(&Value::Null, &Value::Null, None), None);
        assert_eq!(
            codex_next_run(&Value::Null, &Value::Null, Some("gpt-5.6-terra")),
            Some(RanOn {
                model: Some("gpt-5.6-terra".into()),
                effort: None
            })
        );
    }
}
