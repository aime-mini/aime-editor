//! What an AI turn leaves running once its CLI has exited.
//!
//! An agent that starts a job and ends its turn without waiting for it - a
//! test suite under `nohup … &`, a build through `Start-Process` - says it will
//! report back when the job is done, and then nothing is left to do so. The job
//! cannot be found through its ancestry either: the shell that started it has
//! exited, so it is an orphan, re-parented on Unix and pointing at a parent
//! that no longer exists on Windows (measured with Codex 0.146 running
//! `Start-Process ping`). Nor is it in a process group Aime gave the CLI: Codex
//! starts every command in a session of its own (`setsid`, Codex 0.146
//! `utils/pty/src/process_group.rs`).
//!
//! What every one of them keeps is the environment it inherited. A turn's CLI
//! starts with `AIME_TURN` set to the turn's run id, and whatever is still
//! alive carrying it once the CLI has exited is what the turn left running.
//! Aime follows those processes until the last one ends, so that the AI can be
//! told, and Stop ends them along with the turn.

use super::ProviderState;
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsString;
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

/// The variable that marks every process a turn starts.
const TURN_MARK: &str = "AIME_TURN";

/// How often a followed turn is looked at again. The first look waits this
/// long too, so the helpers a CLI tears down as it exits are not taken for
/// work it left behind.
const FOLLOW_INTERVAL: Duration = Duration::from_secs(2);

/// The window every console program on Windows is given. It lives exactly as
/// long as the program it serves, and is nothing the AI started.
const CONSOLE_HOST: &str = "conhost.exe";

/// A process a turn left running, as the panel names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LeftProcess {
    pub pid: u32,
    pub name: String,
}

#[derive(Clone, Serialize)]
struct LeftRunningPayload {
    run_id: String,
    /// Empty once the last of them has ended.
    processes: Vec<LeftProcess>,
}

/// The turns whose leftovers are being followed, by run id.
#[derive(Default)]
pub struct Followed(Mutex<HashSet<String>>);

impl Followed {
    /// A poisoned lock still holds valid data - recover it instead of panicking.
    fn runs(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn start(&self, run_id: &str) {
        self.runs().insert(run_id.to_owned());
    }

    fn contains(&self, run_id: &str) -> bool {
        self.runs().contains(run_id)
    }

    /// Stops following a turn; what it left running runs on.
    pub(crate) fn stop(&self, run_id: &str) {
        self.runs().remove(run_id);
    }
}

/// Marks a turn's CLI, and through it everything the CLI starts.
pub(crate) fn mark(command: &mut Command, run_id: &str) {
    command.env(TURN_MARK, run_id);
}

/// The processes alive now that carry the turn's mark, in pid order so that
/// two looks at an unchanged set compare equal.
///
/// `system` is kept between looks by a caller that looks repeatedly: each
/// process's environment is read once, when it is first seen, and only the
/// list of processes is taken again.
fn look(system: &mut System, run_id: &str) -> Vec<LeftProcess> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_environ(UpdateKind::OnlyIfNotSet),
    );
    let mark = OsString::from(format!("{TURN_MARK}={run_id}"));
    let mut left: Vec<LeftProcess> = system
        .processes()
        .iter()
        .filter(|(_, process)| process.environ().contains(&mark))
        .map(|(pid, process)| LeftProcess {
            pid: pid.as_u32(),
            name: process.name().to_string_lossy().into_owned(),
        })
        .filter(|process| !process.name.eq_ignore_ascii_case(CONSOLE_HOST))
        .collect();
    left.sort_by_key(|process| process.pid);
    left
}

/// `look`, off the async runtime: reading every process's environment is
/// blocking work.
async fn look_off_runtime(system: System, run_id: &str) -> Result<(System, Vec<LeftProcess>), String> {
    let looking = {
        let run_id = run_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut system = system;
            let left = look(&mut system, &run_id);
            (system, left)
        })
    };
    looking
        .await
        .map_err(|err| format!("could not look for what turn {run_id} left running: {err}"))
}

/// Follows what a finished turn left running until the last of it ends, or
/// until the frontend stops following (`ai_unfollow`). Each change is told as
/// `ai:left-running`, the end as an empty list; a turn that left nothing
/// behind is not mentioned at all.
pub(crate) async fn follow(app: &AppHandle, run_id: &str) {
    let Some(state) = app.try_state::<ProviderState>() else {
        return;
    };
    state.followed.start(run_id);
    let mut system = System::new();
    let mut told: Vec<LeftProcess> = Vec::new();
    loop {
        tokio::time::sleep(FOLLOW_INTERVAL).await;
        if !state.followed.contains(run_id) {
            return;
        }
        let left = match look_off_runtime(system, run_id).await {
            Ok((kept, left)) => {
                system = kept;
                left
            }
            Err(err) => {
                eprintln!("[left_running] {err}");
                break;
            }
        };
        if left != told {
            let payload = LeftRunningPayload {
                run_id: run_id.to_owned(),
                processes: left.clone(),
            };
            if let Err(err) = app.emit("ai:left-running", payload) {
                eprintln!("[left_running] could not tell what turn {run_id} left running: {err}");
            }
        }
        if left.is_empty() {
            break;
        }
        told = left;
    }
    state.followed.stop(run_id);
}

/// Ends whatever carries the turn's mark: the part of Stop that ending the
/// CLI's process tree cannot reach, an orphan being outside it.
pub(crate) async fn end(run_id: &str) {
    let ending = {
        let run_id = run_id.to_owned();
        tokio::task::spawn_blocking(move || end_now(&run_id))
    };
    if let Err(err) = ending.await {
        eprintln!("[left_running] could not end what turn {run_id} left running: {err}");
    }
}

fn end_now(run_id: &str) {
    let mut system = System::new();
    for left in look(&mut system, run_id) {
        let ended = system
            .process(Pid::from_u32(left.pid))
            .is_some_and(|process| process.kill());
        // Not ended can also mean it ended on its own a moment ago.
        if !ended {
            eprintln!("[left_running] {} ({}) was not ended", left.name, left.pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// A run id no other test, and no real turn, can carry.
    fn test_run(name: &str) -> String {
        format!("test-{name}-{}", std::process::id())
    }

    /// Starts `script` through the shell the way an agent's command runs, and
    /// waits for the shell to exit.
    async fn run_marked(run_id: &str, script: &str) {
        #[cfg(target_os = "windows")]
        let mut shell = {
            let mut shell = Command::new("powershell");
            shell.args(["-NoProfile", "-Command", script]);
            shell
        };
        #[cfg(not(target_os = "windows"))]
        let mut shell = {
            let mut shell = Command::new("sh");
            shell.args(["-c", script]);
            shell
        };
        mark(&mut shell, run_id);
        let status = shell
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("the shell should have run");
        assert!(status.success(), "the shell failed: {status}");
    }

    /// A job started in the background, and the name it runs under.
    fn background_job() -> (&'static str, &'static str) {
        if cfg!(target_os = "windows") {
            (
                "Start-Process -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1'",
                "PING.EXE",
            )
        } else {
            ("sleep 60 >/dev/null 2>&1 &", "sleep")
        }
    }

    /// Looks until `done` holds, for as long as an ending process may take.
    async fn look_until(run_id: &str, done: impl Fn(&[LeftProcess]) -> bool) -> Vec<LeftProcess> {
        let mut system = System::new();
        let mut left = Vec::new();
        for _ in 0..50 {
            left = look(&mut system, run_id);
            if done(&left) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        left
    }

    #[tokio::test]
    async fn an_orphan_the_turn_left_running_is_found_and_stop_ends_it() {
        let run_id = test_run("orphan");
        let (script, name) = background_job();
        run_marked(&run_id, script).await;

        let left = look_until(&run_id, |left| !left.is_empty()).await;
        assert!(
            left.iter().any(|process| process.name.eq_ignore_ascii_case(name)),
            "the job its shell left behind was not found: {left:?}"
        );
        assert!(
            left.iter()
                .all(|process| !process.name.eq_ignore_ascii_case(CONSOLE_HOST)),
            "a console host is not something the turn started: {left:?}"
        );

        end(&run_id).await;
        let left = look_until(&run_id, <[LeftProcess]>::is_empty).await;
        assert!(left.is_empty(), "Stop left these running: {left:?}");
    }

    #[tokio::test]
    async fn a_turn_whose_commands_all_finished_left_nothing_running() {
        let run_id = test_run("finished");
        run_marked(&run_id, "echo done").await;
        let mut system = System::new();
        assert_eq!(look(&mut system, &run_id), Vec::new());
    }

    #[tokio::test]
    async fn another_turn_s_leftovers_are_not_this_one_s() {
        let run_id = test_run("other");
        let (script, _) = background_job();
        run_marked(&run_id, script).await;
        let left = look_until(&run_id, |left| !left.is_empty()).await;
        assert!(!left.is_empty(), "the job was not started");

        let mut system = System::new();
        assert_eq!(look(&mut system, &format!("{run_id}0")), Vec::new());
        end(&run_id).await;
    }
}
