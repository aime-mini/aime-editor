use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Window};

static TERM_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Raw PTY output chunk; bytes (not text) so multibyte sequences split across
/// reads survive — xterm.js decodes them on the frontend.
const DATA_EVENT: &str = "term:data";
const EXIT_EVENT: &str = "term:exit";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    window_label: String,
}

/// Live PTY sessions keyed by terminal id.
#[derive(Default)]
pub struct TerminalState(Mutex<HashMap<u64, Session>>);

impl TerminalState {
    /// A poisoned lock still holds valid data — recover it instead of panicking.
    fn sessions(&self) -> MutexGuard<'_, HashMap<u64, Session>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Serialize)]
struct DataPayload {
    term_id: u64,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    term_id: u64,
}

fn default_shell() -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "bash".into()))
    }
}

/// Spawns a shell in a new PTY and streams its output to the calling window
/// as `term:data` events; `term:exit` follows when the shell ends.
#[tauri::command]
pub fn term_create(
    app: AppHandle,
    window: Window,
    state: State<'_, TerminalState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let pty = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut shell = default_shell();
    shell.cwd(&cwd);
    let mut child = pty.slave.spawn_command(shell).map_err(|e| e.to_string())?;
    drop(pty.slave); // the child owns its end now

    let term_id = TERM_COUNTER.fetch_add(1, Ordering::Relaxed);
    let killer = child.clone_killer();
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let label = window.label().to_string();

    // Reader thread: pump PTY output to the owning window until the shell exits.
    {
        let app = app.clone();
        let label = label.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let payload = DataPayload {
                            term_id,
                            data: buf[..n].to_vec(),
                        };
                        if app.emit_to(&label, DATA_EVENT, payload).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = child.wait(); // reap the process
            if let Some(state) = app.try_state::<TerminalState>() {
                state.sessions().remove(&term_id);
            }
            let _ = app.emit_to(&label, EXIT_EVENT, ExitPayload { term_id });
        });
    }

    state.sessions().insert(
        term_id,
        Session {
            master: pty.master,
            writer,
            killer,
            window_label: label,
        },
    );
    Ok(term_id)
}

/// Forwards user keystrokes (already encoded by xterm.js) to the shell.
#[tauri::command]
pub fn term_write(state: State<'_, TerminalState>, term_id: u64, data: String) -> Result<(), String> {
    let mut sessions = state.sessions();
    let session = sessions
        .get_mut(&term_id)
        .ok_or_else(|| format!("terminal {term_id} not found"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(
    state: State<'_, TerminalState>,
    term_id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions();
    let session = sessions
        .get(&term_id)
        .ok_or_else(|| format!("terminal {term_id} not found"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Kills the shell; the reader thread then observes EOF and emits `term:exit`.
#[tauri::command]
pub fn term_kill(state: State<'_, TerminalState>, term_id: u64) -> Result<(), String> {
    if let Some(mut session) = state.sessions().remove(&term_id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Stops every terminal owned by a window; called when that window is destroyed.
pub fn kill_for_window(window: &Window) {
    let state = window.state::<TerminalState>();
    let mut sessions = state.sessions();
    sessions.retain(|_, session| {
        if session.window_label == window.label() {
            let _ = session.killer.kill();
            false
        } else {
            true
        }
    });
}
