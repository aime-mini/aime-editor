//! Closing a workspace - a tab, or a window of them - without losing what it
//! was holding.
//!
//! A workspace's tabs and unsaved text live in its webview, which writes them
//! to disk a moment after they change. A workspace closed inside that moment -
//! Alt+F4 straight after typing - would take the last keystrokes with it. So a
//! close is held while each workspace going is asked to write what it has, for
//! at most `FLUSH_TIMEOUT`, and then goes whatever the answer. The page never
//! decides whether it closes: one that is frozen still closes, only without
//! the last write.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview, Window};
use tokio::sync::oneshot;

use crate::workspaces::{self, Workspaces};

/// Sent to a workspace about to close; it answers with `window_flushed`.
const CLOSING_EVENT: &str = "window:closing";

/// How long a close waits for a workspace to write. Measured writes take tens
/// of milliseconds; this only bounds a page that never answers.
const FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

/// Workspaces whose close is being held, each with the way to let it go early.
/// `None` once the workspace has answered and is on its way out.
#[derive(Default)]
pub struct ClosingWindows(Mutex<HashMap<String, Option<oneshot::Sender<()>>>>);

impl ClosingWindows {
    /// A poisoned lock still holds valid data - recover it instead of panicking.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Option<oneshot::Sender<()>>>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Asks each of `labels` to write what it holds and waits for all of them,
/// together, for at most `FLUSH_TIMEOUT`. A workspace already being closed is
/// left to the close that holds it.
async fn flush(app: &AppHandle, labels: &[String]) {
    let mut held = Vec::new();
    let mut answers = Vec::new();
    {
        let state = app.state::<ClosingWindows>();
        let mut closing = state.lock();
        for label in labels {
            if closing.contains_key(label) {
                continue;
            }
            let (answer, answered) = oneshot::channel();
            closing.insert(label.clone(), Some(answer));
            held.push(label.clone());
            answers.push(answered);
        }
    }
    for label in &held {
        // A page that cannot be told simply runs out the clock.
        if let Err(err) = app.emit_to(EventTarget::webview(label.as_str()), CLOSING_EVENT, ()) {
            eprintln!("could not ask {label} to write before closing: {err}");
        }
    }
    let all = async {
        for answered in answers {
            let _ = answered.await; // a dropped sender is an answer too
        }
    };
    let _ = tokio::time::timeout(FLUSH_TIMEOUT, all).await;
    let state = app.state::<ClosingWindows>();
    let mut closing = state.lock();
    for label in &held {
        closing.remove(label);
    }
}

/// Closes one workspace - a tab - once it has written what it holds.
pub async fn close_workspace(app: &AppHandle, label: &str) -> Result<(), String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| format!("no workspace {label}"))?;
    flush(app, &[label.to_string()]).await;
    webview.close().map_err(|e| e.to_string())
}

/// Handles a window's close request: held while every workspace in it
/// writes, then destroyed.
pub fn hold_close(window: &Window, api: &tauri::CloseRequestApi) {
    if !workspaces::holds_workspaces(window.label()) {
        return; // the greeting closes itself and has nothing to write
    }
    api.prevent_close();
    let labels = window.state::<Workspaces>().in_window(window.label());
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        flush(window.app_handle(), &labels).await;
        // `destroy`, not `close`: a close would come straight back here.
        if let Err(err) = window.destroy() {
            eprintln!("could not close {}: {err}", window.label());
        }
    });
}

/// The calling workspace has written what it holds; its close may go ahead.
#[tauri::command]
pub fn window_flushed(webview: Webview, state: State<'_, ClosingWindows>) {
    if let Some(answer) = state.lock().get_mut(webview.label()).and_then(Option::take) {
        let _ = answer.send(()); // the wait may have timed out already
    }
}
