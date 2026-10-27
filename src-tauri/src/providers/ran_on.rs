//! Which model and reasoning effort a turn actually ran on, read from the
//! CLI's own record of the session.
//!
//! "Auto" leaves both to the CLI, and then the picker could only say "Auto" -
//! the one thing a person looking at it wants to know is exactly what it
//! hides. Neither CLI says it in its event stream in
//! full, but each writes it down beside the session, so it is read there:
//!
//! - **Claude Code** keeps every session as `projects/<folder>/<session>.jsonl`
//!   in its config folder. Measured on 2.1.302: each `assistant` entry carries
//!   `message.model` and the `effort` the request went out with - `medium`
//!   for Haiku although `effortLevel` in settings said `high`, which is why
//!   the settings are no answer.
//! - **Codex** keeps `sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl` in its
//!   home. Measured on 0.146.0: each `turn_context` carries `model` and
//!   `collaboration_mode.settings.reasoning_effort`, null when none was asked
//!   for - the model's `default_reasoning_level` in the catalog is what ran then.
//!
//! A configured CLI keeps no such record anywhere Aime could know of.

use super::catalog::{codex_home, CODEX_CACHE};
use crate::home::home_dir;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// How much of the end of a session file is read: the newest entries are
/// there, and a long session's file runs to megabytes.
const TAIL_BYTES: u64 = 512 * 1024;

/// What a turn ran on; either part is absent when the record does not say.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RanOn {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// The model and effort the session's last turn ran on, or None when the
/// provider keeps no record of it or the session has none yet.
#[tauri::command]
pub async fn provider_ran_on(provider_id: String, session_id: String) -> Result<Option<RanOn>, String> {
    let read: fn(&str) -> io::Result<Option<RanOn>> = match provider_id.as_str() {
        "claude" => claude_ran_on,
        "codex" => codex_ran_on,
        _ => return Ok(None),
    };
    if !is_session_id(&session_id) {
        return Err(format!("not a session id: {session_id}"));
    }
    tauri::async_runtime::spawn_blocking(move || read(&session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Ids are joined into a path, so only the characters of a UUID are let in.
fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// ---- Claude Code -------------------------------------------------------------

fn claude_ran_on(session_id: &str) -> io::Result<Option<RanOn>> {
    let Some(file) = claude_session_file(&claude_projects_dir(), session_id)? else {
        return Ok(None);
    };
    Ok(last_matching(&read_tail(&file)?, claude_entry))
}

/// `projects` in the folder Claude Code is told to use, or in `~/.claude`.
fn claude_projects_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".claude")))
        .unwrap_or_default()
        .join("projects")
}

/// The session's file, in whichever project folder holds it - the folder name
/// is Claude Code's own spelling of the working directory, so it is found
/// rather than rebuilt.
fn claude_session_file(projects: &Path, session_id: &str) -> io::Result<Option<PathBuf>> {
    if !projects.is_dir() {
        return Ok(None);
    }
    let name = format!("{session_id}.jsonl");
    for entry in fs::read_dir(projects)? {
        let candidate = entry?.path().join(&name);
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn claude_entry(entry: &Value) -> Option<RanOn> {
    if entry.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let model = entry.pointer("/message/model")?.as_str()?;
    Some(RanOn {
        model: Some(model.to_string()),
        effort: text_at(entry, "/effort"),
    })
}

// ---- Codex -------------------------------------------------------------------

#[derive(Deserialize)]
struct Catalog {
    models: Vec<CatalogModel>,
}

#[derive(Deserialize)]
struct CatalogModel {
    slug: String,
    #[serde(default)]
    default_reasoning_level: Option<String>,
}

fn codex_ran_on(thread_id: &str) -> io::Result<Option<RanOn>> {
    let home = codex_home();
    let Some(file) = codex_rollout(&home.join("sessions"), thread_id)? else {
        return Ok(None);
    };
    let Some(mut ran_on) = last_matching(&read_tail(&file)?, codex_entry) else {
        return Ok(None);
    };
    if ran_on.effort.is_none() {
        ran_on.effort = ran_on
            .model
            .as_deref()
            .and_then(|model| default_effort(&home.join(CODEX_CACHE), model));
    }
    Ok(Some(ran_on))
}

/// The thread's rollout, searched newest day first: the session that just ran
/// is today's, and the folder holds every session ever kept.
fn codex_rollout(sessions: &Path, thread_id: &str) -> io::Result<Option<PathBuf>> {
    let suffix = format!("-{thread_id}.jsonl");
    for year in newest_first(sessions)? {
        for month in newest_first(&year)? {
            for day in newest_first(&month)? {
                for entry in fs::read_dir(&day)? {
                    let path = entry?.path();
                    if path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.ends_with(&suffix))
                    {
                        return Ok(Some(path));
                    }
                }
            }
        }
    }
    Ok(None)
}

/// The folders inside `dir`, by name from the highest down; none when it is not there.
fn newest_first(dir: &Path) -> io::Result<Vec<PathBuf>> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut folders = fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    folders.retain(|path| path.is_dir());
    folders.sort_unstable_by(|a, b| b.file_name().cmp(&a.file_name()));
    Ok(folders)
}

fn codex_entry(entry: &Value) -> Option<RanOn> {
    if entry.get("type")?.as_str()? != "turn_context" {
        return None;
    }
    Some(RanOn {
        model: text_at(entry, "/payload/model"),
        effort: text_at(entry, "/payload/collaboration_mode/settings/reasoning_effort"),
    })
}

/// What the catalog says the model reasons at when nobody asked for a level.
fn default_effort(catalog: &Path, model: &str) -> Option<String> {
    let text = fs::read_to_string(catalog).ok()?;
    let catalog: Catalog = serde_json::from_str(&text).ok()?;
    catalog
        .models
        .into_iter()
        .find(|candidate| candidate.slug == model)?
        .default_reasoning_level
}

// ---- Shared ------------------------------------------------------------------

/// The end of a file, from the first whole line inside the last `TAIL_BYTES`.
fn read_tail(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return Ok(text);
    }
    // The cut almost always lands inside a line; that line is not JSON.
    Ok(text
        .split_once('\n')
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_default())
}

/// The newest line of `jsonl` that `read` makes something of.
fn last_matching(jsonl: &str, read: impl Fn(&Value) -> Option<RanOn>) -> Option<RanOn> {
    jsonl
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|entry| read(&entry))
}

fn text_at(entry: &Value, pointer: &str) -> Option<String> {
    entry.pointer(pointer)?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own under the system's temp folder, gone when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("aime-ran-on-{name}-{}", std::process::id()));
            fs::create_dir_all(&path).expect("scratch folder");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            // A folder left behind is litter, not a failure of the test.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // Entries trimmed from real session files (Claude Code 2.1.302, Codex 0.146.0):
    // only the fields read here, and the ones around them.
    const CLAUDE_SESSION: &str = r#"{"type":"user","message":{"role":"user","content":"Run it"},"sessionId":"809a1fcd"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[]},"requestedModel":"claude-haiku-5-5","advisorModel":"claude-opus-5-5","effort":"medium","perTurnEffort":"medium"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"hi"}]}}"#;

    const CODEX_ROLLOUT: &str = r#"{"timestamp":"2026-10-18T05:59:13.576Z","type":"session_meta","payload":{"session_id":"01a14d97-bebd-7371-a456-458d558d8ec2","cli_version":"0.146.0"}}
{"type":"turn_context","payload":{"turn_id":"01a14d97-c12a","model":"gpt-5.6-terra","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-terra","reasoning_effort":null,"developer_instructions":null}},"summary":"auto"}}
{"type":"event_msg","payload":{"type":"task_complete"}}"#;

    #[test]
    fn claude_says_the_model_and_effort_of_its_last_answer() {
        assert_eq!(
            last_matching(CLAUDE_SESSION, claude_entry),
            Some(RanOn {
                model: Some("claude-haiku-5-5".into()),
                effort: Some("medium".into())
            })
        );
    }

    #[test]
    fn codex_names_the_model_and_leaves_an_unasked_effort_to_the_catalog() {
        assert_eq!(
            last_matching(CODEX_ROLLOUT, codex_entry),
            Some(RanOn {
                model: Some("gpt-5.6-terra".into()),
                effort: None
            })
        );
    }

    #[test]
    fn the_catalog_supplies_the_default_effort_of_a_model() {
        let dir = Scratch::new("catalog");
        let catalog = dir.path().join(CODEX_CACHE);
        fs::write(
            &catalog,
            r#"{"models":[{"slug":"gpt-5.6-terra","default_reasoning_level":"medium"},{"slug":"other"}]}"#,
        )
        .expect("write catalog");
        assert_eq!(default_effort(&catalog, "gpt-5.6-terra"), Some("medium".into()));
        assert_eq!(default_effort(&catalog, "other"), None);
        assert_eq!(default_effort(&catalog, "missing"), None);
    }

    #[test]
    fn a_rollout_is_found_by_its_thread_whatever_day_it_was_written() {
        let dir = Scratch::new("rollout");
        let thread = "01a14d97-bebd-7371-a456-458d558d8ec2";
        let old = dir.path().join("2026/09/30");
        let new = dir.path().join("2026/10/18");
        fs::create_dir_all(&old).expect("old day");
        fs::create_dir_all(&new).expect("new day");
        fs::write(old.join("rollout-2026-09-30T10-00-00-other.jsonl"), "").expect("other rollout");
        let wanted = old.join(format!("rollout-2026-09-30T10-00-00-{thread}.jsonl"));
        fs::write(&wanted, CODEX_ROLLOUT).expect("rollout");
        assert_eq!(codex_rollout(dir.path(), thread).expect("search"), Some(wanted));
        assert_eq!(codex_rollout(dir.path(), "ffff").expect("search"), None);
    }

    #[test]
    fn a_claude_session_is_found_in_whichever_project_folder_holds_it() {
        let dir = Scratch::new("claude");
        let project = dir.path().join("C--work-shop");
        fs::create_dir_all(&project).expect("project folder");
        fs::create_dir_all(dir.path().join("C--work-other")).expect("other folder");
        let wanted = project.join("809a1fcd-c30f.jsonl");
        fs::write(&wanted, CLAUDE_SESSION).expect("session");
        assert_eq!(
            claude_session_file(dir.path(), "809a1fcd-c30f").expect("search"),
            Some(wanted)
        );
        assert_eq!(
            claude_session_file(&dir.path().join("absent"), "809a1fcd-c30f").expect("search"),
            None
        );
    }

    #[test]
    fn the_tail_of_a_long_file_starts_at_a_whole_line() {
        let dir = Scratch::new("tail");
        let file = dir.path().join("long.jsonl");
        let filler = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(1_000));
        let mut text = filler.repeat(600);
        text.push_str(CLAUDE_SESSION);
        fs::write(&file, &text).expect("long file");
        let tail = read_tail(&file).expect("tail");
        assert!(tail.len() as u64 <= TAIL_BYTES);
        assert!(tail
            .lines()
            .all(|line| serde_json::from_str::<Value>(line).is_ok()));
        assert!(last_matching(&tail, claude_entry).is_some());
    }

    #[test]
    fn only_the_characters_of_a_uuid_make_a_session_id() {
        assert!(is_session_id("809a1fcd-c30f-4c49-a014-756d653abc21"));
        assert!(!is_session_id(""));
        assert!(!is_session_id("../../secrets"));
        assert!(!is_session_id("abc/def"));
    }
}
