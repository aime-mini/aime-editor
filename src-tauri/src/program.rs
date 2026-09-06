//! Turning a tool name into something spawnable.
//!
//! A bare name is not a program: a shell finds it on PATH, and on Windows what
//! it finds may be an executable or a batch shim (`.cmd`/`.bat` — how npm
//! installs every Node CLI). Only cmd.exe can run a shim, and cmd.exe parses
//! the command line, so the two have to be spawned differently.
//!
//! Getting that wrong is silent, which is why this module exists. Measured on
//! Windows 2026-09-03: `cmd /C shim.cmd -p "<a three-line prompt>"` hands the
//! shim an **empty** argument tail and exits **0** — the tool runs with no
//! prompt at all and reports success. The same argument reaches a directly
//! spawned executable with all three lines intact. Spawning directly also
//! settles two older hazards for free: cmd.exe's 8191-character command line,
//! and a folder whose name holds a space being read as two arguments.

use std::path::{Path, PathBuf};

/// Extensions cmd.exe hands to its batch interpreter instead of executing.
const BATCH_EXTENSIONS: [&str; 2] = ["cmd", "bat"];

/// Where a tool name lands on this machine.
pub struct Program {
    path: PathBuf,
    shim: bool,
    found: bool,
}

impl Program {
    /// Looks the name up the way a shell would, without running it.
    pub fn resolve(name: &str) -> Self {
        let given = Path::new(name);
        if given.is_absolute() || name.contains('/') || name.contains('\\') {
            return Self::at(given.to_path_buf(), is_executable_file(given));
        }
        match search_path(name) {
            Some(path) => Self::at(path, true),
            // Nothing matched: spawning the bare name fails with an OS error
            // naming the tool, which is the message a caller wants anyway.
            None => Self::at(given.to_path_buf(), false),
        }
    }

    fn at(path: PathBuf, found: bool) -> Self {
        let shim = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| BATCH_EXTENSIONS.contains(&extension.to_lowercase().as_str()));
        Self { path, shim, found }
    }

    /// What to spawn — an absolute path once the name resolved.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether this one can only be run through cmd.exe, which means every
    /// argument goes through cmd.exe's parser and none may hold a newline.
    pub fn is_batch_shim(&self) -> bool {
        self.shim
    }

    /// Whether anything of that name was found at all.
    pub fn exists(&self) -> bool {
        self.found
    }
}

/// The first PATH entry holding this name, trying PATHEXT the way the shell
/// does.
///
/// **PATHEXT wins over the bare name on Windows**, and getting that backwards
/// is not a subtlety - measured 2026-09-03, `az` resolved to
/// `…\Azure\CLI2\wbinz`, an extensionless POSIX script that Windows cannot
/// execute at all, while the runnable `az.cmd` sat beside it; `codex` did the
/// same with npm's shell script. Both CLIs were then reported as *not
/// installed* on a machine that had them. Tools that ship for several shells
/// leave the extensionless file there for bash, so on Windows it must never be
/// the first answer. Off Windows PATHEXT is unset, the bare name is the only
/// candidate, and the execute bit decides.
fn search_path(name: &str) -> Option<PathBuf> {
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_default()
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(str::to_lowercase)
        .collect();

    let paths = std::env::var_os("PATH")?;
    let found = std::env::split_paths(&paths).find_map(|dir| pick_in_dir(&dir, name, &extensions));
    if found.is_some() {
        return found;
    }
    let registered = registered_path()?;
    std::env::split_paths(&registered).find_map(|dir| pick_in_dir(&dir, name, &extensions))
}

/// The PATH as Windows stores it *now*, for a tool installed while Aime runs.
///
/// A process keeps the environment it was started with, so `winget install`
/// puts the Google Cloud CLI on the user's PATH and every shell opened
/// afterwards finds it - while the Aime that offered the install keeps saying
/// "not on this machine" until it is restarted (seen 2026-09-05). The stored
/// value is read through .NET rather than `reg query`, which a domain policy
/// on the same machine refused with "Registry editing has been disabled".
/// Asked only after the process PATH came up empty, so a tool that is there
/// costs nothing extra; off Windows, package managers install into directories
/// that are already on PATH, and there is nothing to ask.
fn registered_path() -> Option<std::ffi::OsString> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let mut powershell = std::process::Command::new("powershell");
    powershell.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        powershell.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = powershell.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then(|| text.into())
}

/// The runnable file for this name in one directory, PATHEXT first.
fn pick_in_dir(dir: &Path, name: &str, extensions: &[String]) -> Option<PathBuf> {
    let with_extension = extensions.iter().find_map(|extension| {
        let candidate = dir.join(format!("{name}{extension}"));
        is_executable_file(&candidate).then_some(candidate)
    });
    if with_extension.is_some() {
        return with_extension;
    }
    let exact = dir.join(name);
    is_executable_file(&exact).then_some(exact)
}

/// A file a shell would be willing to run. On Unix that means the execute bit
/// as well: a readable file of the right name in an earlier PATH entry is not
/// the program, and treating it as one shadows the real tool.
fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0);
    }
    #[cfg(not(unix))]
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The distinction the whole module exists for, asserted per platform
    /// against a tool every platform actually has: Windows npm CLIs are shims,
    /// and a plain executable never is.
    #[test]
    fn a_batch_shim_is_told_apart_from_an_executable() {
        let shim = Program::at(PathBuf::from(r"C:\npm\gemini.CMD"), true);
        assert!(shim.is_batch_shim(), "a .CMD shim must go through cmd.exe");
        assert!(
            !Program::at(PathBuf::from(r"C:\bin\claude.exe"), true).is_batch_shim(),
            "an executable must be spawned directly"
        );
        assert!(
            !Program::at(PathBuf::from("/usr/local/bin/claude"), true).is_batch_shim(),
            "an extensionless Unix binary is never a shim"
        );
    }

    /// Windows keeps a PATH of its own that a running process does not see
    /// change; it must be readable here, and it is nothing off Windows.
    #[test]
    fn the_stored_path_is_read_on_windows_and_nowhere_else() {
        let stored = registered_path();
        if cfg!(target_os = "windows") {
            let text = stored
                .expect("Windows stores a PATH")
                .to_string_lossy()
                .to_string();
            assert!(
                text.to_lowercase().contains("windows"),
                "the system half names the Windows folder: {text}"
            );
        } else {
            assert!(stored.is_none());
        }
    }

    /// Resolution has to answer for a tool that is really there, and the
    /// answer has to be a path rather than the bare name.
    #[test]
    fn a_tool_on_path_resolves_to_its_own_file() {
        let name = if cfg!(target_os = "windows") { "cmd" } else { "sh" };
        let found = Program::resolve(name);
        assert!(
            found.exists(),
            "{name} is on PATH on every {} machine",
            std::env::consts::OS
        );
        assert!(
            found.path().is_absolute() && found.path().is_file(),
            "resolution must yield the file itself, got {:?}",
            found.path()
        );
    }

    /// The bug this rule exists for, against real files on disk.
    ///
    /// Measured 2026-09-03: `az` sat on PATH as BOTH `az` (a POSIX script
    /// Windows cannot execute) and `az.cmd`, and npm ships `codex` the same
    /// way. Answering with the extensionless one made Aime report two CLIs the
    /// machine had as *not installed*, and offer to install them.
    #[test]
    fn a_pathext_match_beats_an_extensionless_file_of_the_same_name() {
        let dir = std::env::temp_dir().join(format!("aime-pathext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("tool"),
            "#!/bin/sh
",
        )
        .expect("posix script");
        std::fs::write(
            dir.join("tool.cmd"),
            "@echo off
",
        )
        .expect("batch shim");

        let extensions = vec![".exe".to_string(), ".cmd".to_string()];
        let found = pick_in_dir(&dir, "tool", &extensions).expect("resolved");
        assert_eq!(
            found.file_name().and_then(|name| name.to_str()),
            Some("tool.cmd"),
            "Windows cannot run the extensionless file, so it must not win"
        );

        // With no PATHEXT - every non-Windows machine - the bare name is the
        // answer, and nothing about that changed.
        let bare = pick_in_dir(&dir, "tool", &[]).expect("resolved");
        assert_eq!(bare.file_name().and_then(|name| name.to_str()), Some("tool"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_tool_keeps_the_name_so_the_spawn_error_names_it() {
        let missing = Program::resolve("aime-no-such-tool-anywhere");
        assert!(!missing.exists());
        assert_eq!(missing.path(), Path::new("aime-no-such-tool-anywhere"));
    }
}
