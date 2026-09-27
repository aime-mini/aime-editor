use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview};

use crate::fs_cmds::IGNORED_DIRS;

/// Coalesces change bursts (a git checkout, an AI edit run) into a single event.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Event delivered to the frontend: the deduplicated list of changed paths.
const CHANGED_EVENT: &str = "fs:changed";

/// One watcher per workspace, keyed by the workspace's webview label.
/// Inserting a new watcher for a label drops (and thereby stops) the old one.
#[derive(Default)]
pub struct WatcherState(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

/// Changes inside build artifacts and VCS internals are noise, not workspace edits.
fn is_relevant(path: &Path) -> bool {
    !path
        .components()
        .any(|c| IGNORED_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

/// Watches `path` recursively for the calling workspace and emits debounced
/// `fs:changed` events (with the affected paths) back to that workspace only.
/// Called again — e.g. when the user opens another folder — it replaces the
/// workspace's previous watcher.
#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let label = webview.label().to_string();
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
            if let Err(err) = app.emit_to(EventTarget::webview(emit_label.as_str()), CHANGED_EVENT, &paths) {
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

/// Event announcing that `providers.json` changed and has been re-read.
const PROVIDERS_EVENT: &str = "providers:changed";

/// The one file in the config folder worth reacting to.
const PROVIDERS_FILE: &str = "providers.json";

/// Watches Aime's own config folder for `providers.json`, re-reads it on every
/// change and tells the frontend to refresh its provider list.
///
/// Not recursive on purpose: the same folder holds the session store, which
/// Aime writes to constantly, and none of that is a provider change. The
/// watcher lives for the whole process, so it is deliberately leaked rather
/// than parked in a state object nothing would ever take it out of.
pub fn watch_providers_config(app: &AppHandle, config_dir: &Path) {
    if let Err(err) = std::fs::create_dir_all(config_dir) {
        eprintln!("[fs_watch] no config folder to watch: {err}");
        return;
    }
    let app = app.clone();
    let path = config_dir.join(PROVIDERS_FILE);

    let debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        if !events.iter().any(|event| event.path == path) {
            return;
        }
        crate::providers::generic::install(crate::providers::generic::load(&path));
        if let Err(err) = app.emit(PROVIDERS_EVENT, ()) {
            eprintln!("[fs_watch] failed to emit {PROVIDERS_EVENT}: {err}");
        }
    })
    .and_then(|mut debouncer| {
        debouncer
            .watcher()
            .watch(config_dir, RecursiveMode::NonRecursive)?;
        Ok(debouncer)
    });

    match debouncer {
        Ok(debouncer) => std::mem::forget(debouncer),
        Err(err) => eprintln!("[fs_watch] could not watch {PROVIDERS_FILE}: {err}"),
    }
}

/// Stops watching the calling workspace's folder (user closed the folder).
#[tauri::command]
pub fn unwatch_workspace(webview: Webview, state: State<'_, WatcherState>) -> Result<(), String> {
    let mut watchers = state
        .0
        .lock()
        .map_err(|_| "watcher state lock poisoned".to_string())?;
    watchers.remove(webview.label());
    Ok(())
}

/// Stops the watcher a workspace owns; called when that workspace closes.
pub fn drop_watcher_for(app: &AppHandle, workspace: &str) {
    let state = app.state::<WatcherState>();
    let mut watchers = match state.0.lock() {
        Ok(guard) => guard,
        // A poisoned lock still holds valid data — recover it so the watcher is freed.
        Err(poisoned) => poisoned.into_inner(),
    };
    watchers.remove(workspace);
}
