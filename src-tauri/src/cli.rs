use std::path::PathBuf;
use tauri::{State, Window};

/// Workspace folder passed on the command line (`aime <folder>`), resolved once at startup.
pub struct InitialFolder(Option<String>);

impl InitialFolder {
    pub fn from_args() -> Self {
        Self(std::env::args().nth(1).and_then(resolve_folder_arg))
    }
}

/// Resolves a CLI argument to an absolute existing directory, or None.
/// Relative paths are resolved against the process working directory, so both
/// `aime .` and `aime C:\projects\x` behave as expected.
fn resolve_folder_arg(arg: String) -> Option<String> {
    let path = PathBuf::from(&arg);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    // dunce avoids the `\\?\` verbatim prefix std::fs::canonicalize adds on Windows.
    let canonical = dunce::canonicalize(absolute).ok()?;
    canonical
        .is_dir()
        .then(|| canonical.to_string_lossy().to_string())
}

/// Returns the folder the app was launched with — only for the main window,
/// so editor windows opened later still start on the welcome screen.
#[tauri::command]
pub fn initial_folder(window: Window, state: State<'_, InitialFolder>) -> Option<String> {
    (window.label() == "main").then(|| state.0.clone()).flatten()
}

#[cfg(test)]
mod tests {
    use super::resolve_folder_arg;

    #[test]
    fn relative_dot_resolves_to_cwd() {
        let resolved = resolve_folder_arg(".".into()).expect("cwd should resolve");
        assert!(std::path::Path::new(&resolved).is_absolute());
        assert!(!resolved.starts_with(r"\\?\"), "verbatim prefix must be stripped");
    }

    #[test]
    fn missing_folder_is_rejected() {
        assert_eq!(resolve_folder_arg("definitely-not-a-real-folder".into()), None);
    }

    #[test]
    fn file_path_is_rejected() {
        assert_eq!(resolve_folder_arg("Cargo.toml".into()), None);
    }
}
