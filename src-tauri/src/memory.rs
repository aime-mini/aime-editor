//! AI memory files (ARCHITECTURE.md §4). Content editing reuses
//! read_file/write_file; this module resolves the well-known paths and keeps
//! the one canonical project file readable by every CLI.

use crate::providers::adapter::adapter_for;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// Canonical project memory. Codex reads it natively; Claude reads it through
/// the import below — one source of truth, so providers cannot desynchronize.
const PROJECT_MEMORY_FILE: &str = "AGENTS.md";
/// Claude's own project file, kept as a pointer only.
const CLAUDE_PROJECT_FILE: &str = "CLAUDE.md";
/// Claude's documented import directive for the canonical file.
const CLAUDE_IMPORT_LINE: &str = "@AGENTS.md";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPaths {
    /// Knowledge that applies to all of the user's projects. Per CLI: no
    /// import mechanism spans both CLIs at the global level.
    pub global_path: String,
    /// `<root>/AGENTS.md`; `None` while no folder is open.
    pub project_path: Option<String>,
    /// Claude's pointer file, shown so the user knows what the bridge touches.
    pub bridge_path: Option<String>,
}

/// One project's memory file, and the pointer file Claude reads it through.
///
/// Provider-free on purpose. The canonical project file is `AGENTS.md` for
/// every CLI, so asking which provider is selected to find it invents a
/// dependency - and that dependency bites: `memory_paths` resolves a *global*
/// path through the provider's adapter, so a user on a CLI they added
/// themselves cannot be given a project path at all. Anything that only needs
/// the project's own file asks for this instead.
#[tauri::command]
pub fn project_memory_paths(root_path: String) -> MemoryPaths {
    let root = Path::new(&root_path);
    MemoryPaths {
        global_path: String::new(),
        project_path: Some(root.join(PROJECT_MEMORY_FILE).to_string_lossy().to_string()),
        bridge_path: Some(root.join(CLAUDE_PROJECT_FILE).to_string_lossy().to_string()),
    }
}

/// Resolves where the selected provider reads its memory from.
#[tauri::command]
pub fn memory_paths(
    app: AppHandle,
    provider_id: String,
    root_path: Option<String>,
) -> Result<MemoryPaths, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let global_path = adapter_for(&provider_id)?
        .global_memory_path(&home)
        .to_string_lossy()
        .to_string();
    let project_root = root_path.map(|root| Path::new(&root).to_path_buf());
    Ok(MemoryPaths {
        global_path,
        project_path: project_root
            .as_ref()
            .map(|root| root.join(PROJECT_MEMORY_FILE).to_string_lossy().to_string()),
        bridge_path: project_root
            .as_ref()
            .map(|root| root.join(CLAUDE_PROJECT_FILE).to_string_lossy().to_string()),
    })
}

/// Returns the new content of Claude's project file when the import is
/// missing, or `None` when it is already there. Existing notes are preserved —
/// the import is only prepended.
fn claude_file_with_import(existing: &str) -> Option<String> {
    if existing.lines().any(|line| line.trim() == CLAUDE_IMPORT_LINE) {
        return None;
    }
    Some(if existing.trim().is_empty() {
        format!("{CLAUDE_IMPORT_LINE}\n")
    } else {
        format!("{CLAUDE_IMPORT_LINE}\n\n{existing}")
    })
}

/// Makes sure Claude also sees the canonical `AGENTS.md`, by keeping the
/// documented import line in the project's `CLAUDE.md`. Called after the
/// project memory is saved, so switching providers never loses knowledge.
#[tauri::command]
pub fn ensure_memory_bridge(root_path: String) -> Result<(), String> {
    let path = Path::new(&root_path).join(CLAUDE_PROJECT_FILE);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    match claude_file_with_import(&existing) {
        None => Ok(()),
        Some(updated) => std::fs::write(&path, updated).map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::claude_file_with_import;

    #[test]
    fn a_missing_import_is_prepended_and_existing_notes_are_kept() {
        let updated = claude_file_with_import("# Project rules\n\nUse tabs.\n").expect("needs the import");
        assert!(updated.starts_with("@AGENTS.md\n\n"));
        assert!(updated.contains("Use tabs."));
    }

    #[test]
    fn an_empty_file_becomes_just_the_import() {
        assert_eq!(
            claude_file_with_import("   \n").expect("needs the import"),
            "@AGENTS.md\n"
        );
    }

    #[test]
    fn an_existing_import_is_left_alone_wherever_it_sits() {
        assert!(claude_file_with_import("# Notes\n@AGENTS.md\n").is_none());
        assert!(claude_file_with_import("  @AGENTS.md  ").is_none());
    }
}
