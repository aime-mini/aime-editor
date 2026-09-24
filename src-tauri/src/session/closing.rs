//! Closing an editor window without losing what it was holding.
//!
//! A workspace's tabs and unsaved text live in the webview, which writes them
//! to disk a moment after they change. A window closed inside that moment -
//! Alt+F4 straight after typing - would take the last keystrokes with it. So a
//! close request is held while the window is asked to write what it has, for
//! at most `FLUSH_TIMEOUT`, and the window is then destroyed whatever the
//! answer. The page never decides whether its window closes: one that is
//! frozen still closes, only without the last write.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{Emitter, Manager, State, Window};
use tokio::sync::oneshot;

/// Sent to a window whose close is being held; it answers with `window_flushed`.
const CLOSING_EVENT: &str = "window:closing";

/// How long a close waits for the window to write. Measured writes take tens
/// of milliseconds; this only bounds a page that never answers.
const FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

/// Windows whose close is being held, each with the way to let it go early.
/// `None` once the window has answered and is on its way out.
#[derive(Default)]
pub struct ClosingWindows(Mutex<HashMap<String, Option<oneshot::Sender<()>>>>);

impl ClosingWindows {
    /// A poisoned lock still holds valid data - recover it instead of panicking.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Option<oneshot::Sender<()>>>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The windows that hold a workspace - the same set `capabilities/default.json`
/// grants the editor to. The greeting closes itself and has nothing to write.
fn holds_a_workspace(label: &str) -> bool {
    label == "main" || label.starts_with("editor-")
}

/// Handles a close request: held while the window writes, then destroyed.
pub fn hold_close(window: &Window, api: &tauri::CloseRequestApi) {
    let label = window.label().to_string();
    if !holds_a_workspace(&label) {
        return;
    }
    api.prevent_close();
    let state = window.state::<ClosingWindows>();
    let (answer, answered) = oneshot::channel();
    {
        let mut closing = state.lock();
        if closing.contains_key(&label) {
            return; // a second click on X while the first is still being held
        }
        closing.insert(label.clone(), Some(answer));
    }

    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        // A page that cannot be told simply runs out the clock.
        if let Err(err) = window.emit_to(label.as_str(), CLOSING_EVENT, ()) {
            eprintln!("could not ask {label} to write before closing: {err}");
        }
        let _ = tokio::time::timeout(FLUSH_TIMEOUT, answered).await;
        window.state::<ClosingWindows>().lock().remove(&label);
        // `destroy`, not `close`: a close would come straight back here.
        if let Err(err) = window.destroy() {
            eprintln!("could not close {label}: {err}");
        }
    });
}

/// The window has written what it holds; its close may go ahead.
#[tauri::command]
pub fn window_flushed(window: Window, state: State<'_, ClosingWindows>) {
    if let Some(answer) = state.lock().get_mut(window.label()).and_then(Option::take) {
        let _ = answer.send(()); // the wait may have timed out already
    }
}

#[cfg(test)]
mod tests {
    use super::holds_a_workspace;

    #[test]
    fn only_editor_windows_are_held() {
        assert!(holds_a_workspace("main"));
        assert!(holds_a_workspace("editor-3"));
        // The greeting closes itself the moment the editor is ready, and a
        // second and a half of it lingering would be the greeting outstaying it.
        assert!(!holds_a_workspace("splash"));
    }
}
