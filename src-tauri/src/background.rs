//! Work a command must not do on the main thread.
//!
//! Tauri runs a synchronous command on the main thread, which is also the
//! thread that pumps the window's messages and dispatches every other IPC call.
//! A command that walks a project or starts a process there freezes the whole
//! app for as long as it takes: `dap_targets` on a cold twenty-project .NET
//! repository took 5.5 s (measured), and a call sent meanwhile waited
//! for all of it. Such commands are `async` and hand their work to the blocking
//! pool through [`off_main_thread`].

/// Runs `work` on the blocking thread pool, without holding a thread of the
/// async runtime while it waits.
pub async fn off_main_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| format!("background work did not finish: {err}"))
}
