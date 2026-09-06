//! Running a command and answering with what it actually said.
//!
//! Aime could already run a task, but only by opening a terminal tab: the PTY
//! reports the *shell's* exit, not the task's, so `tasks/mod.rs` appends a
//! `[aime] exit code:` line and reads the number back out of the ANSI stream.
//! That is the right shape for a button a person pressed — they want to watch
//! it, and the tab is the point.
//!
//! It is the wrong shape for a check. A gate that decides whether a change may
//! proceed cannot rest on a line of printed text: closing the tab loses the
//! answer, a program that happens to print the marker confuses the reader, and
//! nothing can run unattended without opening tabs nobody asked for. So this
//! module does the plain thing — spawn, capture both streams, wait, and hand
//! back the real exit status of the real process.
//!
//! Output is also streamed as `exec:output` while it arrives, because a test
//! suite that takes four minutes must not look like a hang.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

/// How much of one stream is kept. Output past this is dropped from the
/// *front*: a failing run explains itself at the end, and a build that printed
/// forty megabytes of progress has nothing to say in its first line.
const CAPTURE_LIMIT: usize = 256 * 1024;

/// Nothing runs forever unattended. Callers narrow this; it is the ceiling.
const MAX_TIMEOUT_MS: u64 = 30 * 60 * 1000;

/// How long a killed command is given to let go of its pipes before the
/// capture is returned without it. A deadline that can itself be outwaited is
/// not a deadline, and one stuck grandchild must not hang the whole run.
const PIPE_GRACE_MS: u64 = 2_000;

/// One line of a running command, on its way to whoever is watching.
#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    /// `"stdout"` or `"stderr"` — a reader wants to tell them apart.
    stream: &'static str,
    line: String,
}

/// What a finished command has to say for itself.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    /// The process's own exit status; `None` when it was killed rather than
    /// allowed to finish, which the two flags below then explain.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub cancelled: bool,
    /// True when output was dropped to stay inside `CAPTURE_LIMIT`, so nothing
    /// mistakes a clipped log for the whole of one.
    pub clipped: bool,
}

/// One stream as it fills up.
///
/// The buffer is shared rather than owned by the reading task, so a command
/// that had to be killed still reports what it printed before it hung — which
/// is the only part of a hung build anybody wants to read.
#[derive(Default)]
struct Capture {
    text: Mutex<String>,
    clipped: AtomicBool,
}

impl Capture {
    fn push(&self, line: &str) {
        let Ok(mut text) = self.text.lock() else {
            return;
        };
        text.push_str(line);
        text.push('\n');
        if text.len() > CAPTURE_LIMIT {
            self.clipped.store(true, Ordering::Relaxed);
            let cut = drop_point(&text, text.len() - CAPTURE_LIMIT);
            text.drain(..cut);
        }
    }

    fn take(&self) -> (String, bool) {
        let text = self.text.lock().map(|text| text.clone()).unwrap_or_default();
        (text, self.clipped.load(Ordering::Relaxed))
    }
}

/// The commands running right now, each with the handle that ends it.
#[derive(Default)]
pub struct ExecState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

/// Runs one command line through the platform shell and waits for it.
///
/// The id comes from the caller rather than being handed back, which is what
/// makes cancelling race-free: this call only returns once the process is over,
/// so an id invented here could never reach anyone in time to stop it.
#[tauri::command]
pub async fn exec_run(
    app: AppHandle,
    state: State<'_, ExecState>,
    id: String,
    command: String,
    cwd: String,
    timeout_ms: Option<u64>,
) -> Result<CommandOutcome, String> {
    if command.trim().is_empty() {
        return Err("no command to run".into());
    }
    run_registered(
        &app,
        &state,
        &id,
        &command,
        shell_command(&command),
        &cwd,
        timeout_ms,
    )
    .await
}

/// Runs one program with its own arguments and no shell in between.
///
/// For a caller inside the crate that has resolved the program and vetted every
/// argument itself - the cloud deploy runs `gcloud` this way, so a value can
/// never be re-read by a shell as structure. Same id registry, same
/// `exec:output` stream, same `exec_cancel` as `exec_run`: the frontend treats
/// the two alike.
pub(crate) async fn run_program(
    app: &AppHandle,
    state: &ExecState,
    id: &str,
    label: &str,
    program: Command,
    cwd: &str,
    timeout_ms: Option<u64>,
) -> Result<CommandOutcome, String> {
    run_registered(app, state, id, label, program, cwd, timeout_ms).await
}

/// The shared middle of `exec_run` and `run_program`: registered for cancel,
/// streamed as `exec:output`, held to the ceiling.
async fn run_registered(
    app: &AppHandle,
    state: &ExecState,
    id: &str,
    label: &str,
    command: Command,
    cwd: &str,
    timeout_ms: Option<u64>,
) -> Result<CommandOutcome, String> {
    let (kill_tx, kill_rx) = oneshot::channel();
    register(state, id, kill_tx);

    let emitting = {
        let app = app.clone();
        let id = id.to_string();
        move |stream: &'static str, line: &str| {
            let _ = app.emit(
                "exec:output",
                OutputEvent {
                    id: id.clone(),
                    stream,
                    line: line.to_string(),
                },
            );
        }
    };

    let outcome = run_child(
        label,
        command,
        cwd,
        timeout_ms.unwrap_or(MAX_TIMEOUT_MS).min(MAX_TIMEOUT_MS),
        kill_rx,
        emitting,
    )
    .await;

    forget(state, id);
    outcome
}

/// Ends a running command. An unknown id is not an error: the command may have
/// finished a moment before the click.
#[tauri::command]
pub fn exec_cancel(state: State<'_, ExecState>, id: String) {
    if let Some(kill) = state.running.lock().ok().and_then(|mut map| map.remove(&id)) {
        let _ = kill.send(());
    }
}

/// `run_child` for a command line, so the behaviour that matters can be tested
/// against real processes without an `AppHandle`: emitting is the only part
/// that needs one, and it is the least interesting part.
#[cfg(test)]
async fn run_capturing<Sink>(
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    kill_rx: oneshot::Receiver<()>,
    sink: Sink,
) -> Result<CommandOutcome, String>
where
    Sink: Fn(&'static str, &str) + Send + 'static,
{
    if command.trim().is_empty() {
        return Err("no command to run".into());
    }
    run_child(command, shell_command(command), cwd, timeout_ms, kill_rx, sink).await
}

/// Spawns a prepared command, streams both pipes, and answers with its real
/// exit status. `label` is what the command is called in an error: the command
/// line for a shell run, the program and its arguments for a direct one.
async fn run_child<Sink>(
    label: &str,
    mut command: Command,
    cwd: &str,
    timeout_ms: u64,
    kill_rx: oneshot::Receiver<()>,
    sink: Sink,
) -> Result<CommandOutcome, String>
where
    Sink: Fn(&'static str, &str) + Send + 'static,
{
    let started = Instant::now();
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("could not run `{label}` in {cwd}: {error}"))?;

    // One channel for both streams, drained by a task of its own, so a line is
    // handed on the moment it arrives instead of at the end of the run.
    let (lines_tx, mut lines_rx) = mpsc::unbounded_channel::<(&'static str, String)>();
    let watching = tokio::spawn(async move {
        while let Some((stream, line)) = lines_rx.recv().await {
            sink(stream, &line);
        }
    });

    let captured = (Arc::new(Capture::default()), Arc::new(Capture::default()));
    let out = drain(
        child.stdout.take(),
        "stdout",
        lines_tx.clone(),
        Arc::clone(&captured.0),
    );
    let err = drain(child.stderr.take(), "stderr", lines_tx, Arc::clone(&captured.1));

    let ending = wait_for_end(&mut child, kill_rx, timeout_ms).await;
    // A finished command has closed its pipes, so the drains are already over.
    // A killed one may not have: killing the shell does not always take the
    // program it launched with it, and that grandchild holds the pipe open.
    // Waiting on it would let a command outlast the deadline meant to stop it,
    // so the drains get a grace period and then the capture is read as it
    // stands — the buffers are shared, so nothing printed is lost.
    let draining = async { tokio::join!(out, err) };
    let _ = tokio::time::timeout(Duration::from_millis(PIPE_GRACE_MS), draining).await;
    let _ = tokio::time::timeout(Duration::from_millis(PIPE_GRACE_MS), watching).await;

    let (stdout, out_clipped) = captured.0.take();
    let (stderr, err_clipped) = captured.1.take();
    Ok(CommandOutcome {
        code: ending.code,
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out: ending.timed_out,
        cancelled: ending.cancelled,
        clipped: out_clipped || err_clipped,
    })
}

/// How a command stopped.
struct Ending {
    code: Option<i32>,
    timed_out: bool,
    cancelled: bool,
}

/// Waits for whichever comes first: the process, the clock, or a cancel.
async fn wait_for_end(child: &mut Child, kill_rx: oneshot::Receiver<()>, timeout_ms: u64) -> Ending {
    // Read before anything can end it; a finished child no longer has one.
    let pid = child.id();
    tokio::select! {
        status = child.wait() => Ending {
            code: status.ok().and_then(|status| status.code()),
            timed_out: false,
            cancelled: false,
        },
        () = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            end_tree(child, pid).await;
            Ending { code: None, timed_out: true, cancelled: false }
        }
        _ = kill_rx => {
            end_tree(child, pid).await;
            Ending { code: None, timed_out: false, cancelled: true }
        }
    }
}

/// Ends the command *and what it started*.
///
/// The command runs through a shell, so the program doing the work is a
/// grandchild: killing the shell alone leaves `npm test` running, still holding
/// the pipes and still eating the machine. Measured on Windows — a 300 ms
/// deadline over `ping -n 61` returned after 61 s, because the shell died and
/// ping did not.
async fn end_tree(child: &mut Child, pid: Option<u32>) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        // /T takes the tree, /F does not ask. Failure is fine: the process may
        // have ended between the deadline and here.
        let mut kill = Command::new("taskkill");
        kill.args(["/T", "/F", "/PID", &pid.to_string()]);
        kill.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let _ = kill.output().await;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
    let _ = child.kill().await;
}

/// Drains one stream into its shared capture, passing each line on as it
/// arrives so a watcher sees the run rather than its summary.
fn drain<R>(
    stream: Option<R>,
    name: &'static str,
    lines_tx: mpsc::UnboundedSender<(&'static str, String)>,
    capture: Arc<Capture>,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let Some(stream) = stream else {
            return;
        };
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            capture.push(&line);
            let _ = lines_tx.send((name, line));
        }
    })
}

/// Where to cut the front of a capture: at `wanted` bytes, or the next
/// character boundary after it — cutting mid-character would panic, and a log
/// full of UTF-8 is the normal case, not the exotic one.
fn drop_point(text: &str, wanted: usize) -> usize {
    text.char_indices()
        .map(|(at, _)| at)
        .find(|at| *at >= wanted)
        .unwrap_or(text.len())
}

fn register(state: &ExecState, id: &str, kill: oneshot::Sender<()>) {
    if let Ok(mut running) = state.running.lock() {
        running.insert(id.to_string(), kill);
    }
}

fn forget(state: &ExecState, id: &str) {
    if let Ok(mut running) = state.running.lock() {
        running.remove(id);
    }
}

/// A command *line* needs a shell: the task runner produces things like
/// `dotnet test "Some Project.csproj"` and `npm test`, where the quoting and
/// the `.cmd` shims are the shell's job. `cmd /C` on Windows for the same
/// reason `providers::cli_command` uses it, `sh -c` elsewhere.
fn shell_command(command: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut shell = Command::new("cmd");
        shell.arg("/C").arg(command);
        shell.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        shell
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut shell = Command::new("sh");
        shell.arg("-c").arg(command);
        shell
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    /// A command line that works on both shells this runs under.
    fn say(text: &str) -> String {
        format!("echo {text}")
    }

    /// Runs with no cancel handle and no interest in the lines.
    async fn run(command: &str, timeout_ms: u64) -> CommandOutcome {
        let (_tx, rx) = oneshot::channel();
        run_capturing(command, ".", timeout_ms, rx, |_, _| {})
            .await
            .expect("the command should have started")
    }

    #[tokio::test]
    async fn an_exit_code_is_the_process_s_own_not_a_printed_line() {
        let ok = run(&say("hello"), 10_000).await;
        assert_eq!(ok.code, Some(0));
        assert!(ok.code == Some(0));
        assert!(ok.stdout.contains("hello"), "stdout was {:?}", ok.stdout);
        assert!(!ok.timed_out && !ok.cancelled);

        // The whole point of this module: a real non-zero status, read from the
        // process, with nothing printed into the output to say so.
        let failed = run("exit 3", 10_000).await;
        assert_eq!(failed.code, Some(3));
        assert!(failed.code != Some(0));
        assert!(
            !failed.stdout.contains('3'),
            "the code must come from the process, not from its output: {:?}",
            failed.stdout
        );
    }

    #[tokio::test]
    async fn the_two_streams_stay_apart() {
        // A program's complaint must not be mistaken for its answer.
        let outcome = run("echo answer && echo complaint 1>&2", 10_000).await;
        assert!(outcome.stdout.contains("answer"), "stdout: {:?}", outcome.stdout);
        assert!(
            !outcome.stdout.contains("complaint"),
            "stdout: {:?}",
            outcome.stdout
        );
        assert!(
            outcome.stderr.contains("complaint"),
            "stderr: {:?}",
            outcome.stderr
        );
    }

    #[tokio::test]
    async fn lines_are_handed_over_while_the_command_is_still_running() {
        let seen: Arc<StdMutex<Vec<String>>> = Arc::default();
        let collect = {
            let seen = Arc::clone(&seen);
            move |stream: &'static str, line: &str| {
                if let Ok(mut seen) = seen.lock() {
                    seen.push(format!("{stream}:{line}"));
                }
            }
        };
        let (_tx, rx) = oneshot::channel();
        let outcome = run_capturing("echo one && echo two 1>&2", ".", 10_000, rx, collect)
            .await
            .expect("the command should have started");

        assert_eq!(outcome.code, Some(0));
        let seen = seen.lock().expect("the collected lines").clone();
        assert!(
            seen.iter()
                .any(|line| line.starts_with("stdout:") && line.contains("one")),
            "nothing was streamed for stdout: {seen:?}"
        );
        assert!(
            seen.iter()
                .any(|line| line.starts_with("stderr:") && line.contains("two")),
            "nothing was streamed for stderr: {seen:?}"
        );
    }

    #[tokio::test]
    async fn a_command_that_will_not_end_is_ended() {
        let outcome = run(&sleep_for(60), 300).await;
        assert!(outcome.timed_out, "the deadline did not fire");
        assert!(!outcome.cancelled, "a deadline is not a cancel");
        assert_eq!(outcome.code, None, "a killed process has no exit code to report");
        assert!(
            outcome.duration_ms < 30_000,
            "it waited {} ms for a 300 ms deadline",
            outcome.duration_ms
        );
    }

    #[tokio::test]
    async fn cancelling_ends_it_and_says_that_is_what_happened() {
        let (kill_tx, kill_rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = kill_tx.send(());
        });
        let outcome = run_capturing(&sleep_for(60), ".", 60_000, kill_rx, |_, _| {})
            .await
            .expect("the command should have started");

        assert!(outcome.cancelled, "the cancel did not reach the process");
        assert!(!outcome.timed_out, "a cancel is not a deadline");
        assert_eq!(outcome.code, None);
        // Timed too, for the reason the deadline test is timed: killing the
        // shell alone leaves the program it started holding the pipes, and the
        // call then returns only when *that* finishes - sixty seconds later,
        // reporting a cancel that plainly did not cancel anything.
        assert!(
            outcome.duration_ms < 30_000,
            "the cancel took {} ms, so something outlived it",
            outcome.duration_ms
        );
    }

    #[tokio::test]
    async fn a_command_that_cannot_start_says_so_instead_of_answering() {
        let (_tx, rx) = oneshot::channel();
        let refused = run_capturing("echo hi", "./no-such-folder-here", 10_000, rx, |_, _| {}).await;
        assert!(
            refused.is_err(),
            "a missing working directory must not look like a run"
        );

        let (_tx, rx) = oneshot::channel();
        let empty = run_capturing("   ", ".", 10_000, rx, |_, _| {}).await;
        assert!(
            empty.is_err(),
            "an empty command line is a caller's bug, not a run"
        );
    }

    #[test]
    fn a_capture_is_cut_on_a_character_boundary() {
        // Two-byte characters straddling the cut: slicing by byte count alone
        // would panic, and a log full of UTF-8 is the normal case here.
        let text = "ăăăă";
        let at = drop_point(text, 3);
        assert_eq!(at, 4, "the cut moved forward to a boundary");
        assert_eq!(&text[at..], "ăă");
    }

    /// Sleeping is spelled differently on each shell.
    fn sleep_for(seconds: u32) -> String {
        #[cfg(target_os = "windows")]
        {
            // `timeout` needs a console; ping against the loopback does not.
            format!("ping -n {} 127.0.0.1 > nul", seconds + 1)
        }
        #[cfg(not(target_os = "windows"))]
        {
            format!("sleep {seconds}")
        }
    }
}
