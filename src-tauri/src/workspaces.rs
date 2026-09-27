//! Several workspaces in one window, as tabs.
//!
//! A window is what the person sees; each workspace in it is a webview of its
//! own - its own page, its own stores and AI session - and everything it starts
//! (terminals, language servers, debug adapters, the file watcher) is keyed by
//! that webview's label, so two workspaces in one window never see each
//! other's output.
//!
//! Switching tabs moves the chosen webview into the window and parks the one
//! leaving just outside its client area. The window itself does not change:
//! nothing is shown or hidden, the taskbar keeps its one button, the desktop
//! has nothing to animate. Parked, a webview is still on screen as far as the
//! engine knows, so a workspace switched away from keeps running and drawing
//! at full speed - measured 2026-09-26, 31 animation frames in 500 ms parked
//! and shown alike.
//!
//! This replaced a window per tab (session 44). Swapping windows could not be
//! made to look like a tab: the desktop animated each window in and out, one
//! it had never drawn came up empty, and the taskbar traded buttons - *"khi mở
//! workspace mới vẫn còn hiệu ứng cửa sổ mở"*, after four rounds of fixes.
//!
//! A new tab is added parked and moved in once its page has painted
//! (`painted`, from the page's `app_ready`); until then it spins in the strip.
//! Which folders a window had as tabs outlives the app (`remembered`):
//! reopening one of them brings the others back beside it.

mod remembered;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, State, Webview, WebviewUrl, Window,
};

use crate::session::closing;
use crate::window_cmds::{self, IDEAL_RESTORE};
use crate::{dap, fs_watch, lsp, terminal};
use remembered::Remembered;

/// The window the app opens with.
pub const FIRST_WINDOW: &str = "main";

/// Windows opened after it: `Ctrl+Shift+N`, and a tab taken out.
const WINDOW_PREFIX: &str = "window-";

/// Every workspace. Distinct from the windows' names so an event sent to a
/// workspace by its label can never also reach a window of that name - and
/// through it every tab inside.
const WORKSPACE_PREFIX: &str = "editor-";

/// The title every workspace window carries.
const WINDOW_TITLE: &str = "Aime - AI Mini Editor";

/// Told to every workspace when a window gains, loses or renames a tab.
const CHANGED_EVENT: &str = "workspaces:changed";

/// How far left of the window's client area a parked workspace stands.
const PARK_GAP: i32 = 64;

static LABEL_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_label(prefix: &str) -> String {
    format!("{prefix}{}", LABEL_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// The windows that hold workspaces - the ones `capabilities/default.json`
/// grants the editor to. The greeting has none.
pub fn holds_workspaces(window: &str) -> bool {
    window == FIRST_WINDOW || window.starts_with(WINDOW_PREFIX)
}

/// One workspace and what it has open.
struct Member {
    window: String,
    folder: Option<String>,
}

/// What happens to a workspace once its page has painted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arrival {
    /// A new tab: it takes the place of the one its window shows.
    Tab,
    /// The only workspace of a window just opened (`Ctrl+Shift+N`): the
    /// window appears.
    Window,
    /// A tab brought back beside a reopened one: it stays parked until it is
    /// picked.
    Behind,
}

#[derive(Default)]
struct Registry {
    /// Every workspace, by its webview label.
    members: HashMap<String, Member>,
    /// The workspace each window is showing.
    shown: HashMap<String, String>,
    /// Folders a new workspace opens with, until its page asks for it.
    pending: HashMap<String, String>,
    /// Workspaces whose page has not painted yet.
    arriving: HashMap<String, Arrival>,
    /// The order tabs were opened in, which is the order they are drawn in.
    order: Vec<String>,
    /// The first workspace, the one the greeting hands over to.
    first: Option<String>,
    /// The folder the app was launched on (`aime <folder>`): the first
    /// workspace opens it every time its page loads.
    launch_folder: Option<String>,
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
    /// Its page is still loading; the tab comes in once it has painted.
    loading: bool,
}

/// The tabs of the calling workspace's window, and which of them is on screen.
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

    /// The folder a workspace's page opens: for the first workspace, the one
    /// the app was launched on, on every load; for a tab, the one it was
    /// opened on, once - a page loading again starts on the welcome screen.
    pub fn initial_folder(&self, label: &str) -> Option<String> {
        let mut registry = self.lock();
        if registry.first.as_deref() == Some(label) {
            return registry.launch_folder.clone();
        }
        registry.pending.remove(label)
    }

    /// Reads which folders were open together the last time the app ran.
    pub fn load_remembered(&self, app: &AppHandle) {
        self.lock().remembered = Remembered::load(app);
    }

    /// Whether `label` is the workspace the greeting is waiting for.
    pub fn is_first(&self, label: &str) -> bool {
        self.lock().first.as_deref() == Some(label)
    }

    /// The workspaces a window holds.
    pub fn in_window(&self, window: &str) -> Vec<String> {
        self.lock().in_window(window)
    }
}

impl Registry {
    fn join(&mut self, label: &str, window: &str, folder: Option<String>) {
        self.members.insert(
            label.to_string(),
            Member {
                window: window.to_string(),
                folder,
            },
        );
        if !self.order.iter().any(|known| known == label) {
            self.order.push(label.to_string());
        }
    }

    fn window_of(&self, label: &str) -> Result<String, String> {
        self.members
            .get(label)
            .map(|member| member.window.clone())
            .ok_or_else(|| format!("no workspace {label}"))
    }

    fn in_window(&self, window: &str) -> Vec<String> {
        self.tabs_of(window).into_iter().map(|tab| tab.label).collect()
    }

    fn tabs_of(&self, window: &str) -> Vec<Tab> {
        self.order
            .iter()
            .filter_map(|label| {
                let member = self.members.get(label)?;
                (member.window == window).then(|| Tab {
                    label: label.clone(),
                    folder: member.folder.clone(),
                    loading: self.arriving.contains_key(label),
                })
            })
            .collect()
    }

    /// The folders a window has open, in the order its tabs are drawn; a tab
    /// on the welcome screen has none.
    fn folders_of(&self, window: &str, leaving: Option<&str>) -> Vec<String> {
        self.tabs_of(window)
            .into_iter()
            .filter(|tab| Some(tab.label.as_str()) != leaving)
            .filter_map(|tab| tab.folder)
            .collect()
    }

    /// Puts a window's tabs in `labels`' order, in the places they hold in
    /// the strip. `labels` names every tab of the window.
    fn arrange(&mut self, window: &str, labels: &[String]) {
        let slots: Vec<usize> = self
            .order
            .iter()
            .enumerate()
            .filter(|(_, label)| {
                self.members
                    .get(*label)
                    .is_some_and(|member| member.window == window)
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

    /// The tab beside `label` that can come on screen in its place - one still
    /// loading cannot.
    fn neighbour_of(&self, window: &str, label: &str) -> Option<String> {
        let tabs: Vec<String> = self
            .tabs_of(window)
            .into_iter()
            .filter(|tab| tab.label == label || !tab.loading)
            .map(|tab| tab.label)
            .collect();
        let at = tabs.iter().position(|known| known == label)?;
        tabs.get(at + 1)
            .or_else(|| at.checked_sub(1).and_then(|before| tabs.get(before)))
            .cloned()
    }

    fn forget(&mut self, label: &str) {
        let Some(member) = self.members.remove(label) else {
            return;
        };
        self.order.retain(|known| known != label);
        self.pending.remove(label);
        self.arriving.remove(label);
        if self.shown.get(&member.window).map(String::as_str) == Some(label) {
            self.shown.remove(&member.window);
        }
    }
}

fn changed(app: &AppHandle) {
    if let Err(err) = app.emit(CHANGED_EVENT, ()) {
        eprintln!("[workspaces] could not announce a change: {err}");
    }
}

fn window_named(app: &AppHandle, label: &str) -> Result<Window, String> {
    app.get_window(label).ok_or_else(|| format!("no window {label}"))
}

fn webview_named(app: &AppHandle, label: &str) -> Result<Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| format!("no workspace {label}"))
}

/// Where a parked workspace stands: just left of the window's client area, at
/// full size, so bringing it in is a move and never a resize.
fn parked(size: PhysicalSize<u32>) -> PhysicalPosition<i32> {
    let width = i32::try_from(size.width).unwrap_or(i32::MAX);
    PhysicalPosition::new(width.saturating_neg().saturating_sub(PARK_GAP), 0)
}

fn bounds(position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Rect {
    Rect {
        position: position.into(),
        size: size.into(),
    }
}

/// A window to hold workspaces, built hidden: it appears once its first
/// workspace has painted.
fn build_window(app: &AppHandle, label: &str) -> Result<Window, String> {
    WindowBuilder::new(app, label)
        .title(WINDOW_TITLE)
        .inner_size(IDEAL_RESTORE.0, IDEAL_RESTORE.1)
        .min_inner_size(960.0, 600.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

/// A workspace in `window`, filling it - on screen, or parked beside it.
fn add_workspace(window: &Window, label: &str, on_screen: bool) -> Result<Webview, String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let position = if on_screen {
        PhysicalPosition::new(0, 0)
    } else {
        parked(size)
    };
    // The native drag-drop handler stays on: it is what hands the page a file
    // dropped from the OS file manager with its path on disk. The file tree
    // drags on pointer events of its own (`stores/pathDrag.ts`).
    //
    // Not focused: a workspace that takes the focus while its page loads takes
    // the keystrokes meant for the one on screen.
    let builder = WebviewBuilder::new(label, WebviewUrl::default()).focused(false);
    window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())
}

/// Opens the app's first window with its first workspace, `folder` in it
/// when the app was launched on one (`aime <folder>`).
pub fn open_first(app: &AppHandle, folder: Option<String>) -> Result<(), String> {
    let window = build_window(app, FIRST_WINDOW)?;
    let label = next_label(WORKSPACE_PREFIX);
    {
        let state = app.state::<Workspaces>();
        let mut registry = state.lock();
        registry.join(&label, FIRST_WINDOW, None);
        registry.shown.insert(FIRST_WINDOW.to_string(), label.clone());
        registry.first = Some(label.clone());
        registry.launch_folder = folder;
    }
    add_workspace(&window, &label, true)?;
    Ok(())
}

/// Puts a window on screen, maximized, with the keyboard in the workspace it
/// shows.
pub fn show_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = window_named(app, label)?;
    window_cmds::fit_and_maximize(&window);
    let shown = app.state::<Workspaces>().lock().shown.get(label).cloned();
    if let Some(shown) = shown {
        webview_named(app, &shown)?
            .set_focus()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Keeps every workspace of a window at the window's size when it is
/// resized: the one shown filling it, the others parked beside it.
pub fn layout(window: &Window) {
    if !holds_workspaces(window.label()) {
        return;
    }
    let size = match window.inner_size() {
        Ok(size) => size,
        Err(err) => {
            eprintln!("[workspaces] no size for {}: {err}", window.label());
            return;
        }
    };
    let state = window.state::<Workspaces>();
    let (labels, shown) = {
        let registry = state.lock();
        (
            registry.in_window(window.label()),
            registry.shown.get(window.label()).cloned(),
        )
    };
    for label in labels {
        let position = if shown.as_deref() == Some(label.as_str()) {
            PhysicalPosition::new(0, 0)
        } else {
            parked(size)
        };
        if let Some(webview) = window.app_handle().get_webview(&label) {
            if let Err(err) = webview.set_bounds(bounds(position, size)) {
                eprintln!("[workspaces] could not fit {label} to its window: {err}");
            }
        }
    }
}

/// Moves `label` into its window's client area and parks the one it shows.
///
/// In before out, so the window never shows neither. A tab still loading comes
/// in once its page has painted instead.
fn bring_on_screen(app: &AppHandle, state: &Workspaces, window: &str, label: &str) -> Result<(), String> {
    let current = {
        let registry = state.lock();
        if registry.arriving.contains_key(label) {
            return Ok(());
        }
        registry.shown.get(window).cloned()
    };
    let arriving = webview_named(app, label)?;
    if current.as_deref() != Some(label) {
        let size = window_named(app, window)?
            .inner_size()
            .map_err(|e| e.to_string())?;
        arriving
            .set_bounds(bounds(PhysicalPosition::new(0, 0), size))
            .map_err(|e| e.to_string())?;
        if let Some(current) = current {
            webview_named(app, &current)?
                .set_bounds(bounds(parked(size), size))
                .map_err(|e| e.to_string())?;
        }
        state.lock().shown.insert(window.to_string(), label.to_string());
    }
    arriving.set_focus().map_err(|e| e.to_string())
}

/// Records the folders `window` holds now - `leaving` is a tab about to close,
/// already counted out - and writes the record down.
fn remember(
    app: &AppHandle,
    state: &Workspaces,
    window: &str,
    leaving: Option<&str>,
    departed: Option<&str>,
) {
    let saved = {
        let mut registry = state.lock();
        let folders = registry.folders_of(window, leaving);
        registry.remembered.record(&folders, departed);
        registry.remembered.save(app)
    };
    if let Err(err) = saved {
        eprintln!("[workspaces] could not remember the tabs: {err}");
    }
}

/// Opens, parked beside `anchor`, the folders it was last open with as tabs,
/// in the order they stood. One already open somewhere, or gone from the
/// disk, stays out.
fn bring_back(
    app: &AppHandle,
    state: &Workspaces,
    window: &str,
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
            let label = next_label(WORKSPACE_PREFIX);
            registry.join(&label, window, Some(wanted.clone()));
            registry.arriving.insert(label.clone(), Arrival::Behind);
            registry.pending.insert(label.clone(), wanted);
            ordered.push(label.clone());
            built.push(label);
        }
        registry.arrange(window, &ordered);
        built
    };
    let host = window_named(app, window)?;
    for label in &built {
        add_workspace(&host, label, false)?;
    }
    Ok(())
}

/// Says what the calling workspace has open, so its tab can be named.
///
/// A folder opened in a window of one tab brings back the tabs it was last
/// open with. Async because that builds webviews, which a synchronous command
/// cannot do on Windows without deadlocking.
#[tauri::command]
pub async fn workspace_register(
    app: AppHandle,
    webview: Webview,
    state: State<'_, Workspaces>,
    folder: Option<String>,
) -> Result<(), String> {
    let label = webview.label();
    let (window, before, alone) = {
        let mut registry = state.lock();
        let window = registry.window_of(label)?;
        let before = registry
            .members
            .get_mut(label)
            .and_then(|member| std::mem::replace(&mut member.folder, folder.clone()));
        let alone = registry.tabs_of(&window).len() == 1;
        (window, before, alone)
    };
    // The same folder again is the page reloading: nothing about the tabs changed.
    if before != folder {
        if let (true, Some(folder)) = (alone, folder.as_deref()) {
            bring_back(&app, &state, &window, label, folder)?;
        }
        remember(&app, &state, &window, None, before.as_deref());
    }
    changed(&app);
    Ok(())
}

/// The tabs the calling workspace draws.
#[tauri::command]
pub fn workspace_tabs(webview: Webview, state: State<'_, Workspaces>) -> Result<Tabs, String> {
    let registry = state.lock();
    let window = registry.window_of(webview.label())?;
    let active = registry
        .shown
        .get(&window)
        .cloned()
        .unwrap_or_else(|| webview.label().to_string());
    Ok(Tabs {
        tabs: registry.tabs_of(&window),
        active,
    })
}

/// Opens a workspace as a new tab of the calling workspace's window; it comes
/// on screen once its page has painted.
///
/// A folder already open in the window is switched to rather than opened
/// twice; no folder opens the tab on the welcome screen.
#[tauri::command]
pub async fn workspace_open(
    app: AppHandle,
    webview: Webview,
    state: State<'_, Workspaces>,
    folder: Option<String>,
) -> Result<(), String> {
    let (window, existing) = {
        let registry = state.lock();
        let window = registry.window_of(webview.label())?;
        let existing = folder.as_ref().and_then(|wanted| {
            registry
                .tabs_of(&window)
                .into_iter()
                .find(|tab| {
                    tab.folder
                        .as_deref()
                        .is_some_and(|open| remembered::same_folder(open, wanted))
                })
                .map(|tab| tab.label)
        });
        (window, existing)
    };
    if let Some(label) = existing {
        return bring_on_screen(&app, &state, &window, &label);
    }
    let label = next_label(WORKSPACE_PREFIX);
    {
        let mut registry = state.lock();
        registry.join(&label, &window, folder.clone());
        registry.arriving.insert(label.clone(), Arrival::Tab);
        if let Some(folder) = folder {
            registry.pending.insert(label.clone(), folder);
        }
    }
    add_workspace(&window_named(&app, &window)?, &label, false)?;
    remember(&app, &state, &window, None, None);
    changed(&app);
    Ok(())
}

/// Opens a window of its own with a workspace in it (`Ctrl+Shift+N`); it
/// appears once that workspace's page has painted.
#[tauri::command]
pub async fn open_new_window(app: AppHandle, state: State<'_, Workspaces>) -> Result<(), String> {
    let window = next_label(WINDOW_PREFIX);
    let label = next_label(WORKSPACE_PREFIX);
    let host = build_window(&app, &window)?;
    {
        let mut registry = state.lock();
        registry.join(&label, &window, None);
        registry.shown.insert(window.clone(), label.clone());
        registry.arriving.insert(label.clone(), Arrival::Window);
    }
    add_workspace(&host, &label, true)?;
    Ok(())
}

/// A workspace's page has painted its first screen: what was waiting for it
/// happens now. A page painting again - reloaded - changes nothing.
pub fn painted(app: &AppHandle, label: &str) -> Result<(), String> {
    let state = app.state::<Workspaces>();
    let (arrival, window) = {
        let mut registry = state.lock();
        let arrival = registry.arriving.remove(label);
        (arrival, registry.window_of(label)?)
    };
    match arrival {
        None => return Ok(()),
        Some(Arrival::Tab) => bring_on_screen(app, &state, &window, label)?,
        Some(Arrival::Window) => show_window(app, &window)?,
        Some(Arrival::Behind) => {}
    }
    changed(app);
    Ok(())
}

/// Shows another tab of the calling workspace's window.
#[tauri::command]
pub fn workspace_switch(
    app: AppHandle,
    webview: Webview,
    state: State<'_, Workspaces>,
    label: String,
) -> Result<(), String> {
    let window = state.lock().window_of(webview.label())?;
    bring_on_screen(&app, &state, &window, &label)?;
    changed(&app);
    Ok(())
}

/// Takes a tab out into a window of its own, beside the one it was in.
#[tauri::command]
pub async fn workspace_detach(
    app: AppHandle,
    webview: Webview,
    state: State<'_, Workspaces>,
    label: String,
) -> Result<(), String> {
    let (window, showing, neighbour) = {
        let registry = state.lock();
        let window = registry.window_of(webview.label())?;
        let showing = registry.shown.get(&window).cloned();
        let neighbour = registry.neighbour_of(&window, &label);
        (window, showing, neighbour)
    };
    if showing.as_deref() == Some(label.as_str()) {
        // The tab on screen leaves: its neighbour takes its place first. The
        // only tab is a window of its own already.
        let Some(neighbour) = neighbour else {
            return Ok(());
        };
        bring_on_screen(&app, &state, &window, &neighbour)?;
    }
    let own = next_label(WINDOW_PREFIX);
    let host = build_window(&app, &own)?;
    let leaving = webview_named(&app, &label)?;
    leaving.reparent(&host).map_err(|e| e.to_string())?;
    let size = host.inner_size().map_err(|e| e.to_string())?;
    leaving
        .set_bounds(bounds(PhysicalPosition::new(0, 0), size))
        .map_err(|e| e.to_string())?;
    let folder = {
        let mut registry = state.lock();
        registry.shown.insert(own.clone(), label.clone());
        registry.members.get_mut(&label).and_then(|member| {
            own.clone_into(&mut member.window);
            member.folder.clone()
        })
    };
    remember(&app, &state, &window, None, folder.as_deref());
    show_window(&app, &own)?;
    changed(&app);
    Ok(())
}

/// Closes one tab, once its page has written what it holds. The tab on
/// screen hands its place to a neighbour first; the last tab closes the
/// window.
#[tauri::command]
pub async fn workspace_close(
    app: AppHandle,
    webview: Webview,
    state: State<'_, Workspaces>,
    label: String,
) -> Result<(), String> {
    let (window, showing, neighbour, folder) = {
        let registry = state.lock();
        let window = registry.window_of(webview.label())?;
        let showing = registry.shown.get(&window).cloned();
        let neighbour = registry.neighbour_of(&window, &label);
        let folder = registry
            .members
            .get(&label)
            .and_then(|member| member.folder.clone());
        (window, showing, neighbour, folder)
    };
    if showing.as_deref() == Some(label.as_str()) {
        let Some(neighbour) = neighbour else {
            // Through the ordinary close, which writes every tab's session first.
            return window_named(&app, &window)?.close().map_err(|e| e.to_string());
        };
        bring_on_screen(&app, &state, &window, &neighbour)?;
    }
    remember(&app, &state, &window, Some(&label), folder.as_deref());
    closing::close_workspace(&app, &label).await?;
    workspace_gone(&app, &label);
    Ok(())
}

/// Everything a workspace started stops with it, and its tab goes.
fn workspace_gone(app: &AppHandle, label: &str) {
    fs_watch::drop_watcher_for(app, label);
    terminal::kill_for_workspace(app, label);
    lsp::stop_for_workspace(app, label);
    dap::stop_for_workspace(app, label);
    app.state::<Workspaces>().lock().forget(label);
    changed(app);
}

/// A window is gone, and every workspace in it with it.
pub fn window_gone(app: &AppHandle, window: &str) {
    for label in app.state::<Workspaces>().in_window(window) {
        workspace_gone(app, &label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_with(window: &str, tabs: &[(&str, Option<&str>)]) -> Registry {
        let mut registry = Registry::default();
        for (label, folder) in tabs {
            registry.join(label, window, folder.map(ToString::to_string));
        }
        registry.shown.insert(window.to_string(), tabs[0].0.to_string());
        registry
    }

    #[test]
    fn workspaces_and_windows_never_share_a_name() {
        let workspace = next_label(WORKSPACE_PREFIX);
        assert!(
            !holds_workspaces(&workspace),
            "{workspace} would also address a window"
        );
        assert!(holds_workspaces(&next_label(WINDOW_PREFIX)));
        assert!(holds_workspaces(FIRST_WINDOW));
        assert!(!holds_workspaces("splash"));
    }

    #[test]
    fn tabs_keep_the_order_they_were_opened_in_and_stay_in_their_window() {
        let mut registry = registry_with("main", &[("editor-1", None), ("editor-3", Some("b"))]);
        registry.join("editor-2", "window-9", None);
        let labels: Vec<String> = registry
            .tabs_of("main")
            .into_iter()
            .map(|tab| tab.label)
            .collect();
        assert_eq!(labels, ["editor-1", "editor-3"]);
        assert_eq!(registry.in_window("window-9"), ["editor-2"]);
    }

    #[test]
    fn a_tab_still_loading_says_so_and_is_nobody_s_neighbour() {
        let mut registry = registry_with("main", &[("editor-1", None), ("editor-2", None)]);
        registry.arriving.insert("editor-2".into(), Arrival::Tab);
        let loading: Vec<bool> = registry.tabs_of("main").iter().map(|tab| tab.loading).collect();
        assert_eq!(loading, [false, true]);
        assert_eq!(registry.neighbour_of("main", "editor-1"), None);
    }

    #[test]
    fn the_neighbour_is_the_next_tab_or_else_the_one_before() {
        let registry = registry_with(
            "main",
            &[("editor-1", None), ("editor-2", None), ("editor-3", None)],
        );
        assert_eq!(
            registry.neighbour_of("main", "editor-2").as_deref(),
            Some("editor-3")
        );
        assert_eq!(
            registry.neighbour_of("main", "editor-3").as_deref(),
            Some("editor-2")
        );
    }

    #[test]
    fn forgetting_the_tab_on_screen_leaves_its_window_showing_nothing() {
        let mut registry = registry_with("main", &[("editor-1", None), ("editor-2", None)]);
        registry.forget("editor-1");
        assert!(!registry.shown.contains_key("main"));
        assert_eq!(registry.in_window("main"), ["editor-2"]);
    }

    #[test]
    fn tabs_brought_back_stand_in_the_order_they_were_remembered() {
        let mut registry = registry_with(
            "main",
            &[("editor-1", None), ("editor-2", None), ("editor-3", None)],
        );
        registry.arrange("main", &["editor-2".into(), "editor-1".into(), "editor-3".into()]);
        assert_eq!(registry.in_window("main"), ["editor-2", "editor-1", "editor-3"]);
    }

    #[test]
    fn a_tab_closing_is_counted_out_of_its_folders() {
        let registry = registry_with(
            "main",
            &[
                ("editor-1", Some("a")),
                ("editor-2", Some("b")),
                ("editor-3", None),
            ],
        );
        assert_eq!(registry.folders_of("main", None), ["a", "b"]);
        assert_eq!(registry.folders_of("main", Some("editor-2")), ["a"]);
    }

    #[test]
    fn a_parked_workspace_stands_clear_of_its_window() {
        let at = parked(PhysicalSize::new(1920, 1080));
        assert_eq!(at, PhysicalPosition::new(-1920 - PARK_GAP, 0));
        // A size no window has still parks somewhere, rather than overflowing.
        assert!(parked(PhysicalSize::new(u32::MAX, 10)).x < 0);
    }
}
