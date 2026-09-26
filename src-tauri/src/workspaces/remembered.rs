//! The folders a window had open as tabs, kept across restarts: reopening one
//! of them - from Recent, or the command line - brings the others back beside
//! it, in the order they stood.
//!
//! Only what the person does to the tabs changes the record: opening one,
//! closing one with its x, taking one out into a window of its own. Closing the
//! window - or the app - keeps it, because that is exactly the moment it is
//! kept for.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "workspace-tabs.json";

/// Sets of folders, each the tabs of one window in the order they were drawn.
/// A folder is in one set at most, and a set holds two folders at least - a
/// window with one tab has nothing to bring back.
#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remembered {
    sets: Vec<Vec<String>>,
}

impl Remembered {
    /// Replaces what was known about these folders with the set they form now.
    /// `departed` is a folder that has just left the set, and is forgotten
    /// with it.
    pub fn record(&mut self, folders: &[String], departed: Option<&str>) {
        let touched = |folder: &String| {
            folders.iter().any(|known| same_folder(known, folder))
                || departed.is_some_and(|gone| same_folder(gone, folder))
        };
        for set in &mut self.sets {
            set.retain(|folder| !touched(folder));
        }
        self.sets.retain(|set| set.len() > 1);
        if folders.len() > 1 {
            self.sets.push(folders.to_vec());
        }
    }

    /// The tabs `folder` was last open with, itself included, in order.
    pub fn beside(&self, folder: &str) -> Option<&[String]> {
        self.sets
            .iter()
            .find(|set| set.iter().any(|known| same_folder(known, folder)))
            .map(Vec::as_slice)
    }

    /// What this machine remembers. None yet is nothing; a file that cannot
    /// be read is reported and read as nothing - it only costs the tabs.
    pub fn load(app: &AppHandle) -> Self {
        let path = match file(app) {
            Ok(path) => path,
            Err(err) => {
                eprintln!("[workspaces] no place to remember tabs: {err}");
                return Self::default();
            }
        };
        match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
                eprintln!(
                    "[workspaces] {} is not readable, starting afresh: {err}",
                    path.display()
                );
                Self::default()
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(err) => {
                eprintln!("[workspaces] could not read {}: {err}", path.display());
                Self::default()
            }
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = file(app)?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write(&path, &text)
    }
}

/// Whether two paths name the same folder. The same folder reaches here
/// spelled more than one way - `C:\work\shop` from the folder dialog, the
/// 8.3 short form from a terminal whose working directory was one (measured
/// 2026-09-26: `LINHPH~1.STS` beside `linh.pham.STS`, and the tabs did not
/// come back), `C:/work/shop` from elsewhere - so a folder still on the disk
/// is compared by the path the disk resolves it to.
pub fn same_folder(a: &str, b: &str) -> bool {
    key(a) == key(b)
}

fn key(path: &str) -> String {
    let resolved = dunce::canonicalize(path).map(|real| real.to_string_lossy().into_owned());
    let path = resolved.as_deref().unwrap_or(path);
    // Gone from the disk, or on Windows where letter case never tells two
    // folders apart: compared by its spelling, made uniform.
    if cfg!(windows) {
        path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    } else {
        path.trim_end_matches('/').to_string()
    }
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(FILE))
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folders(names: &[&str]) -> Vec<String> {
        names.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn a_window_of_tabs_is_remembered_in_its_order() {
        let mut remembered = Remembered::default();
        remembered.record(&folders(&["a", "b", "c"]), None);
        assert_eq!(remembered.beside("b"), Some(folders(&["a", "b", "c"]).as_slice()));
    }

    #[test]
    fn a_tab_closed_is_forgotten_and_the_rest_kept() {
        let mut remembered = Remembered::default();
        remembered.record(&folders(&["a", "b", "c"]), None);
        remembered.record(&folders(&["a", "c"]), Some("b"));
        assert_eq!(remembered.beside("b"), None);
        assert_eq!(remembered.beside("a"), Some(folders(&["a", "c"]).as_slice()));
    }

    #[test]
    fn the_last_tab_but_one_closed_leaves_nothing_to_bring_back() {
        let mut remembered = Remembered::default();
        remembered.record(&folders(&["a", "b"]), None);
        remembered.record(&folders(&["a"]), Some("b"));
        assert_eq!(remembered, Remembered::default());
    }

    #[test]
    fn a_folder_moved_to_another_window_leaves_its_old_one() {
        let mut remembered = Remembered::default();
        remembered.record(&folders(&["a", "b", "c"]), None);
        remembered.record(&folders(&["x", "b"]), None);
        assert_eq!(remembered.beside("a"), Some(folders(&["a", "c"]).as_slice()));
        assert_eq!(remembered.beside("b"), Some(folders(&["x", "b"]).as_slice()));
    }

    #[test]
    fn a_folder_is_found_however_it_is_spelled() {
        let mut remembered = Remembered::default();
        remembered.record(&folders(&["C:/work/shop", "C:/work/api"]), None);
        let found = remembered.beside(r"c:\work\shop\").is_some();
        assert_eq!(
            found,
            cfg!(windows),
            "Windows spells one folder many ways; elsewhere they are different folders"
        );
    }

    #[test]
    fn a_folder_on_the_disk_is_found_by_where_it_resolves() {
        let dir = std::env::temp_dir().join("aime-remembered-resolves");
        fs::create_dir_all(&dir).expect("temp folder");
        let plain = dir.to_string_lossy().into_owned();
        let roundabout = dir
            .join("..")
            .join("aime-remembered-resolves")
            .to_string_lossy()
            .into_owned();
        let same = same_folder(&plain, &roundabout);
        fs::remove_dir(&dir).expect("temp folder removed");
        assert!(same, "{plain} and {roundabout} are one folder");
    }

    #[test]
    fn what_is_written_reads_back() {
        let mut remembered = Remembered::default();
        remembered.record(&folders(&[r"C:\work\shop", r"C:\work\api"]), None);
        let text = serde_json::to_string(&remembered).expect("serializes");
        let back: Remembered = serde_json::from_str(&text).expect("parses");
        assert_eq!(back, remembered);
    }
}
