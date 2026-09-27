//! A folder of its own for each running session of an adapter that locks one.
//!
//! Some adapters keep a workspace on disk and take a lock on it: java-debug
//! lives inside Eclipse JDT LS, whose `-data` folder admits one process at a
//! time, so a second Java session started while the first runs fails on the
//! lock (measured 2026-08, recorded in STATUS). An entry that names
//! `{sessionDir}` in its arguments gets, per session, a folder no other running
//! session of the same adapter holds. The folders are kept between sessions
//! and handed out lowest first, so one session at a time - the common case -
//! always finds the same folder, index and all, warm.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Manager};

/// What an entry writes in its arguments to be given a folder of its own.
pub const PLACEHOLDER: &str = "{sessionDir}";

/// Under the app's data folder, one folder per adapter, one per slot in it.
const SESSIONS_FOLDER: &str = "debug-sessions";

/// The slots each adapter's running sessions hold.
#[derive(Default)]
pub struct SessionSlots(Mutex<HashMap<String, HashSet<usize>>>);

/// A slot held for one session; given back with `release`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldSlot {
    adapter: String,
    slot: usize,
}

impl SessionSlots {
    fn held(&self) -> MutexGuard<'_, HashMap<String, HashSet<usize>>> {
        // The data is a plain map of numbers, valid whatever panicked holding it.
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Takes the lowest slot no running session of `adapter` holds.
    pub fn take(&self, adapter: &str) -> HeldSlot {
        let mut held = self.held();
        let taken = held.entry(adapter.to_string()).or_default();
        let slot = lowest_free(taken);
        taken.insert(slot);
        HeldSlot {
            adapter: adapter.to_string(),
            slot,
        }
    }

    /// Gives a slot back once its session has ended.
    pub fn release(&self, held: &HeldSlot) {
        if let Some(taken) = self.held().get_mut(&held.adapter) {
            taken.remove(&held.slot);
        }
    }
}

fn lowest_free(taken: &HashSet<usize>) -> usize {
    (0..).find(|slot| !taken.contains(slot)).unwrap_or_default()
}

/// Whether an adapter's arguments ask for a folder of their own.
pub fn wanted(args: &[String]) -> bool {
    args.iter().any(|arg| arg.contains(PLACEHOLDER))
}

/// The folder a held slot stands for, made if it is not there yet.
pub fn folder_for(app: &AppHandle, held: &HeldSlot) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data folder for debug sessions: {e}"))?;
    let folder = base
        .join(SESSIONS_FOLDER)
        .join(safe_name(&held.adapter))
        .join(held.slot.to_string());
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not make {}: {e}", folder.display()))?;
    Ok(folder)
}

/// `args` with every `{sessionDir}` spelled as `folder`.
pub fn fill(args: &[String], folder: &Path) -> Vec<String> {
    let spelled = folder.to_string_lossy();
    args.iter()
        .map(|arg| arg.replace(PLACEHOLDER, &spelled))
        .collect()
}

/// An adapter id as a folder name: the id is the entry's own text, and a
/// slash or a colon in it must not become a path of its own.
fn safe_name(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_alone_always_gets_the_first_folder_back() {
        let slots = SessionSlots::default();
        let first = slots.take("java-debug");
        slots.release(&first);
        assert_eq!(slots.take("java-debug"), first);
    }

    #[test]
    fn two_sessions_at_once_never_share_a_folder_and_other_adapters_do_not_count() {
        let slots = SessionSlots::default();
        let one = slots.take("java-debug");
        let two = slots.take("java-debug");
        assert_ne!(one, two);
        assert_eq!(slots.take("kotlin-debug").slot, 0);
        slots.release(&one);
        assert_eq!(
            slots.take("java-debug").slot,
            0,
            "the lowest free slot comes back first"
        );
    }

    #[test]
    fn only_the_placeholder_is_replaced() {
        let args = vec![
            "-data".to_string(),
            "{sessionDir}".to_string(),
            "-Xmx1G".to_string(),
        ];
        assert!(wanted(&args));
        assert!(!wanted(&args[2..]));
        let folder = Path::new("sessions").join("0");
        assert_eq!(
            fill(&args, &folder),
            ["-data", &folder.to_string_lossy(), "-Xmx1G"]
        );
    }

    #[test]
    fn an_adapter_id_never_becomes_a_path() {
        assert_eq!(safe_name("my/adapter:v2"), "my_adapter_v2");
    }
}
