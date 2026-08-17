//! Where a provider's API key lives.
//!
//! One JSON file in Aime's own config folder, `provider id -> key`. Plaintext
//! by deliberate choice: the CLIs this key is handed to keep their own
//! credentials the same way (`~/.claude/.credentials.json`, `~/.codex/auth.json`),
//! so an OS keyring here would guard one copy of a secret whose other copy sits
//! in a file anyway — while adding a native dependency the rest of the app does
//! not carry. On Unix the file is made owner-only, which is what the CLIs do too.
//!
//! The contract with the frontend is write-only: a key goes in through
//! `provider_set_api_key` and the UI may ask *whether* one exists
//! (`ProviderHealth::api_key`), never what it is.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "api-keys.json";

fn keys_path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

/// Every stored key. A missing file is the normal first-run state; a malformed
/// one is reported and treated as empty rather than blocking every AI feature
/// behind a parse error (the same contract as `generic::load`).
fn read_all(config_dir: &Path) -> BTreeMap<String, String> {
    let path = keys_path(config_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    match serde_json::from_str(&text) {
        Ok(keys) => keys,
        Err(err) => {
            eprintln!(
                "[providers] {} is not valid JSON ({err}); ignoring it",
                path.display()
            );
            BTreeMap::new()
        }
    }
}

/// The key configured for one provider, when there is one.
pub fn api_key(config_dir: &Path, provider_id: &str) -> Option<String> {
    read_all(config_dir).remove(provider_id)
}

/// Stores a provider's key; an empty (or whitespace) key removes the entry.
pub fn set_api_key(config_dir: &Path, provider_id: &str, key: &str) -> Result<(), String> {
    let mut keys = read_all(config_dir);
    let trimmed = key.trim();
    if trimmed.is_empty() {
        keys.remove(provider_id);
    } else {
        keys.insert(provider_id.to_string(), trimmed.to_string());
    }

    std::fs::create_dir_all(config_dir).map_err(|e| format!("Could not create the config folder: {e}"))?;
    let path = keys_path(config_dir);
    let json = serde_json::to_string_pretty(&keys).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    restrict_to_owner(&path)
}

/// Owner-only permissions where the OS expresses them per file. On Windows the
/// file inherits the user profile's ACL, which is already not world-readable.
#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Could not restrict {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aime-keys-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_key_round_trips_and_an_empty_key_removes_it() {
        let dir = scratch("roundtrip");
        assert_eq!(api_key(&dir, "claude"), None, "a missing file means no key");

        set_api_key(&dir, "claude", "  sk-ant-test  ").expect("store");
        assert_eq!(
            api_key(&dir, "claude"),
            Some("sk-ant-test".into()),
            "stored trimmed"
        );
        assert_eq!(api_key(&dir, "codex"), None, "keys are per provider");

        set_api_key(&dir, "claude", "   ").expect("clear");
        assert_eq!(api_key(&dir, "claude"), None, "an empty key clears the entry");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_provider_does_not_disturb_the_first() {
        let dir = scratch("two");
        set_api_key(&dir, "claude", "one").expect("store claude");
        set_api_key(&dir, "gemini", "two").expect("store gemini");
        assert_eq!(api_key(&dir, "claude"), Some("one".into()));
        assert_eq!(api_key(&dir, "gemini"), Some("two".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_and_is_recoverable() {
        let dir = scratch("corrupt");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(keys_path(&dir), "not json").expect("corrupt it");
        assert_eq!(
            api_key(&dir, "claude"),
            None,
            "corruption must not panic or block"
        );

        set_api_key(&dir, "claude", "sk-new").expect("writing over corruption");
        assert_eq!(api_key(&dir, "claude"), Some("sk-new".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
