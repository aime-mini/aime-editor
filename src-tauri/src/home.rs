//! The user's home directory, by the variable each platform actually sets.

use std::path::PathBuf;

/// `USERPROFILE` on Windows, `HOME` elsewhere; None when the environment
/// does not say, which a caller treats as "no such file" rather than a guess.
pub fn home_dir() -> Option<PathBuf> {
    let variable = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    std::env::var_os(variable).map(PathBuf::from)
}
