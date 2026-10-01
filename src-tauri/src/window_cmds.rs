use tauri::{LogicalSize, PhysicalPosition, Window};

/// Preferred restore size (logical px) when the monitor is large enough.
pub const IDEAL_RESTORE: (f64, f64) = (1280.0, 800.0);
/// Restored windows fill at most this fraction of the monitor work area.
const WORK_AREA_FILL: f64 = 0.9;

/// Set by the end-to-end harness, and by nothing else.
///
/// There is no headless WebView2 on Windows, so those tests drive a real
/// window. Left alone it maximizes over whatever the person at the keyboard is
/// doing and takes their keystrokes — five times per run, once per spec. In
/// this mode the window is still real and still rendered; it is simply parked
/// off the visible desktop and never asks for focus.
const UNATTENDED_VAR: &str = "AIME_UNATTENDED";

/// Far enough off the desktop to be invisible on any arrangement of monitors,
/// while staying a real, rendered window — the tests need it to paint.
pub const PARKED_AT: (i32, i32) = (-4000, -4000);

pub fn unattended() -> bool {
    std::env::var_os(UNATTENDED_VAR).is_some()
}

/// Fits the window's restore bounds inside the monitor work area (taskbar
/// excluded), then shows it maximized. Fixed logical sizes overflow on scaled
/// displays (125–150 %), which pushed the restored window's bottom under the
/// taskbar — so the size is computed from the actual monitor instead.
pub fn fit_and_maximize(window: &Window) {
    if unattended() {
        park_offscreen(window);
        return;
    }
    match window.current_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let max_w = f64::from(area.size.width) / scale * WORK_AREA_FILL;
            let max_h = f64::from(area.size.height) / scale * WORK_AREA_FILL;
            let size = LogicalSize::new(IDEAL_RESTORE.0.min(max_w), IDEAL_RESTORE.1.min(max_h));
            if let Err(err) = window.set_size(size) {
                eprintln!("[window] set_size failed: {err}");
            }
            if let Err(err) = window.center() {
                eprintln!("[window] center failed: {err}");
            }
        }
        Ok(None) => eprintln!("[window] no monitor detected — keeping configured size"),
        Err(err) => eprintln!("[window] current_monitor failed: {err}"),
    }
    if let Err(err) = show_maximized(window) {
        eprintln!("[window] showing maximized failed: {err}");
    }
    if let Err(err) = window.set_focus() {
        eprintln!("[window] set_focus failed: {err}");
    }
}

/// Shows the window where nobody can see it, and leaves the keyboard alone.
fn park_offscreen(window: &Window) {
    let size = LogicalSize::new(IDEAL_RESTORE.0, IDEAL_RESTORE.1);
    if let Err(err) = window.set_size(size) {
        eprintln!("[window] set_size failed: {err}");
    }
    if let Err(err) = window.set_position(PhysicalPosition::new(PARKED_AT.0, PARKED_AT.1)) {
        eprintln!("[window] set_position failed: {err}");
    }
    // Shown, never focused: a hidden window would stop rendering, and a
    // focused one would take the keystrokes meant for another application.
    if let Err(err) = window.show() {
        eprintln!("[window] show failed: {err}");
    }
}

/// Shows a hidden window maximized, in one step.
///
/// On Windows this goes around tao's `maximize`: tao applies a window's state
/// by replaying it, and a maximized window's replay starts with
/// `ShowWindow(SW_MAXIMIZE)`, so maximizing a hidden window showed it and hid
/// it again before `show` put it up for good - measured 2026-09-26 with a Win32
/// event hook, show-hide-show on every window that appeared.
#[cfg(windows)]
fn show_maximized(window: &Window) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWMAXIMIZED};

    let handle = window.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: the handle belongs to a live window of this process, just
    // handed over by Tauri. The answer is whether it was visible before.
    let _ = unsafe { ShowWindow(handle, SW_SHOWMAXIMIZED) };
    // tao learns a window is visible only through its own `show`. On a window
    // already on screen it changes nothing there, and without it tao would
    // hide the window again at its next change of state.
    window.show().map_err(|e| e.to_string())
}

/// Elsewhere through Tauri's own calls.
#[cfg(not(windows))]
fn show_maximized(window: &Window) -> Result<(), String> {
    window.maximize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())
}
