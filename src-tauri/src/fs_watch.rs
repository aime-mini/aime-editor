use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::fs_cmds::IGNORED_DIRS;

/// Coalesces change bursts (a git checkout, an AI edit run) into a single event.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Event delivered to the frontend: the deduplicated list of changed paths.
const CHANGED_EVENT: &str = "fs:changed";

/// One workspace watcher per window, keyed by window label.
/// Inserting a new watcher for a label drops (and thereby stops) the old one.
#[derive(Default)]
pub struct WatcherState(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

/// Changes inside build artifacts and VCS internals are noise, not workspace edits.
fn is_relevant(path: &Path) -> bool {
    !path
        .components()
        .any(|c| IGNORED_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

/// Watches `path` recursively for the calling window and emits debounced
/// `fs:changed` events (with the affected paths) back to that window only.
/// Called again — e.g. when the user opens another folder — it replaces the
/// window's previous watcher.
#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    window: Window,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let emit_label = label.clone();

    let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| match result {
        Ok(events) => {
            let changed: BTreeSet<String> = events
                .iter()
                .filter(|event| is_relevant(&event.path))
                .map(|event| event.path.to_string_lossy().to_string())
                .collect();
            if changed.is_empty() {
                return;
            }
            let paths: Vec<String> = changed.into_iter().collect();
            if let Err(err) = app.emit_to(&emit_label, CHANGED_EVENT, &paths) {
                eprintln!("[fs_watch] failed to emit {CHANGED_EVENT} to '{emit_label}': {err}");
            }
        }
        Err(err) => eprintln!("[fs_watch] watcher error: {err}"),
    })
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    state
        .0
        .lock()
        .map_err(|_| "watcher state lock poisoned".to_string())?
        .insert(label, debouncer);
    Ok(())
}

/// Stops watching the calling window's workspace (user closed the folder).
#[tauri::command]
pub fn unwatch_workspace(window: Window, state: State<'_, WatcherState>) -> Result<(), String> {
    let mut watchers = state
        .0
        .lock()
        .map_err(|_| "watcher state lock poisoned".to_string())?;
    watchers.remove(window.label());
    Ok(())
}

/// Stops the watcher owned by a window; called when that window is destroyed.
pub fn drop_watcher_for(window: &Window) {
    let state = window.state::<WatcherState>();
    let mut watchers = match state.0.lock() {
        Ok(guard) => guard,
        // A poisoned lock still holds valid data — recover it so the watcher is freed.
        Err(poisoned) => poisoned.into_inner(),
    };
    watchers.remove(window.label());
}
