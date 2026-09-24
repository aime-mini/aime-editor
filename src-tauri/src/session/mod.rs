//! Per-project stores under the app data directory: the AI chat sessions, and
//! the editor state a workspace is reopened with. The frontend owns both
//! schemas; this module is deliberately a dumb, atomic JSON file store keyed by
//! workspace path, one folder per kind so the two can never overwrite each other.

pub mod closing;

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// What a project's file holds, and so which folder it lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Store {
    /// The AI chat sessions of a project.
    AiSessions,
    /// The tabs, cursors and unsaved text a workspace was left with.
    Workspace,
}

impl Store {
    const fn folder(self) -> &'static str {
        match self {
            Self::AiSessions => "sessions",
            Self::Workspace => "workspaces",
        }
    }
}

/// Stable, filesystem-safe file name for a workspace: readable folder name + FNV-1a hash
/// (FNV is used because it is trivially stable across Rust versions, unlike DefaultHasher).
fn store_key(root_path: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let hash = root_path
        .bytes()
        .fold(FNV_OFFSET, |h, b| (h ^ u64::from(b)).wrapping_mul(FNV_PRIME));
    let name: String = root_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("workspace")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("{name}-{hash:016x}")
}

/// Where one project's file of one kind lives, under a given data directory.
fn store_path(data_dir: &Path, store: Store, root_path: &str) -> PathBuf {
    data_dir
        .join(store.folder())
        .join(format!("{}.json", store_key(root_path)))
}

fn store_file(app: &AppHandle, store: Store, root_path: &str) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(store_path(&data_dir, store, root_path))
}

/// The stored value, or `null` when the project has none yet.
fn load(file: &Path) -> Result<Value, String> {
    if !file.exists() {
        return Ok(Value::Null);
    }
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Writes via write-to-temp + rename, so a crash mid-write can never corrupt
/// the store: a reader sees the old file or the new one, never half of either.
fn save(file: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, file).map_err(|e| e.to_string())
}

/// Returns the stored sessions for a workspace, or `null` when none exist yet.
#[tauri::command]
pub fn load_ai_sessions(app: AppHandle, root_path: String) -> Result<Value, String> {
    load(&store_file(&app, Store::AiSessions, &root_path)?)
}

#[tauri::command]
pub fn save_ai_sessions(app: AppHandle, root_path: String, sessions: Value) -> Result<(), String> {
    save(&store_file(&app, Store::AiSessions, &root_path)?, &sessions)
}

/// Returns the editor state a workspace was left with, or `null` for one never opened.
#[tauri::command]
pub fn load_workspace_state(app: AppHandle, root_path: String) -> Result<Value, String> {
    load(&store_file(&app, Store::Workspace, &root_path)?)
}

#[tauri::command]
pub fn save_workspace_state(app: AppHandle, root_path: String, state: Value) -> Result<(), String> {
    save(&store_file(&app, Store::Workspace, &root_path)?, &state)
}

#[cfg(test)]
mod tests {
    use super::{load, save, store_key, store_path, Store};
    use serde_json::json;

    #[test]
    fn key_is_stable_and_filesystem_safe() {
        let key = store_key(r"C:\Projects\AI\AI-Mini-Editor");
        assert_eq!(
            key,
            store_key(r"C:\Projects\AI\AI-Mini-Editor"),
            "must be deterministic"
        );
        assert!(key.starts_with("ai-mini-editor-"));
        assert!(key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn different_roots_get_different_keys() {
        assert_ne!(store_key(r"C:\a\project"), store_key(r"C:\b\project"));
    }

    #[test]
    fn a_project_keeps_its_chat_and_its_editor_in_separate_files() {
        let data = std::path::Path::new("data");
        let root = r"C:\Projects\shop";
        let chat = store_path(data, Store::AiSessions, root);
        let editor = store_path(data, Store::Workspace, root);
        assert_ne!(chat, editor);
        // The chat file stays exactly where it always was: moving it would lose
        // every conversation written before this store had a second kind.
        assert_eq!(
            chat,
            data.join("sessions").join(format!("{}.json", store_key(root)))
        );
    }

    #[test]
    fn what_is_saved_is_what_comes_back_and_a_missing_file_is_null() {
        let dir = std::env::temp_dir().join(format!("aime-store-{}", std::process::id()));
        let file = store_path(&dir, Store::Workspace, r"C:\Projects\shop");
        assert_eq!(
            load(&file).expect("a missing file is not an error"),
            serde_json::Value::Null
        );

        let state = json!({ "version": 1, "tabs": ["C:/Projects/shop/a.ts"], "unsaved": { "x": "tên" } });
        save(&file, &state).expect("saved");
        assert_eq!(load(&file).expect("loaded"), state);
        assert!(
            !file.with_extension("json.tmp").exists(),
            "the temporary file outlived the rename"
        );
        std::fs::remove_dir_all(&dir).expect("cleaned up");
    }
}
