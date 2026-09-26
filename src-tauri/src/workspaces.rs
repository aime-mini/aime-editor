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
//!
//! A new workspace window is built hidden and appears only once its page has
//! painted (`painted`, from the page's `app_ready`): shown at once it was a
//! blank window for over half a second - measured 2026-09-26, 213 ms to the
//! window, 777 ms to the page's first paint - which read as the app closing
//! and loading again. Until then a new tab waits in the strip, loading.
//!
//! A tab's first time on screen goes through a stage: it is put on screen
//! beneath the tab showing, where it draws its first frames unseen, and takes
//! that one's place when its page says it has (`workspace_staged`). Shown
//! straight away, a window Windows had never drawn came up at its restored
//! size with an empty page, and the desktop showed through for a frame or two.
//!
//! Which folders a window had open as tabs outlives the app (`remembered`):
//! reopening one of them brings the others back beside it.

mod remembered;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};

use crate::window_cmds::{self, IDEAL_RESTORE};
use crate::window_show;
use remembered::Remembered;

/// The title every workspace window carries.
const WINDOW_TITLE: &str = "Aime - AI Mini Editor";

/// Told to every window when a group gains, loses or renames a tab.
const CHANGED_EVENT: &str = "workspaces:changed";

/// Told, with its label, to a tab just put on screen beneath the one showing.
const STAGED_EVENT: &str = "workspaces:staged";

/// How long a staged tab waits for its page to say it has drawn. A page that
/// is busy or frozen still gets its place - late, rather than never.
const STAGE_WAIT_MAX: Duration = Duration::from_millis(500);

static GROUP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// One workspace window and what it has open.
struct Member {
    group: u64,
    folder: Option<String>,
}

/// How a window built hidden appears once its page has painted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arrival {
    /// A new tab: it takes the place of the tab its group shows.
    Tab,
    /// A window of a group of its own (`Ctrl+Shift+N`): it appears maximized.
    Window,
    /// A tab brought back beside a reopened one: it loads behind the tab on
    /// screen and stays there until it is picked.
    Behind,
}

#[derive(Default)]
struct Registry {
    members: HashMap<String, Member>,
    /// The window each group is showing right now.
    shown: HashMap<u64, String>,
    /// Folders a new workspace window opens with, until its page asks for it.
    pending: HashMap<String, String>,
    /// Windows built hidden, waiting for their page to paint.
    arriving: HashMap<String, Arrival>,
    /// Tabs Windows has never drawn: their first showing is staged.
    unseen: HashSet<String>,
    /// Tabs on screen beneath the one their group shows, each with the tab it
    /// is to take the place of.
    staged: HashMap<String, String>,
    /// The order tabs were opened in, which is the order they are drawn in.
    order: Vec<String>,
    /// The folders each window had open as tabs, as last recorded.
    remembered: Remembered,
}

#[derive(Default)]
pub struct Workspaces(Mutex<Registry>);

/// One tab as the strip draws it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    label: String,
    folder: Option<String>,
    /// Its page is still loading; the tab appears once it has painted.
    loading: bool,
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

    /// Reads which folders were open together the last time the app ran.
    pub fn load_remembered(&self, app: &AppHandle) {
        self.lock().remembered = Remembered::load(app);
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

    /// The folders a group has open, in the order its tabs are drawn; a tab
    /// on the welcome screen has none.
    fn folders_of(&self, group: u64, leaving: Option<&str>) -> Vec<String> {
        self.tabs_of(group)
            .into_iter()
            .filter(|tab| Some(tab.label.as_str()) != leaving)
            .filter_map(|tab| tab.folder)
            .collect()
    }

    /// Puts a group's tabs in `labels`' order, in the places they hold in
    /// the strip. `labels` names every tab of the group.
    fn arrange(&mut self, group: u64, labels: &[String]) {
        let slots: Vec<usize> = self
            .order
            .iter()
            .enumerate()
            .filter(|(_, label)| {
                self.members
                    .get(*label)
                    .is_some_and(|member| member.group == group)
            })
            .map(|(slot, _)| slot)
            .collect();
        for (slot, label) in slots.into_iter().zip(labels) {
            self.order[slot].clone_from(label);
        }
    }

    fn is_open(&self, folder: &str) -> bool {
        self.members.values().any(|member| {
            member
                .folder
                .as_deref()
                .is_some_and(|open| remembered::same_folder(open, folder))
        })
    }

    fn tabs_of(&self, group: u64) -> Vec<Tab> {
        self.order
            .iter()
            .filter_map(|label| {
                let member = self.members.get(label)?;
                (member.group == group).then(|| Tab {
                    label: label.clone(),
                    folder: member.folder.clone(),
                    loading: self.arriving.contains_key(label),
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
        self.arriving.remove(label);
        self.unseen.remove(label);
        self.staged.remove(label);
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

/// Records the folders `group` holds now - `leaving` is a tab about to close,
/// already counted out - and writes the record down.
fn remember(app: &AppHandle, state: &Workspaces, group: u64, leaving: Option<&str>, departed: Option<&str>) {
    let saved = {
        let mut registry = state.lock();
        let folders = registry.folders_of(group, leaving);
        registry.remembered.record(&folders, departed);
        registry.remembered.save(app)
    };
    if let Err(err) = saved {
        eprintln!("[workspaces] could not remember the tabs: {err}");
    }
}

/// Opens, behind `anchor`, the folders it was last open with as tabs, in the
/// order they stood. One already open somewhere, or gone from the disk, stays
/// out.
fn bring_back(
    app: &AppHandle,
    state: &Workspaces,
    group: u64,
    anchor: &str,
    folder: &str,
) -> Result<(), String> {
    let built = {
        let mut registry = state.lock();
        let Some(set) = registry.remembered.beside(folder).map(<[String]>::to_vec) else {
            return Ok(());
        };
        let mut ordered = Vec::new();
        let mut built = Vec::new();
        for wanted in set {
            if remembered::same_folder(&wanted, folder) {
                ordered.push(anchor.to_string());
                continue;
            }
            if registry.is_open(&wanted) || !Path::new(&wanted).is_dir() {
                continue;
            }
            let label = window_cmds::next_label();
            registry.join(&label, group, Some(wanted.clone()));
            registry.arriving.insert(label.clone(), Arrival::Behind);
            registry.unseen.insert(label.clone());
            registry.pending.insert(label.clone(), wanted);
            ordered.push(label.clone());
            built.push(label);
        }
        registry.arrange(group, &ordered);
        built
    };
    for label in &built {
        build_hidden(app, label)?;
    }
    Ok(())
}

fn workspace_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("no workspace window {label}"))
}

/// Says what the calling window has open, so its tab can be named.
///
/// A folder opened in a window of one tab brings back the tabs it was last
/// open with. Async because that builds windows, which a synchronous command
/// cannot do on Windows without deadlocking.
#[tauri::command]
pub async fn workspace_register(
    app: AppHandle,
    window: Window,
    state: State<'_, Workspaces>,
    folder: Option<String>,
) -> Result<(), String> {
    let label = window.label();
    let (group, before, alone) = {
        let mut registry = state.lock();
        let group = registry.group_of(label);
        let before = registry
            .members
            .get_mut(label)
            .and_then(|member| std::mem::replace(&mut member.folder, folder.clone()));
        (group, before, registry.tabs_of(group).len() == 1)
    };
    // The same folder again is the page reloading: nothing about the tabs changed.
    if before != folder {
        if let (true, Some(folder)) = (alone, folder.as_deref()) {
            bring_back(&app, &state, group, label, folder)?;
        }
        remember(&app, &state, group, None, before.as_deref());
    }
    changed(&app);
    Ok(())
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
        registry.arriving.insert(label.clone(), Arrival::Tab);
        registry.unseen.insert(label.clone());
        if let Some(folder) = folder {
            registry.pending.insert(label.clone(), folder);
        }
    }
    build_hidden(&app, &label)?;
    remember(&app, &state, group, None, None);
    changed(&app);
    Ok(())
}

/// Opens a workspace window of a group of its own (`Ctrl+Shift+N`).
#[tauri::command]
pub async fn open_new_window(app: AppHandle, state: State<'_, Workspaces>) -> Result<(), String> {
    let label = window_cmds::next_label();
    state.lock().arriving.insert(label.clone(), Arrival::Window);
    build_hidden(&app, &label)?;
    Ok(())
}

/// A workspace window's page has painted its first screen: a window built
/// hidden for it appears now. A page painting again - reloaded in a window
/// already placed - changes nothing.
pub fn painted(app: &AppHandle, label: &str) -> Result<(), String> {
    let state = app.state::<Workspaces>();
    let (arrival, group) = {
        let mut registry = state.lock();
        let arrival = registry.arriving.remove(label);
        (arrival, registry.members.get(label).map(|member| member.group))
    };
    match (arrival, group) {
        (None, _) => Ok(()),
        (Some(Arrival::Window), _) => {
            window_cmds::fit_and_maximize(&workspace_window(app, label)?);
            Ok(())
        }
        (Some(Arrival::Tab), Some(group)) => {
            show_tab(app, &state, group, label)?;
            changed(app);
            Ok(())
        }
        (Some(Arrival::Behind), _) => {
            changed(app);
            Ok(())
        }
        (Some(Arrival::Tab), None) => Err(format!("tab {label} painted after it was closed")),
    }
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
        show_tab_now(&app, &state, group, &neighbour)?;
    }
    let target = workspace_window(&app, &label)?;
    let folder = {
        let mut registry = state.lock();
        registry.unseen.remove(&label);
        let own = GROUP_COUNTER.fetch_add(1, Ordering::Relaxed);
        registry.shown.insert(own, label.clone());
        registry.members.get_mut(&label).and_then(|member| {
            member.group = own;
            member.folder.clone()
        })
    };
    remember(&app, &state, group, None, folder.as_deref());
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
            // At once, not staged: the window it replaces is about to close,
            // and would take a tab still beneath it along.
            show_tab_now(&app, &state, group, &neighbour)?;
        }
    }
    let folder = state
        .lock()
        .members
        .get(&label)
        .and_then(|member| member.folder.clone());
    remember(&app, &state, group, Some(&label), folder.as_deref());
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

/// The tab beside `label` that can be shown in its place - one still loading
/// cannot.
fn neighbour_of(state: &Workspaces, group: u64, label: &str) -> Option<String> {
    let tabs: Vec<String> = state
        .lock()
        .tabs_of(group)
        .into_iter()
        .filter(|tab| tab.label == label || !tab.loading)
        .map(|tab| tab.label)
        .collect();
    let at = tabs.iter().position(|known| known == label)?;
    tabs.get(at + 1)
        .or_else(|| at.checked_sub(1).and_then(|before| tabs.get(before)))
        .cloned()
}

/// Shows `label` in its group's place: a tab Windows has already drawn at
/// once, one it never has through a stage.
fn show_tab(app: &AppHandle, state: &Workspaces, group: u64, label: &str) -> Result<(), String> {
    let beneath = {
        let registry = state.lock();
        if registry.arriving.contains_key(label) {
            // Still blank: it takes its place once its page has painted.
            return Ok(());
        }
        let current = registry.shown.get(&group).cloned();
        current.filter(|current| current != label && registry.unseen.contains(label))
    };
    match beneath {
        Some(current) => stage(app, state, &current, label),
        None => show_tab_now(app, state, group, label),
    }
}

/// Puts `label` on screen beneath `current`, and asks its page to say when it
/// has drawn there (`workspace_staged`).
fn stage(app: &AppHandle, state: &Workspaces, current: &str, label: &str) -> Result<(), String> {
    window_show::beneath(&workspace_window(app, current)?, &workspace_window(app, label)?)?;
    state.lock().staged.insert(label.to_string(), current.to_string());
    app.emit(STAGED_EVENT, label)
        .map_err(|e| format!("could not tell {label} it is staged: {e}"))?;
    let (app, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STAGE_WAIT_MAX).await;
        if let Err(err) = present(&app, &label) {
            eprintln!("[workspaces] could not show {label}: {err}");
        }
    });
    Ok(())
}

/// A staged tab's page has drawn: it takes its place. Asked for once by the
/// page and once by the time limit, whichever comes first; the other finds
/// nothing staged. A tab whose group has moved on to another tab meanwhile is
/// taken off the screen again instead.
fn present(app: &AppHandle, label: &str) -> Result<(), String> {
    let state = app.state::<Workspaces>();
    let (group, still_current) = {
        let mut registry = state.lock();
        let Some(replacing) = registry.staged.remove(label) else {
            return Ok(());
        };
        let Some(group) = registry.members.get(label).map(|member| member.group) else {
            return Ok(());
        };
        registry.unseen.remove(label);
        (group, registry.shown.get(&group) == Some(&replacing))
    };
    if !still_current {
        return window_show::withdraw(&workspace_window(app, label)?);
    }
    show_tab_now(app, &state, group, label)?;
    changed(app);
    Ok(())
}

/// The page of a staged tab has drawn its frames on screen.
#[tauri::command]
pub fn workspace_staged(app: AppHandle, window: Window) -> Result<(), String> {
    present(&app, window.label())
}

/// Shows `label` where the group's current window stands, then hides that one.
///
/// Shown before the other is hidden, so there is never a moment with no
/// window on screen. Maximized stays maximized on the same monitor; otherwise
/// the new window takes the old one's exact position and size.
fn show_tab_now(app: &AppHandle, state: &Workspaces, group: u64, label: &str) -> Result<(), String> {
    let current = {
        let mut registry = state.lock();
        if registry.arriving.contains_key(label) {
            // Still blank: it takes its place once its page has painted.
            return Ok(());
        }
        registry.unseen.remove(label);
        registry.shown.get(&group).cloned()
    };
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

/// A workspace window, built hidden: `painted` decides when and where it
/// appears.
fn build_hidden(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title(WINDOW_TITLE)
        .inner_size(IDEAL_RESTORE.0, IDEAL_RESTORE.1)
        .min_inner_size(960.0, 600.0)
        .visible(false)
        // Nor focused: a hidden window that takes the focus while its page
        // loads takes the keystrokes meant for the workspace on screen.
        .focused(false)
        // The native drag-drop handler stays on, as it is in the first window
        // (`dragDropEnabled` in tauri.conf.json): it is what hands the page a
        // file dropped from the OS file manager with its path on disk. The file
        // tree no longer needs DOM drag events for its own moves - it drags on
        // pointer events (`stores/pathDrag.ts`) - so nothing is lost by it.
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
    fn a_tab_still_loading_says_so_until_it_is_forgotten() {
        let mut registry = Registry::default();
        let group = registry.group_of("main");
        registry.join("editor-1", group, None);
        registry.arriving.insert("editor-1".into(), Arrival::Tab);
        let loading: Vec<bool> = registry.tabs_of(group).iter().map(|tab| tab.loading).collect();
        assert_eq!(loading, [false, true]);
        registry.forget("editor-1");
        assert!(registry.arriving.is_empty());
    }

    #[test]
    fn tabs_brought_back_stand_in_the_order_they_were_remembered() {
        let mut registry = Registry::default();
        let group = registry.group_of("main");
        registry.join("editor-1", group, None);
        registry.join("editor-2", group, None);
        registry.arrange(group, &["editor-1".into(), "main".into(), "editor-2".into()]);
        let labels: Vec<String> = registry.tabs_of(group).into_iter().map(|tab| tab.label).collect();
        assert_eq!(labels, ["editor-1", "main", "editor-2"]);
    }

    #[test]
    fn a_tab_closing_is_counted_out_of_its_folders() {
        let mut registry = Registry::default();
        let group = registry.group_of("main");
        registry.members.get_mut("main").expect("joined").folder = Some("a".into());
        registry.join("editor-1", group, Some("b".into()));
        registry.join("editor-2", group, None);
        assert_eq!(registry.folders_of(group, None), ["a", "b"]);
        assert_eq!(registry.folders_of(group, Some("editor-1")), ["a"]);
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
