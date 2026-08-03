//! Aime's per-project folder. `.aime/` holds what Aime and the agent keep
//! *about* a project — the progress journal every turn is told to maintain
//! (`providers::adapter::PROGRESS_MEMORY_PROMPT`) and task overrides — never
//! the project's own source. It therefore appears in every repository Aime is
//! pointed at, and has to stay out of the user's commits by itself.

use std::path::Path;

/// Aime's folder inside a user's project.
pub const AIME_DIR: &str = ".aime";

/// A nested ignore file covers the whole folder and leaves the project's own
/// `.gitignore` untouched — editing a file Aime does not own would be a worse
/// intrusion than the leak it prevents. `*` hides the guard itself too, which
/// is the intent: git should see nothing here at all.
const SELF_IGNORE: &str = "# Aime's notes about this project - not part of it.\n*\n";

/// Writes the guard the first time `.aime/` appears in a project.
///
/// Silent by design in two cases: no folder yet — Aime does not create one for
/// projects that never used it — and a guard that already exists, which from
/// then on belongs to whoever edited it.
pub fn ensure_self_ignored(root: &Path) -> std::io::Result<()> {
    let dir = root.join(AIME_DIR);
    if !dir.is_dir() {
        return Ok(());
    }
    let guard = dir.join(".gitignore");
    if guard.exists() {
        return Ok(());
    }
    std::fs::write(guard, SELF_IGNORE)
}

#[cfg(test)]
mod tests {
    use super::{ensure_self_ignored, AIME_DIR};
    use std::path::PathBuf;

    /// A fresh project folder; the name keeps concurrent tests apart.
    fn project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aime-dir-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp project");
        root
    }

    #[test]
    fn a_project_without_the_folder_is_left_untouched() {
        let root = project("absent");
        ensure_self_ignored(&root).expect("no folder is not an error");
        assert!(!root.join(AIME_DIR).exists());
    }

    #[test]
    fn the_folder_starts_ignoring_itself_as_soon_as_it_exists() {
        let root = project("present");
        std::fs::create_dir(root.join(AIME_DIR)).expect("aime dir");
        ensure_self_ignored(&root).expect("guard written");

        let guard = std::fs::read_to_string(root.join(AIME_DIR).join(".gitignore")).expect("guard file");
        assert!(
            guard.lines().any(|line| line == "*"),
            "everything must be ignored"
        );
    }

    #[test]
    fn an_existing_guard_belongs_to_the_user_and_survives() {
        let root = project("edited");
        let dir = root.join(AIME_DIR);
        std::fs::create_dir(&dir).expect("aime dir");
        std::fs::write(dir.join(".gitignore"), "PROGRESS.md\n").expect("user's version");

        ensure_self_ignored(&root).expect("nothing to do");

        let guard = std::fs::read_to_string(dir.join(".gitignore")).expect("guard file");
        assert_eq!(guard, "PROGRESS.md\n");
    }
}
