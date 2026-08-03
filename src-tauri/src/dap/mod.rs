//! Debug adapters (ARCHITECTURE.md §5). Aime speaks DAP to the same adapters
//! VS Code uses, so it can debug real programs without implementing a single
//! debugger. Like `lsp`, this module is only the transport: it starts an
//! adapter, frames messages both ways and relays JSON to the window that owns
//! it — protocol semantics live on the frontend, next to Monaco.
//!
//! Two measured facts about DAP make this more than a copy of `lsp`
//! (js-debug 1.117.0, driven end to end on 2026-08-03):
//!
//! * adapters differ in how they are reached. Most speak over their own
//!   stdin/stdout; js-debug is a TCP server that prints the address it bound
//!   to and expects clients to dial in.
//! * one debug run needs **several connections**. js-debug answers `launch`
//!   with a `startDebugging` reverse request, asking the client to open a
//!   second DAP session for the process that actually runs the user's code.
//!   So a running adapter owns a set of connections, not one — which is why
//!   `dap_start` and `dap_connect` are separate commands.

pub mod catalog;

use crate::wire::{frame, read_message};
use catalog::{spec_for, Transport};
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

static ADAPTER_COUNTER: AtomicU64 = AtomicU64::new(1);
static CONNECTION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// One JSON message from an adapter, relayed verbatim.
const MESSAGE_EVENT: &str = "dap:message";
/// One connection reached the end of its stream.
const CLOSED_EVENT: &str = "dap:closed";
/// The adapter process ended — every connection on it is gone with it.
const EXIT_EVENT: &str = "dap:exit";

/// How long a TCP adapter has to announce its address before Aime gives up.
/// Generous on purpose: the first start also pays Node's own boot time, and a
/// debugger that fails because a laptop was busy would be worse than a slow one.
const LISTEN_TIMEOUT: Duration = Duration::from_secs(20);

/// A live adapter process.
struct AdapterProcess {
    /// Ends the reaper task, which kills the process.
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    /// Where further connections go; `None` for stdio adapters, which have
    /// exactly one connection and no way to accept another.
    address: Option<SocketAddr>,
    window_label: String,
}

/// One DAP conversation with an adapter.
struct Connection {
    adapter_id: u64,
    /// Messages queued for the adapter; a writer task owns the pipe or socket.
    outgoing: UnboundedSender<String>,
    /// Ends the reader task.
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct DapState {
    adapters: Mutex<HashMap<u64, AdapterProcess>>,
    connections: Mutex<HashMap<u64, Connection>>,
}

impl DapState {
    /// A poisoned lock still holds valid data — recover it instead of panicking.
    fn adapters(&self) -> MutexGuard<'_, HashMap<u64, AdapterProcess>> {
        self.adapters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn connections(&self) -> MutexGuard<'_, HashMap<u64, Connection>> {
        self.connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessagePayload {
    connection_id: u64,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionPayload {
    connection_id: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterPayload {
    adapter_id: u64,
}

/// A started adapter, and the first connection to it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedAdapter {
    pub adapter_id: u64,
    pub connection_id: u64,
    /// Whether this adapter can take further connections — the frontend needs
    /// to know before it honours a `startDebugging` request.
    pub supports_child_sessions: bool,
}

/// Builds a process for a debug adapter.
///
/// Deliberately *not* `providers::cli_command`, which wraps everything in
/// `cmd /C` so that npm's `.cmd` shims can be run. Debug adapters are real
/// executables (`node`, `python`), and that wrapper would cost two things a
/// debugger cannot afford: killing the session would kill `cmd` and leave the
/// adapter — and the program it is debugging — running unattended, and on
/// Windows the extra shell was measured to swallow the adapter's stdout, which
/// is where a TCP adapter announces its address.
pub(crate) fn adapter_command<I, S>(program: &str, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// Reads the address a TCP adapter bound to out of one of its output lines.
///
/// js-debug prints `Debug server listening at 127.0.0.1:52413`, so the rule is
/// "the last word of a line, if it parses as an address". Deliberately not a
/// match on js-debug's wording: the shape of the announcement is the stable
/// part, its prose is not.
fn announced_address(line: &str) -> Option<SocketAddr> {
    line.split_whitespace().last()?.parse().ok()
}

/// Waits for a TCP adapter to say where it is listening, keeping everything it
/// printed. An adapter that dies during startup explains itself in that output,
/// so the text is carried into the error rather than dropped.
async fn wait_for_address(child: &mut Child) -> Result<SocketAddr, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture the adapter's output")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut transcript = String::new();

    let found = tokio::time::timeout(LISTEN_TIMEOUT, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(address) = announced_address(&line) {
                return Some(address);
            }
            transcript.push_str(&line);
            transcript.push('\n');
        }
        None
    })
    .await;

    match found {
        Ok(Some(address)) => Ok(address),
        Ok(None) => Err(format!(
            "The debug adapter stopped before it was ready.\n{}",
            transcript.trim()
        )),
        Err(_) => Err(format!(
            "The debug adapter did not report an address within {} s.\n{}",
            LISTEN_TIMEOUT.as_secs(),
            transcript.trim()
        )),
    }
}

/// Starts the debug adapter for a language and opens the first DAP connection
/// to it. Returns the ids used by every other command here.
#[tauri::command]
pub async fn dap_start(
    app: AppHandle,
    window: Window,
    state: State<'_, DapState>,
    language_id: String,
    root: String,
) -> Result<StartedAdapter, String> {
    let spec = spec_for(&language_id).ok_or_else(|| format!("No debug adapter for {language_id}"))?;
    let command = spec.resolved_command(&app)?;

    let mut child = adapter_command(&command.program, &command.args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // adapters log verbosely; their DAP traffic is what matters
        .spawn()
        .map_err(|e| format!("DAP_MISSING::{}::{e}", spec.id))?;

    let adapter_id = ADAPTER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();

    // Until the reaper below is armed, nothing else would ever kill this
    // process — so a failure while reaching it has to clean up after itself.
    let (address, connection_id) = match reach(&app, &label, adapter_id, spec.transport, &mut child).await {
        Ok(reached) => reached,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };

    // Reaper task: one place that kills the process, whether the user stopped
    // the session or the adapter died on its own.
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let app = app.clone();
        let label = label.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                _ = shutdown_rx => { let _ = child.kill().await; }
                _ = child.wait() => {}
            }
            if let Some(state) = app.try_state::<DapState>() {
                state.adapters().remove(&adapter_id);
                state
                    .connections()
                    .retain(|_, connection| connection.adapter_id != adapter_id);
            }
            let _ = app.emit_to(&label, EXIT_EVENT, AdapterPayload { adapter_id });
        });
    }

    state.adapters().insert(
        adapter_id,
        AdapterProcess {
            shutdown: Some(shutdown),
            address,
            window_label: label,
        },
    );

    Ok(StartedAdapter {
        adapter_id,
        connection_id,
        supports_child_sessions: address.is_some(),
    })
}

/// Opens an additional connection to a running adapter — what js-debug's
/// `startDebugging` reverse request asks for. Only TCP adapters can do this;
/// a stdio adapter has one pair of pipes and nothing to dial.
#[tauri::command]
pub async fn dap_connect(app: AppHandle, state: State<'_, DapState>, adapter_id: u64) -> Result<u64, String> {
    let (address, label) = {
        let adapters = state.adapters();
        let adapter = adapters
            .get(&adapter_id)
            .ok_or_else(|| format!("debug adapter {adapter_id} is not running"))?;
        let address = adapter
            .address
            .ok_or("this debug adapter serves a single session")?;
        (address, adapter.window_label.clone())
    };
    open_tcp_connection(&app, &label, adapter_id, address).await
}

/// Wires a connection's two halves to the frontend: a writer task owning the
/// sink so senders never block, and a reader task relaying framed messages.
fn register_connection<W, R>(
    app: &AppHandle,
    window_label: &str,
    adapter_id: u64,
    mut sink: W,
    source: R,
) -> u64
where
    W: AsyncWrite + Unpin + Send + 'static,
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let connection_id = CONNECTION_COUNTER.fetch_add(1, Ordering::Relaxed);

    let (outgoing, mut queue) = unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = queue.recv().await {
            if sink.write_all(frame(&message).as_bytes()).await.is_err() {
                break;
            }
            let _ = sink.flush().await;
        }
    });

    let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let app = app.clone();
        let label = window_label.to_string();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(source);
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    message = read_message(&mut reader) => match message {
                        Ok(Some(message)) => {
                            let payload = MessagePayload { connection_id, message };
                            if app.emit_to(&label, MESSAGE_EVENT, payload).is_err() {
                                break;
                            }
                        }
                        _ => break,
                    },
                }
            }
            if let Some(state) = app.try_state::<DapState>() {
                state.connections().remove(&connection_id);
            }
            let _ = app.emit_to(&label, CLOSED_EVENT, ConnectionPayload { connection_id });
        });
    }

    if let Some(state) = app.try_state::<DapState>() {
        state.connections().insert(
            connection_id,
            Connection {
                adapter_id,
                outgoing,
                shutdown: Some(shutdown),
            },
        );
    }
    connection_id
}

/// Opens the first connection to a freshly spawned adapter, whichever way it
/// speaks. The address comes back too: it is what lets further sessions be
/// opened later, and stdio adapters have none.
async fn reach(
    app: &AppHandle,
    window_label: &str,
    adapter_id: u64,
    transport: Transport,
    child: &mut Child,
) -> Result<(Option<SocketAddr>, u64), String> {
    match transport {
        Transport::Stdio => Ok((None, open_stdio_connection(app, window_label, adapter_id, child)?)),
        Transport::TcpServer => {
            let address = wait_for_address(child).await?;
            let connection_id = open_tcp_connection(app, window_label, adapter_id, address).await?;
            Ok((Some(address), connection_id))
        }
    }
}

async fn open_tcp_connection(
    app: &AppHandle,
    window_label: &str,
    adapter_id: u64,
    address: SocketAddr,
) -> Result<u64, String> {
    let stream = tokio::net::TcpStream::connect(address)
        .await
        .map_err(|e| format!("Could not reach the debug adapter at {address}: {e}"))?;
    // Debug stepping is a request/response ping-pong; Nagle's algorithm would
    // add a delay to every single step.
    let _ = stream.set_nodelay(true);
    let (source, sink) = stream.into_split();
    Ok(register_connection(app, window_label, adapter_id, sink, source))
}

fn open_stdio_connection(
    app: &AppHandle,
    window_label: &str,
    adapter_id: u64,
    child: &mut Child,
) -> Result<u64, String> {
    let sink = child
        .stdin
        .take()
        .ok_or("Failed to capture the adapter's input")?;
    let source = child
        .stdout
        .take()
        .ok_or("Failed to capture the adapter's output")?;
    Ok(register_connection(app, window_label, adapter_id, sink, source))
}

/// Forwards one DAP message to a connection.
#[tauri::command]
pub fn dap_send(state: State<'_, DapState>, connection_id: u64, message: String) -> Result<(), String> {
    let connections = state.connections();
    let connection = connections
        .get(&connection_id)
        .ok_or_else(|| format!("debug session {connection_id} is not running"))?;
    connection
        .outgoing
        .send(message)
        .map_err(|_| "the debug session ended".to_string())
}

/// Stops an adapter and every connection on it; the reaper task then emits
/// `dap:exit`.
#[tauri::command]
pub fn dap_stop(state: State<'_, DapState>, adapter_id: u64) -> Result<(), String> {
    close_connections_of(&state, |connection| connection.adapter_id == adapter_id);
    if let Some(mut adapter) = state.adapters().remove(&adapter_id) {
        if let Some(shutdown) = adapter.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    Ok(())
}

/// Ends the connections a predicate selects, leaving the adapter running —
/// js-debug outlives its child sessions.
fn close_connections_of(state: &DapState, matches: impl Fn(&Connection) -> bool) {
    let mut connections = state.connections();
    connections.retain(|_, connection| {
        if matches(connection) {
            if let Some(shutdown) = connection.shutdown.take() {
                let _ = shutdown.send(());
            }
            false
        } else {
            true
        }
    });
}

/// Stops every adapter owned by a window; called when that window is destroyed.
/// A debuggee outliving the window that started it would be invisible and
/// unstoppable, so this is not optional cleanup.
pub fn stop_for_window(window: &Window) {
    let state = window.state::<DapState>();
    let doomed: Vec<u64> = {
        let adapters = state.adapters();
        adapters
            .iter()
            .filter(|(_, adapter)| adapter.window_label == window.label())
            .map(|(id, _)| *id)
            .collect()
    };
    for adapter_id in doomed {
        close_connections_of(&state, |connection| connection.adapter_id == adapter_id);
        if let Some(mut adapter) = state.adapters().remove(&adapter_id) {
            if let Some(shutdown) = adapter.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{announced_address, wait_for_address};

    #[test]
    fn the_address_is_the_last_word_of_the_announcement() {
        // Measured verbatim from js-debug 1.117.0.
        assert_eq!(
            announced_address("Debug server listening at 127.0.0.1:52413")
                .expect("an address")
                .to_string(),
            "127.0.0.1:52413"
        );
    }

    #[test]
    fn ipv6_is_understood_too() {
        // What js-debug binds when no host is given — Aime asks for IPv4, but
        // reading only one family would be a trap for the next adapter.
        assert!(announced_address("Debug server listening at [::1]:8123").is_some());
    }

    #[test]
    fn ordinary_log_lines_are_not_mistaken_for_an_address() {
        for line in [
            "Starting up",
            "",
            "Error: cannot find module 'js-debug'",
            "listening at localhost:8123", // a name, not an address: unusable for connect()
        ] {
            assert!(announced_address(line).is_none(), "{line} is not an address");
        }
    }

    /// Drives a real js-debug through the exact path `dap_start` uses — spawn,
    /// read the announced address, dial in, exchange one framed request — so
    /// the glue is proven against the adapter rather than against a fixture.
    ///
    /// Skipped unless `AIME_JS_DEBUG` points at a `dapDebugServer.js`, because
    /// the archive is downloaded at runtime and CI has none. To run it:
    /// `AIME_JS_DEBUG=<path> cargo test js_debug -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs a downloaded js-debug; see the doc comment"]
    async fn js_debug_answers_an_initialize_sent_through_our_own_transport() {
        use crate::wire::{frame, read_message};
        use tokio::io::{AsyncWriteExt, BufReader};

        let Ok(script) = std::env::var("AIME_JS_DEBUG") else {
            panic!("set AIME_JS_DEBUG to a dapDebugServer.js");
        };
        let mut child = super::adapter_command("node", [&script, "0", "127.0.0.1"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("js-debug starts");

        let address = wait_for_address(&mut child).await.expect("an address");
        let stream = tokio::net::TcpStream::connect(address)
            .await
            .expect("the adapter accepts connections");
        let (source, mut sink) = stream.into_split();

        let request =
            r#"{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"pwa-node"}}"#;
        sink.write_all(frame(request).as_bytes())
            .await
            .expect("request sent");

        let mut reader = BufReader::new(source);
        let reply = read_message(&mut reader)
            .await
            .expect("a readable reply")
            .expect("not EOF");
        let _ = child.kill().await;

        let parsed: serde_json::Value = serde_json::from_str(&reply).expect("valid JSON");
        assert_eq!(parsed["type"], "response");
        assert_eq!(parsed["command"], "initialize");
        assert_eq!(parsed["success"], true);
        assert_eq!(
            parsed["body"]["supportsConfigurationDoneRequest"], true,
            "js-debug must announce the capability the session flow depends on"
        );
    }
}
