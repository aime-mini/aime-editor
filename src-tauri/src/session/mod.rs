//! Per-project AI chat session store. The frontend owns the session schema;
//! this module is deliberately a dumb, atomic JSON file store keyed by
//! workspace path under the app data directory.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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

fn sessions_file(app: &AppHandle, root_path: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sessions");
    Ok(dir.join(format!("{}.json", store_key(root_path))))
}

/// Returns the stored sessions for a workspace, or `null` when none exist yet.
#[tauri::command]
pub fn load_ai_sessions(app: AppHandle, root_path: String) -> Result<Value, String> {
    let file = sessions_file(&app, &root_path)?;
    if !file.exists() {
        return Ok(Value::Null);
    }
    let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Persists the sessions of a workspace via write-to-temp + rename, so a
/// crash mid-write can never corrupt the store.
#[tauri::command]
pub fn save_ai_sessions(app: AppHandle, root_path: String, sessions: Value) -> Result<(), String> {
    let file = sessions_file(&app, &root_path)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&sessions).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::store_key;

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
}
