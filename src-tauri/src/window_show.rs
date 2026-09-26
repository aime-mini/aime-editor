//! Putting a workspace window on screen in one step: maximized when it first
//! appears, or exactly where another stands when it takes that one's place -
//! which is what switching workspace tabs is.
//!
//! On Windows both go around tao's `maximize`, `show` and `hide`. tao applies
//! a window's state by replaying it, and a maximized window's replay starts
//! with `ShowWindow(SW_MAXIMIZE)` - on every change, hiding included. So
//! maximizing a hidden window showed it and hid it again before `show`, and
//! hiding the tab being left brought it back to the front first. Measured
//! 2026-09-26: one tab switch showed the new tab three times (the first at its
//! old, smaller size, so the page laid itself out twice), moved the foreground
//! between the two windows six times and focused each page three times; a
//! window appearing maximized was shown, hidden and shown again.
//!
//! What tao believes stays behind: it still counts a tab hidden here as
//! visible. That is harmless while nothing changes a hidden tab's state
//! through tao, and the next call here shows it the same way.

use tauri::WebviewWindow;

/// Shows a window maximized on the monitor it stands on.
#[cfg(windows)]
pub fn maximized(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWMAXIMIZED};

    let handle = window.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: the handle belongs to a live window of this process, just
    // handed over by Tauri. The answer is whether it was visible before.
    let _ = unsafe { ShowWindow(handle, SW_SHOWMAXIMIZED) };
    record_shown(window)
}

/// Shows `to` where `from` stands, in the same state - maximized on the same
/// monitor, or at its position and size - then hides `from`. `to` is shown
/// first, so the screen never goes without a window in between.
#[cfg(windows)]
pub fn take_place(from: &WebviewWindow, to: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, IsZoomed, SetWindowPlacement, ShowWindow, SW_HIDE, SW_SHOWMAXIMIZED,
        SW_SHOWNORMAL, WINDOWPLACEMENT,
    };

    let leaving = from.hwnd().map_err(|e| e.to_string())?;
    let arriving = to.hwnd().map_err(|e| e.to_string())?;
    let mut placement = WINDOWPLACEMENT {
        length: u32::try_from(std::mem::size_of::<WINDOWPLACEMENT>()).map_err(|e| e.to_string())?,
        ..WINDOWPLACEMENT::default()
    };
    // SAFETY: both handles belong to live windows of this process (Tauri just
    // handed them over), and `placement` carries the size the API checks.
    let swapped = without_transitions(&[leaving, arriving], || unsafe {
        GetWindowPlacement(leaving, &raw mut placement).map_err(|e| e.to_string())?;
        let shown_as = if IsZoomed(leaving).as_bool() {
            SW_SHOWMAXIMIZED
        } else {
            SW_SHOWNORMAL
        };
        placement.showCmd = shown_as.0.unsigned_abs();
        SetWindowPlacement(arriving, &raw const placement).map_err(|e| e.to_string())?;
        // The answer is whether the window was visible before, not an error.
        let _ = ShowWindow(leaving, SW_HIDE);
        Ok::<(), String>(())
    });
    swapped?;
    record_shown(to)
}

/// Puts `to` on screen directly beneath `from`, covering exactly what `from`
/// covers and without taking the focus, so it draws its first frames where
/// nobody sees them; `take_place` then lifts it over `from`.
///
/// A window Windows has never drawn, shown straight over another, came up at
/// its restored size with an empty page before it filled in - measured
/// 2026-09-26 in a screen recording, the desktop showing through for a frame
/// or two, which read as the app closing and opening again.
#[cfg(windows)]
pub fn beneath(from: &WebviewWindow, to: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    };

    let above = from.hwnd().map_err(|e| e.to_string())?;
    let below = to.hwnd().map_err(|e| e.to_string())?;
    let mut covers = RECT::default();
    // SAFETY: both handles belong to live windows of this process, and the
    // rectangle is written by the call into memory it owns.
    unsafe { GetWindowRect(above, &raw mut covers) }.map_err(|e| e.to_string())?;
    without_transitions(&[below], || unsafe {
        SetWindowPos(
            below,
            Some(above),
            covers.left,
            covers.top,
            covers.right - covers.left,
            covers.bottom - covers.top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    })
    .map_err(|e| e.to_string())
}

/// Takes a window put `beneath` another off the screen again - the tab it was
/// to replace is no longer the one showing.
#[cfg(windows)]
pub fn withdraw(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    let handle = window.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: a live window of this process. The answer is whether it was
    // visible before, not an error.
    without_transitions(&[handle], || {
        let _ = unsafe { ShowWindow(handle, SW_HIDE) };
    });
    Ok(())
}

/// Runs `swap` with the desktop's show and hide animations off for these
/// windows, and puts them back after.
///
/// Windows animates a window appearing (it grows and fades in) and one going
/// away (it shrinks into the middle). Reported 2026-09-26 with the swap
/// already one step - *"vẫn còn hiệu ứng cửa sổ mở, nhìn thấy rất rõ"* - and
/// seen in a screen recording: the tab left shrinking away over the one
/// arriving. Switching tabs is not a window opening, so for the swap alone
/// there is none; minimizing and restoring the window keep theirs.
#[cfg(windows)]
fn without_transitions<T>(handles: &[windows::Win32::Foundation::HWND], swap: impl FnOnce() -> T) -> T {
    set_transitions(handles, false);
    let result = swap();
    set_transitions(handles, true);
    result
}

#[cfg(windows)]
fn set_transitions(handles: &[windows::Win32::Foundation::HWND], enabled: bool) {
    use windows::core::BOOL;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};

    let disabled = BOOL::from(!enabled);
    for &handle in handles {
        // SAFETY: a live window of this process, and a BOOL is what this
        // attribute takes, passed with its own size.
        let set = unsafe {
            DwmSetWindowAttribute(
                handle,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                (&raw const disabled).cast(),
                std::mem::size_of::<BOOL>() as u32,
            )
        };
        if let Err(err) = set {
            // The swap still happens; only its animation is left as Windows has it.
            eprintln!("[window] could not set the show/hide animation: {err}");
        }
    }
}

/// tao learns a window is visible only through its own `show`. On a window
/// already on screen it changes nothing there, and without it tao would hide
/// the window again at its next change of state.
#[cfg(windows)]
fn record_shown(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

/// Elsewhere a window is not staged: `take_place` shows it as it is.
#[cfg(not(windows))]
pub fn beneath(_from: &WebviewWindow, _to: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Elsewhere nothing was put on screen by `beneath`, so nothing is taken off.
#[cfg(not(windows))]
pub fn withdraw(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Elsewhere through Tauri's own calls.
#[cfg(not(windows))]
pub fn maximized(window: &WebviewWindow) -> Result<(), String> {
    window.maximize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())
}

/// Elsewhere through Tauri's own calls.
#[cfg(not(windows))]
pub fn take_place(from: &WebviewWindow, to: &WebviewWindow) -> Result<(), String> {
    let position = from.outer_position().map_err(|e| e.to_string())?;
    to.set_position(position).map_err(|e| e.to_string())?;
    if from.is_maximized().map_err(|e| e.to_string())? {
        to.maximize().map_err(|e| e.to_string())?;
    } else {
        to.set_size(from.outer_size().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    to.show().map_err(|e| e.to_string())?;
    to.set_focus().map_err(|e| e.to_string())?;
    from.hide().map_err(|e| e.to_string())
}
