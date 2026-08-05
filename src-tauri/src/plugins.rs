//! What plugins are installed — and nothing else.
//!
//! The backend's whole job here is to answer "what is on this machine" and to
//! hand over a plugin's source. Running it belongs to the frontend, inside a
//! Worker with no DOM and no Tauri APIs (ARCHITECTURE.md §7), because a plugin
//! must not be able to reach the things Aime itself can reach.
//!
//! **Plugins live in Aime's own data folder, never in the project.** A plugin
//! found in a repository would mean cloning a repository is running its code,
//! which is the one thing an editor must not do. Installing one is a deliberate
//! act: drop a folder in, or let the AI write it there.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The API this build of Aime speaks. A plugin declares which one it was written
/// against, so an old plugin can be refused with a sentence instead of a crash.
pub const PLUGIN_API_VERSION: u32 = 1;

pub const MANIFEST_FILE: &str = "plugin.json";

/// What a plugin says about itself.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// Folder-safe and stable: it keys the enabled/disabled choice.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// The script to run, relative to the plugin's own folder.
    pub main: String,
    /// What it is allowed to reach. Anything not listed here is refused by the
    /// host at call time, not by the plugin's good manners.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// The API version it was written against.
    #[serde(default)]
    pub api_version: u32,
}

/// One plugin as the UI sees it: what it claims, and whether Aime will run it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    /// Absolute path of the plugin's folder, shown so nothing is mysterious.
    pub dir: String,
    /// Why Aime will not run it, when it will not. `None` means it is fine.
    pub problem: Option<String>,
}

/// Where plugins live.
pub fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins"))
}

/// Whether an id is safe to key state and paths with.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !id.starts_with('.')
}

/// Everything wrong with a manifest, in one sentence, or nothing.
///
/// Pure, and the interesting rule is the last one: `main` must resolve *inside*
/// the plugin's own folder. Without that check a manifest saying
/// `"main": "../../../../Windows/System32/..."` would have Aime read and run a
/// file that has nothing to do with the plugin.
pub fn problem_with(manifest: &PluginManifest, dir: &Path) -> Option<String> {
    if !is_safe_id(&manifest.id) {
        return Some(format!("`{}` is not a usable plugin id", manifest.id));
    }
    if manifest.name.trim().is_empty() {
        return Some("the plugin has no name".to_string());
    }
    if manifest.api_version != PLUGIN_API_VERSION {
        return Some(format!(
            "written for plugin API {}, this Aime speaks {PLUGIN_API_VERSION}",
            manifest.api_version
        ));
    }
    let unknown: Vec<&str> = manifest
        .capabilities
        .iter()
        .map(String::as_str)
        .filter(|capability| !KNOWN_CAPABILITIES.contains(capability))
        .collect();
    if !unknown.is_empty() {
        return Some(format!(
            "asks for something Aime has no name for: {}",
            unknown.join(", ")
        ));
    }
    if manifest.main.trim().is_empty() {
        return Some("the manifest names no script to run".to_string());
    }
    let entry = dir.join(&manifest.main);
    // Compared after normalizing, so `sub/../main.js` is fine and `../main.js`
    // is not - the file may not exist yet, so this is textual, not `canonicalize`.
    if !normalize(&entry).starts_with(normalize(dir)) {
        return Some(format!("`{}` is outside the plugin's folder", manifest.main));
    }
    None
}

/// The capabilities Aime knows how to grant. Mirrored in `lib/plugins/protocol.ts`,
/// and the two are kept honest by a test on each side.
pub const KNOWN_CAPABILITIES: &[&str] = &["editor", "files", "ui"];

/// Path with `.` and `..` resolved textually and separators unified.
fn normalize(path: &Path) -> PathBuf {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::CurDir => {}
            other => parts.push(other.as_os_str().to_os_string()),
        }
    }
    parts.iter().collect()
}

fn read_manifest(dir: &Path) -> Option<PluginManifest> {
    let text = std::fs::read_to_string(dir.join(MANIFEST_FILE)).ok()?;
    match serde_json::from_str::<PluginManifest>(&text) {
        Ok(manifest) => Some(manifest),
        Err(err) => {
            eprintln!("[plugins] ignoring {}: {err}", dir.display());
            None
        }
    }
}

/// Every plugin installed on this machine, with whatever is wrong with it.
#[tauri::command]
pub fn plugin_list(app: AppHandle) -> Vec<InstalledPlugin> {
    let Ok(dir) = plugins_dir(&app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new(); // nothing installed yet is not a problem
    };
    let mut plugins: Vec<InstalledPlugin> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let dir = entry.path();
            let manifest = read_manifest(&dir)?;
            Some(InstalledPlugin {
                problem: problem_with(&manifest, &dir),
                manifest,
                dir: dir.to_string_lossy().to_string(),
            })
        })
        .collect();
    plugins.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    plugins
}

/// The source of one plugin, for the Worker that will run it.
///
/// Read here rather than in the webview because the plugins folder is Aime's own
/// data directory, and because this is the one place that re-checks the manifest
/// before handing code over - a plugin edited between listing and running does
/// not get to skip the checks.
#[tauri::command]
pub fn plugin_source(app: AppHandle, id: String) -> Result<String, String> {
    if !is_safe_id(&id) {
        return Err(format!("`{id}` is not a usable plugin id"));
    }
    let dir = plugins_dir(&app)?.join(&id);
    let manifest = read_manifest(&dir).ok_or_else(|| format!("{id} has no readable {MANIFEST_FILE}"))?;
    if manifest.id != id {
        return Err(format!("{id} declares a different id ({})", manifest.id));
    }
    if let Some(problem) = problem_with(&manifest, &dir) {
        return Err(problem);
    }
    std::fs::read_to_string(dir.join(&manifest.main))
        .map_err(|e| format!("Could not read {}: {e}", manifest.main))
}

/// The folder to drop a plugin into, so the UI can offer to open it.
#[tauri::command]
pub fn plugins_folder(app: AppHandle) -> Result<String, String> {
    let dir = plugins_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{problem_with, PluginManifest, PLUGIN_API_VERSION};
    use std::path::Path;

    fn manifest(main: &str, capabilities: &[&str]) -> PluginManifest {
        PluginManifest {
            id: "sort-lines".into(),
            name: "Sort lines".into(),
            version: "1.0.0".into(),
            description: String::new(),
            main: main.into(),
            capabilities: capabilities.iter().map(|c| (*c).to_string()).collect(),
            api_version: PLUGIN_API_VERSION,
        }
    }

    const DIR: &str = r"C:\data\plugins\sort-lines";

    #[test]
    fn a_plugin_that_declares_itself_properly_has_no_problem() {
        assert_eq!(
            problem_with(&manifest("main.js", &["editor"]), Path::new(DIR)),
            None
        );
    }

    /// The check that matters: a manifest must not be able to point Aime at a
    /// file outside the plugin, which would run something nobody installed.
    #[test]
    fn an_entry_point_outside_the_plugin_folder_is_refused() {
        let problem = problem_with(&manifest("../../../secrets.js", &[]), Path::new(DIR));
        assert!(
            problem.is_some_and(|p| p.contains("outside the plugin's folder")),
            "escaping the folder must be refused"
        );
        // A path that wanders and comes back is still inside it.
        assert_eq!(
            problem_with(&manifest("lib/../main.js", &[]), Path::new(DIR)),
            None
        );
    }

    #[test]
    fn a_capability_aime_has_no_name_for_is_refused_rather_than_ignored() {
        let problem = problem_with(&manifest("main.js", &["editor", "network"]), Path::new(DIR));
        assert!(
            problem.is_some_and(|p| p.contains("network")),
            "unknown capabilities must be named"
        );
    }

    #[test]
    fn a_plugin_written_for_another_api_is_told_so() {
        let mut old = manifest("main.js", &[]);
        old.api_version = 0;
        assert!(problem_with(&old, Path::new(DIR)).is_some_and(|p| p.contains("plugin API")));
    }

    #[test]
    fn an_id_that_could_escape_a_path_or_a_key_is_refused() {
        for bad in ["../evil", "with space", "", ".hidden"] {
            let mut broken = manifest("main.js", &[]);
            broken.id = bad.to_string();
            assert!(
                problem_with(&broken, Path::new(DIR)).is_some(),
                "`{bad}` must not pass as an id"
            );
        }
    }
}
