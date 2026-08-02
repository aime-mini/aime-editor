use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, LogicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Preferred restore size (logical px) when the monitor is large enough.
const IDEAL_RESTORE: (f64, f64) = (1280.0, 800.0);
/// Restored windows fill at most this fraction of the monitor work area.
const WORK_AREA_FILL: f64 = 0.9;

/// Fits the window's restore bounds inside the monitor work area (taskbar
/// excluded), maximizes, then shows. Fixed logical sizes overflow on scaled
/// displays (125–150 %), which pushed the restored window's bottom under the
/// taskbar — so the size is computed from the actual monitor instead.
pub fn fit_and_maximize(window: &WebviewWindow) {
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
    if let Err(err) = window.maximize() {
        eprintln!("[window] maximize failed: {err}");
    }
    if let Err(err) = window.show() {
        eprintln!("[window] show failed: {err}");
    }
    if let Err(err) = window.set_focus() {
        eprintln!("[window] set_focus failed: {err}");
    }
}

/// Opens a new editor window — each window is an independent workspace
/// (frontend state is isolated per webview; AI events are filtered by run_id).
#[tauri::command]
pub async fn open_new_window(app: AppHandle) -> Result<(), String> {
    let label = format!("editor-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));
    // Created hidden; fit_and_maximize sizes it to the monitor and shows it.
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Aime - AI Mini Editor")
        .inner_size(IDEAL_RESTORE.0, IDEAL_RESTORE.1)
        .min_inner_size(960.0, 600.0)
        .visible(false)
        // Tauri's native drag-drop handler swallows HTML5 drag events on
        // Windows — disabled so in-app DnD (file tree moves) works.
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    fit_and_maximize(&window);
    Ok(())
}
