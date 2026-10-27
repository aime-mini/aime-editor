//! The login shell's environment, for an app that was not started from one.
//!
//! On macOS and Linux an app opened from Finder, the Dock or a desktop menu
//! inherits the session's bare environment, not the shell's: `brew`, `nvm`,
//! `dotnet`, `cargo` and the AI CLIs live on a PATH that `.zprofile` or
//! `.bashrc` builds, and none of it reaches a child of the app. Every "CLI not
//! found" on those platforms starts here. So, once at start and before anything
//! is spawned, Aime asks the person's login shell for its environment and
//! adopts it: PATH as the shell has it, and every variable the app did not
//! already have. Windows has no such split - the user's environment is the
//! process's - and is left alone.
//!
//! The shell runs as an interactive login shell (`-ilc`), because PATH is set
//! in `.zshrc` as often as in `.zprofile`. `env -0` is asked for, which an rc
//! file printing banners or escape codes cannot corrupt: records are
//! NUL-separated and a record that is not `NAME=value` is dropped. A shell
//! that hangs on a prompt is killed after a few seconds, and the app runs as
//! it was started.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Long enough for a slow rc file (nvm alone takes a second), short enough
/// that a hung shell does not hold the splash screen.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// Values that describe the shell's own session rather than the environment.
const VOLATILE: [&str; 6] = ["_", "SHLVL", "PWD", "OLDPWD", "TERM", "TERM_PROGRAM"];

/// What the adoption did, for the log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Adopted {
    pub variables: usize,
    pub path_replaced: bool,
}

/// Adopts the login shell's environment into this process. Does nothing on
/// Windows, and nothing when the shell cannot be asked.
pub fn adopt() {
    if cfg!(target_os = "windows") {
        return;
    }
    let shell = std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/bin/sh"));
    let captured = match capture(&shell) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("[login_shell] {} did not answer: {err}", shell.display());
            return;
        }
    };
    let current: HashMap<String, String> = std::env::vars().collect();
    let changes = merge(&current, &parse_env(&captured));
    let adopted = Adopted {
        variables: changes.len(),
        path_replaced: changes.iter().any(|(name, _)| name == "PATH"),
    };
    for (name, value) in changes {
        std::env::set_var(name, value);
    }
    eprintln!(
        "[login_shell] adopted {} variables from {}{}",
        adopted.variables,
        shell.display(),
        if adopted.path_replaced {
            ", PATH included"
        } else {
            ""
        }
    );
}

/// `env -0` as the interactive login shell prints it, within the timeout.
fn capture(shell: &Path) -> std::io::Result<Vec<u8>> {
    let mut child = Command::new(shell)
        .args(["-ilc", "env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("no stdout"))?;
    // Read on a thread so a shell that prints more than a pipe holds cannot block.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > SHELL_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("no answer within {SHELL_TIMEOUT:?}"),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(reader.join().unwrap_or_default())
}

/// The `NAME=value` records of an `env -0` print, in order; anything else
/// between the NULs - a banner, an escape sequence - is dropped.
pub(crate) fn parse_env(bytes: &[u8]) -> Vec<(String, String)> {
    bytes
        .split(|byte| *byte == 0)
        .filter_map(|record| {
            let text = std::str::from_utf8(record).ok()?;
            let (name, value) = text.split_once('=')?;
            is_variable_name(name).then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

fn is_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// What to set: PATH from the shell whenever it has one (that is the point),
/// every other variable only where the app has none, and nothing that merely
/// describes the shell's own session.
pub(crate) fn merge(current: &HashMap<String, String>, shell: &[(String, String)]) -> Vec<(String, String)> {
    shell
        .iter()
        .filter(|(name, value)| {
            if VOLATILE.contains(&name.as_str()) || value.is_empty() {
                return false;
            }
            if name == "PATH" {
                return current.get("PATH") != Some(value);
            }
            !current.contains_key(name)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn records_are_read_between_nuls_and_banners_are_dropped() {
        // A p10k-style banner before the first record, a value holding `=`
        // and a newline, an escape sequence in a record of its own.
        let printed = b"\x1b[1mWelcome\x1b[0m\n\0PATH=/opt/homebrew/bin:/usr/bin\0LESS=-R=x\nmore\0\x1b[K\0_=/usr/bin/env\0";
        assert_eq!(
            parse_env(printed),
            vec![
                ("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string()),
                ("LESS".to_string(), "-R=x\nmore".to_string()),
                ("_".to_string(), "/usr/bin/env".to_string()),
            ]
        );
    }

    #[test]
    fn path_is_taken_from_the_shell_and_the_rest_only_fills_gaps() {
        let current = env(&[("PATH", "/usr/bin:/bin"), ("HOME", "/Users/x"), ("LANG", "C")]);
        let shell = parse_env(
            b"PATH=/opt/homebrew/bin:/usr/bin:/bin\0HOME=/Users/x\0LANG=en_US.UTF-8\0NVM_DIR=/Users/x/.nvm\0SHLVL=1\0PWD=/Users/x\0EMPTY=\0",
        );
        let mut changes = merge(&current, &shell);
        changes.sort();
        assert_eq!(
            changes,
            vec![
                ("NVM_DIR".to_string(), "/Users/x/.nvm".to_string()),
                ("PATH".to_string(), "/opt/homebrew/bin:/usr/bin:/bin".to_string()),
            ],
            "LANG stays as the launcher set it, SHLVL and PWD are the shell's own, an empty value is nothing"
        );
    }

    #[test]
    fn an_unchanged_path_is_not_set_again() {
        let current = env(&[("PATH", "/usr/bin")]);
        assert!(merge(&current, &parse_env(b"PATH=/usr/bin\0")).is_empty());
    }

    /// The real command shape, on whatever POSIX shell this machine has: on
    /// a developer's Windows that is Git Bash, on macOS and Linux the login
    /// shell itself. A machine without one simply skips the check.
    #[test]
    fn a_real_shell_answers_with_its_path() {
        let shell = if cfg!(target_os = "windows") {
            // A bare `bash` would resolve to System32's WSL launcher before PATH
            // (CreateProcess searches the system directory first), which answers
            // nothing when no distribution is installed; Git's bash is on PATH.
            std::env::var_os("PATH")
                .map(|path| {
                    std::env::split_paths(&path)
                        .map(|dir| dir.join("bash.exe"))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
                .into_iter()
                .find(|candidate| candidate.is_file() && !candidate.to_string_lossy().contains("System32"))
        } else {
            Some(
                std::env::var_os("SHELL")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::path::PathBuf::from("/bin/sh")),
            )
        };
        let Some(bytes) = shell.and_then(|shell| capture(&shell).ok()) else {
            eprintln!("no POSIX shell here; the capture is not checked on this machine");
            return;
        };
        let path = parse_env(&bytes)
            .into_iter()
            .find(|(name, _)| name == "PATH")
            .map(|(_, value)| value);
        assert!(
            path.is_some_and(|value| !value.is_empty()),
            "the shell printed no PATH"
        );
    }
}
