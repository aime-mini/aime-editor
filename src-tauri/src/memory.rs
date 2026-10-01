//! AI memory files (ARCHITECTURE.md §4). Content editing reuses
//! read_file/write_file; this module resolves the well-known paths and keeps
//! the one canonical project file readable by every CLI.

use serde::Serialize;
use std::path::Path;

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
    /// `<root>/AGENTS.md`.
    pub project_path: String,
}

/// One project's memory file, for whatever writes into it on the user's behalf.
#[tauri::command]
pub fn project_memory_paths(root_path: String) -> MemoryPaths {
    let root = Path::new(&root_path);
    MemoryPaths {
        project_path: root.join(PROJECT_MEMORY_FILE).to_string_lossy().to_string(),
    }
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
