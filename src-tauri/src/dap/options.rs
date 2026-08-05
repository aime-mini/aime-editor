//! Arguments and environment for the program being debugged.
//!
//! A debugger that cannot pass `runserver`, `--port 8080` or `NODE_ENV=test` can
//! only run the programs that need nothing — which is not many of them. These
//! belong to the *target*, not to the session: the same project is debugged the
//! same way tomorrow, so they live in a file.
//!
//! `.aime/launch.json`, next to `tasks.json`, and for the same reason: it is the
//! project's own configuration, edited by hand as readily as through the dialog.
//! Note that `.aime/` ignores itself in git (`aime_dir::ensure_self_ignored`), so
//! this is per machine per project rather than something a team shares — the same
//! trade-off `tasks.json` already makes.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What to pass a program when it is launched.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptions {
    /// Command-line arguments, already split the way the program will see them.
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment, merged over the one Aime itself runs with. Ordered so
    /// the file reads the same after every write.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl LaunchOptions {
    /// Nothing to pass — the entry is then dropped rather than stored empty.
    fn is_empty(&self) -> bool {
        self.args.is_empty() && self.env.is_empty()
    }
}

/// The file's shape: options by target id, so a repository with two programs
/// keeps two sets.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct LaunchFile {
    #[serde(default)]
    targets: BTreeMap<String, LaunchOptions>,
}

pub const LAUNCH_FILE: &str = "launch.json";

fn file_path(root: &Path) -> PathBuf {
    root.join(crate::aime_dir::AIME_DIR).join(LAUNCH_FILE)
}

fn read(root: &Path) -> LaunchFile {
    let Ok(text) = std::fs::read_to_string(file_path(root)) else {
        return LaunchFile::default();
    };
    match serde_json::from_str::<LaunchFile>(&text) {
        Ok(file) => file,
        Err(err) => {
            // A file someone mistyped costs its own contents, not the ability to
            // debug: the run still starts, just without extra arguments.
            eprintln!("[dap] ignoring {}: {err}", file_path(root).display());
            LaunchFile::default()
        }
    }
}

/// Everything this project passes to its programs.
#[tauri::command]
pub fn dap_launch_options(root: String) -> BTreeMap<String, LaunchOptions> {
    read(Path::new(&root)).targets
}

/// Stores what to pass one target, or forgets it when there is nothing to pass.
#[tauri::command]
pub fn dap_set_launch_options(root: String, target_id: String, options: LaunchOptions) -> Result<(), String> {
    let root = Path::new(&root);
    let mut file = read(root);
    if options.is_empty() {
        file.targets.remove(&target_id);
    } else {
        file.targets.insert(target_id, options);
    }

    let path = file_path(root);
    if file.targets.is_empty() {
        // An empty file is noise; removing it also un-does a mistake completely.
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Could not remove {}: {err}", path.display())),
        };
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{dap_launch_options, dap_set_launch_options, LaunchOptions};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aime-launch-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp project");
        root
    }

    fn options(args: &[&str], env: &[(&str, &str)]) -> LaunchOptions {
        LaunchOptions {
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            env: env
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect(),
        }
    }

    #[test]
    fn what_was_stored_for_one_target_comes_back_for_that_target() {
        let root = project("roundtrip");
        let asked = options(&["runserver", "--noreload"], &[("DJANGO_ENV", "dev")]);
        dap_set_launch_options(
            root.to_string_lossy().to_string(),
            "python:manage.py".into(),
            asked.clone(),
        )
        .expect("stored");

        let stored = dap_launch_options(root.to_string_lossy().to_string());
        assert_eq!(stored.get("python:manage.py"), Some(&asked));
    }

    #[test]
    fn two_programs_in_one_repository_keep_their_own_arguments() {
        let root = project("two");
        let path = root.to_string_lossy().to_string();
        dap_set_launch_options(path.clone(), "go:cmd/api".into(), options(&["--port=8080"], &[]))
            .expect("stored");
        dap_set_launch_options(
            path.clone(),
            "go:cmd/worker".into(),
            options(&["--queue=mail"], &[]),
        )
        .expect("stored");

        let stored = dap_launch_options(path);
        assert_eq!(stored.len(), 2);
        assert_eq!(stored["go:cmd/api"].args, ["--port=8080"]);
        assert_eq!(stored["go:cmd/worker"].args, ["--queue=mail"]);
    }

    #[test]
    fn clearing_the_last_entry_takes_the_file_with_it() {
        let root = project("cleared");
        let path = root.to_string_lossy().to_string();
        dap_set_launch_options(path.clone(), "node:app.js".into(), options(&["--once"], &[]))
            .expect("stored");
        dap_set_launch_options(path.clone(), "node:app.js".into(), LaunchOptions::default())
            .expect("cleared");

        assert!(dap_launch_options(path).is_empty());
        assert!(
            !super::file_path(&root).exists(),
            "an empty file is noise; it should be gone"
        );
    }

    #[test]
    fn a_project_that_was_never_configured_answers_with_nothing() {
        let root = project("absent");
        assert_eq!(
            dap_launch_options(root.to_string_lossy().to_string()),
            BTreeMap::new()
        );
    }

    #[test]
    fn a_file_nobody_can_parse_costs_its_own_contents_and_nothing_else() {
        let root = project("broken");
        let aime = root.join(crate::aime_dir::AIME_DIR);
        std::fs::create_dir_all(&aime).expect("folder");
        std::fs::write(aime.join("launch.json"), "{ not json").expect("write");
        assert!(dap_launch_options(root.to_string_lossy().to_string()).is_empty());
    }
}
