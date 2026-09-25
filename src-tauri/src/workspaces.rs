//! Several workspaces in one window, as tabs.
//!
//! Every workspace is a window of its own - its own webview, its own stores,
//! and every process it started keyed by its label (terminals, language
//! servers, debug adapters, the file watcher) - exactly as a second window
//! always was. What makes them tabs is that the windows of one group share one
//! place on screen: switching tabs shows the chosen window where the current
//! one stands, at its size, and hides the current one. A hidden workspace keeps
//! running; nothing it started is stopped by switching away from it.
//!
//! A group is what the person sees as one window. `Ctrl+Shift+N` still opens a
//! window of a group of its own, and a tab can be taken out into one.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};

use crate::window_cmds::{self, IDEAL_RESTORE};

/// Told to every window when a group gains, loses or renames a tab.
const CHANGED_EVENT: &str = "workspaces:changed";

static GROUP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// One workspace window and what it has open.
struct Member {
    group: u64,
    folder: Option<String>,
}

#[derive(Default)]
struct Registry {
    members: HashMap<String, Member>,
    /// The window each group is showing right now.
    shown: HashMap<u64, String>,
    /// Folders a new workspace window opens with, until its page asks for it.
    pending: HashMap<String, String>,
    /// The order tabs were opened in, which is the order they are drawn in.
    order: Vec<String>,
}

#[derive(Default)]
pub struct Workspaces(Mutex<Registry>);

/// One tab as the strip draws it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    label: String,
    folder: Option<String>,
}

/// The tabs of the calling window's group, and which of them is on screen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tabs {
    tabs: Vec<Tab>,
    active: String,
}

impl Workspaces {
    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        // A panic while holding the lock leaves the registry as it was; the
        // data is plain maps and stays usable.
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The folder a freshly built workspace window was opened with, taken once.
    pub fn take_pending(&self, label: &str) -> Option<String> {
        self.lock().pending.remove(label)
    }
}

impl Registry {
    /// The group a window belongs to, making it the only tab of a new group
    /// the first time it is seen - the first window, and every window opened
    /// with `Ctrl+Shift+N`.
    fn group_of(&mut self, label: &str) -> u64 {
        if let Some(member) = self.members.get(label) {
            return member.group;
        }
        let group = GROUP_COUNTER.fetch_add(1, Ordering::Relaxed);
        self.join(label, group, None);
        self.shown.insert(group, label.to_string());
        group
    }

    fn join(&mut self, label: &str, group: u64, folder: Option<String>) {
        self.members.insert(label.to_string(), Member { group, folder });
        if !self.order.iter().any(|known| known == label) {
            self.order.push(label.to_string());
        }
    }

    fn tabs_of(&self, group: u64) -> Vec<Tab> {
        self.order
            .iter()
            .filter_map(|label| {
                let member = self.members.get(label)?;
                (member.group == group).then(|| Tab {
                    label: label.clone(),
                    folder: member.folder.clone(),
                })
            })
            .collect()
    }

    /// Forgets a window, and answers the tabs of its group that were hidden
    /// behind it when it was the one on screen - they close with it.
    fn forget(&mut self, label: &str) -> Vec<String> {
        let Some(member) = self.members.remove(label) else {
            return Vec::new();
        };
        self.order.retain(|known| known != label);
        self.pending.remove(label);
        if self.shown.get(&member.group).map(String::as_str) != Some(label) {
            return Vec::new();
        }
        self.shown.remove(&member.group);
        self.tabs_of(member.group)
            .into_iter()
            .map(|tab| tab.label)
            .collect()
    }
}

fn changed(app: &AppHandle) {
    if let Err(err) = app.emit(CHANGED_EVENT, ()) {
        eprintln!("[workspaces] could not announce a change: {err}");
    }
}

fn workspace_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("no workspace window {label}"))
}

/// Says what the calling window has open, so its tab can be named.
#[tauri::command]
pub fn workspace_register(
    app: AppHandle,
    window: Window,
    state: State<'_, Workspaces>,
    folder: Option<String>,
) {
    {
        let mut registry = state.lock();
        registry.group_of(window.label());
        if let Some(member) = registry.members.get_mut(window.label()) {
            member.folder = folder;
        }
    }
    changed(&app);
}

/// The tabs the calling window draws.
#[tauri::command]
pub fn workspace_tabs(window: Window, state: State<'_, Workspaces>) -> Tabs {
    let mut registry = state.lock();
    let group = registry.group_of(window.label());
    let active = registry
        .shown
        .get(&group)
        .cloned()
        .unwrap_or_else(|| window.label().to_string());
    Tabs {
        tabs: registry.tabs_of(group),
        active,
    }
}

/// Opens a workspace as a new tab of the calling window's group and shows it.
///
/// A folder already open in the group is switched to rather than opened twice;
/// no folder opens the tab on the welcome screen.
#[tauri::command]
pub async fn workspace_open(
    app: AppHandle,
    window: Window,
    state: State<'_, Workspaces>,
    folder: Option<String>,
) -> Result<(), String> {
    let (group, existing) = {
        let mut registry = state.lock();
        let group = registry.group_of(window.label());
        let existing = folder.as_ref().and_then(|wanted| {
            registry
                .tabs_of(group)
                .into_iter()
                .find(|tab| tab.folder.as_ref() == Some(wanted))
                .map(|tab| tab.label)
        });
        (group, existing)
    };
    if let Some(label) = existing {
        return show_tab(&app, &state, group, &label);
    }
    let label = window_cmds::next_label();
    {
        let mut registry = state.lock();
        registry.join(&label, group, folder.clone());
        if let Some(folder) = folder {
            registry.pending.insert(label.clone(), folder);
        }
    }
    build_hidden(&app, &label)?;
    show_tab(&app, &state, group, &label)?;
    changed(&app);
    Ok(())
}

/// Shows another tab of the calling window's group in its place.
#[tauri::command]
pub fn workspace_switch(
    app: AppHandle,
    window: Window,
    state: State<'_, Workspaces>,
    label: String,
) -> Result<(), String> {
    let group = state.lock().group_of(window.label());
    show_tab(&app, &state, group, &label)?;
    changed(&app);
    Ok(())
}

/// Takes a tab out into a window of its own, beside the one it was in.
#[tauri::command]
pub fn workspace_detach(
    app: AppHandle,
    window: Window,
    state: State<'_, Workspaces>,
    label: String,
) -> Result<(), String> {
    let group = state.lock().group_of(window.label());
    let showing = state.lock().shown.get(&group).cloned();
    if showing.as_deref() == Some(label.as_str()) {
        // The tab on screen leaves: its neighbour takes its place first, so the
        // group is never left showing nothing.
        let Some(neighbour) = neighbour_of(&state, group, &label) else {
            return Ok(());
        };
        show_tab(&app, &state, group, &neighbour)?;
    }
    let target = workspace_window(&app, &label)?;
    {
        let mut registry = state.lock();
        let own = GROUP_COUNTER.fetch_add(1, Ordering::Relaxed);
        if let Some(member) = registry.members.get_mut(&label) {
            member.group = own;
        }
        registry.shown.insert(own, label.clone());
    }
    window_cmds::fit_and_maximize(&target);
    changed(&app);
    Ok(())
}

/// Closes one tab. The tab on screen hands its place to a neighbour first; the
/// last tab closes the window.
#[tauri::command]
pub fn workspace_close(
    app: AppHandle,
    window: Window,
    state: State<'_, Workspaces>,
    label: String,
) -> Result<(), String> {
    let group = state.lock().group_of(window.label());
    let showing = state.lock().shown.get(&group).cloned();
    if showing.as_deref() == Some(label.as_str()) {
        if let Some(neighbour) = neighbour_of(&state, group, &label) {
            show_tab(&app, &state, group, &neighbour)?;
        }
    }
    // Through the ordinary close, so the page writes its session first
    // (`session::closing`).
    workspace_window(&app, &label)?.close().map_err(|e| e.to_string())
}

/// When a workspace window is gone: forget it, and close the tabs that were
/// hidden behind it if it was the one its group showed - closing the window
/// someone sees closes what they see as that window.
pub fn forget_window(app: &AppHandle, label: &str) {
    let behind = app.state::<Workspaces>().lock().forget(label);
    for hidden in behind {
        if let Some(window) = app.get_webview_window(&hidden) {
            if let Err(err) = window.close() {
                eprintln!("[workspaces] could not close {hidden}: {err}");
            }
        }
    }
    changed(app);
}

fn neighbour_of(state: &Workspaces, group: u64, label: &str) -> Option<String> {
    let tabs: Vec<String> = state
        .lock()
        .tabs_of(group)
        .into_iter()
        .map(|tab| tab.label)
        .collect();
    let at = tabs.iter().position(|known| known == label)?;
    tabs.get(at + 1)
        .or_else(|| at.checked_sub(1).and_then(|before| tabs.get(before)))
        .cloned()
}

/// Shows `label` where the group's current window stands, then hides that one.
///
/// Shown before the other is hidden, so there is never a moment with no
/// window on screen. Maximized stays maximized on the same monitor; otherwise
/// the new window takes the old one's exact position and size.
fn show_tab(app: &AppHandle, state: &Workspaces, group: u64, label: &str) -> Result<(), String> {
    let current = state.lock().shown.get(&group).cloned();
    let target = workspace_window(app, label)?;
    match current.as_deref() {
        Some(current) if current != label => {
            let from = workspace_window(app, current)?;
            window_cmds::take_place(&from, &target)?;
        }
        Some(_) => return Ok(()),
        None => window_cmds::fit_and_maximize(&target),
    }
    state.lock().shown.insert(group, label.to_string());
    Ok(())
}

/// A workspace window, built hidden: `show_tab` decides where it appears.
fn build_hidden(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("Aime - AI Mini Editor")
        .inner_size(IDEAL_RESTORE.0, IDEAL_RESTORE.1)
        .min_inner_size(960.0, 600.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_seen_first_is_the_only_tab_of_its_own_group() {
        let mut registry = Registry::default();
        let main = registry.group_of("main");
        let other = registry.group_of("editor-1");
        assert_ne!(main, other);
        assert_eq!(registry.tabs_of(main).len(), 1);
        assert_eq!(registry.shown.get(&main).map(String::as_str), Some("main"));
    }

    #[test]
    fn tabs_keep_the_order_they_were_opened_in() {
        let mut registry = Registry::default();
        let group = registry.group_of("main");
        registry.join("editor-2", group, Some("C:\\b".into()));
        registry.join("editor-1", group, Some("C:\\a".into()));
        let labels: Vec<String> = registry.tabs_of(group).into_iter().map(|tab| tab.label).collect();
        assert_eq!(labels, ["main", "editor-2", "editor-1"]);
    }

    #[test]
    fn closing_the_tab_on_screen_takes_the_hidden_ones_with_it() {
        let mut registry = Registry::default();
        let group = registry.group_of("main");
        registry.join("editor-1", group, None);
        assert_eq!(registry.forget("main"), ["editor-1"]);
    }

    #[test]
    fn closing_a_hidden_tab_takes_nothing_with_it() {
        let mut registry = Registry::default();
        let group = registry.group_of("main");
        registry.join("editor-1", group, None);
        assert!(registry.forget("editor-1").is_empty());
        assert_eq!(registry.tabs_of(group).len(), 1);
    }
}
