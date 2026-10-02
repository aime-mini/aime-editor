//! A mirror of a project's memory (`.aime/memory/`, `lib/knowledge.ts`) in
//! Aime's own data folder.
//!
//! The memories live in the repository so every CLI can read and write them,
//! and `.aime/` keeps itself out of git (`aime_dir`) - so a fresh clone, or
//! the same repository on another machine, would start knowing nothing. This
//! keeps a copy per repository under the app data dir, keyed by the remote it
//! is cloned from (the one identity a clone shares with its original) or by
//! its path when it has none.
//!
//! The project's folder is the truth whenever it exists: what is there is
//! mirrored, what was removed there is removed here. The mirror speaks only
//! when the folder is missing altogether - a clone, a project folder made
//! again - and then everything comes back. An emptied project folder is not
//! a missing one: deleting the last memory is a decision, not a loss.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

/// Where the memories live inside a project (`MEMORY_DIR` in `lib/knowledge.ts`).
const MEMORY_DIR: &str = ".aime/memory";
/// Under the app data dir: one folder per repository identity.
const MIRROR_DIR: &str = "memory-mirror";
/// The one page an earlier Aime wrote beside the memories; never a memory itself.
const LEGACY_INDEX: &str = "INDEX.md";

/// What one sync did, for the caller's log and the tests.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    /// Memories put back into a project whose folder was missing.
    pub restored: usize,
    /// Memory files written to the mirror because they were new or changed there.
    pub mirrored: usize,
}

/// Before a project's memory is read: puts it back if the folder is gone, mirrors it otherwise.
#[tauri::command]
pub fn memory_mirror_sync(app: AppHandle, root: String) -> Result<Synced, String> {
    sync(&app, Path::new(&root)).map_err(|e| e.to_string())
}

/// After a turn in `cwd`, which may have written memories. A mirror that
/// cannot be written costs the safety net, never the turn, and says so.
pub fn after_turn(app: &AppHandle, cwd: &Path) {
    if let Err(err) = sync(app, cwd) {
        eprintln!(
            "[memory_mirror] could not mirror the memory of '{}': {err}",
            cwd.display()
        );
    }
}

fn sync(app: &AppHandle, root: &Path) -> io::Result<Synced> {
    let data_dir = app.path().app_data_dir().map_err(io::Error::other)?;
    let synced = sync_into(&data_dir.join(MIRROR_DIR), root)?;
    if synced.restored > 0 {
        // The folder was just born in someone's repository: keep it out of their commits.
        crate::aime_dir::ensure_self_ignored(root)?;
    }
    Ok(synced)
}

/// The sync itself, against any mirror folder - the tests give it a throwaway one.
fn sync_into(mirrors: &Path, root: &Path) -> io::Result<Synced> {
    // A linked worktree has no memory of its own (`.aime/` is not in git) and
    // shares its remote with the main tree: restoring into it, then mirroring
    // its copy back, would overwrite the main tree's memory with a stale one.
    if is_linked_worktree(root) {
        return Ok(Synced::default());
    }
    let project = root.join(MEMORY_DIR);
    let mirror = mirrors.join(mirror_key(root));
    if !project.is_dir() {
        let saved = memory_files(&mirror)?;
        if saved.is_empty() {
            return Ok(Synced::default());
        }
        fs::create_dir_all(&project)?;
        for (name, content) in &saved {
            fs::write(project.join(name), content)?;
        }
        return Ok(Synced {
            restored: saved.len(),
            mirrored: 0,
        });
    }
    let kept = memory_files(&project)?;
    let saved = memory_files(&mirror)?;
    if kept.is_empty() && saved.is_empty() {
        return Ok(Synced::default());
    }
    fs::create_dir_all(&mirror)?;
    let mut mirrored = 0;
    for (name, content) in &kept {
        if saved.get(name) != Some(content) {
            fs::write(mirror.join(name), content)?;
            mirrored += 1;
        }
    }
    for name in saved.keys().filter(|name| !kept.contains_key(*name)) {
        fs::remove_file(mirror.join(name))?;
    }
    Ok(Synced {
        restored: 0,
        mirrored,
    })
}

/// In a linked worktree `.git` is a file pointing at the main repository.
fn is_linked_worktree(root: &Path) -> bool {
    root.join(".git").is_file()
}

/// The memory files of one folder, by name: the top-level `.md` files with
/// something in them. An emptied file is how an AI deletes a memory, so it
/// counts as gone; the per-folder index pages live in a subfolder and are
/// derived, so they are not carried.
fn memory_files(dir: &Path) -> io::Result<BTreeMap<String, Vec<u8>>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(err) => return Err(err),
    };
    let mut files = BTreeMap::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.file_type()?.is_file() || !name.ends_with(".md") || name == LEGACY_INDEX {
            continue;
        }
        let content = fs::read(entry.path())?;
        if content.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        files.insert(name, content);
    }
    Ok(files)
}

/// The folder name of a repository's mirror: readable, stable, and the same
/// for every clone of it.
fn mirror_key(root: &Path) -> String {
    let identity = remote_identity(root).unwrap_or_else(|| path_identity(root));
    crate::session::store_key(&identity)
}

/// The project's own path, resolved, for a repository with no remote (or no git).
fn path_identity(root: &Path) -> String {
    fs::canonicalize(root)
        .unwrap_or_else(|_| PathBuf::from(root))
        .to_string_lossy()
        .replace('\\', "/")
}

/// The remote `origin` is cloned from, as git reports it; None without one.
fn remote_identity(root: &Path) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(["config", "--get", "remote.origin.url"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    normalize_remote(&String::from_utf8_lossy(&output.stdout))
}

/// One spelling for every way of writing the same remote: `https://host/org/repo.git`,
/// `git@host:org/repo.git` and `ssh://git@host/org/repo` all become `host/org/repo`.
fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let without_scheme = match url.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        // scp-like `user@host:path` - the colon stands where the first slash would.
        None => url.replacen(':', "/", 1),
    };
    let without_user = match without_scheme.split_once('@') {
        Some((_, rest)) => rest.to_string(),
        None => without_scheme,
    };
    let bare = without_user
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');
    Some(bare.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::{normalize_remote, sync_into, Synced};
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A fresh folder per test; the name keeps concurrent tests apart.
    fn fresh(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aime-memory-mirror-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_memory(project: &Path, name: &str, summary: &str) {
        let dir = project.join(".aime/memory");
        fs::create_dir_all(&dir).expect("memory dir");
        fs::write(
            dir.join(format!("{name}.md")),
            format!("---\nname: {name}\nkind: decision\nscope: /\nsummary: {summary}\n---\n"),
        )
        .expect("memory file");
    }

    fn names(dir: &Path) -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .map(|entry| entry.expect("entry").file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    fn mirror_of(mirrors: &Path) -> PathBuf {
        let folders = names(mirrors);
        assert_eq!(folders.len(), 1, "one mirror per project: {folders:?}");
        mirrors.join(&folders[0])
    }

    #[test]
    fn every_spelling_of_a_remote_is_one_identity() {
        let expected = Some("github.com/iodm/aime-editor".to_string());
        assert_eq!(
            normalize_remote("https://github.com/IODM/aime-editor.git\n"),
            expected
        );
        assert_eq!(normalize_remote("git@github.com:iodm/aime-editor.git"), expected);
        assert_eq!(
            normalize_remote("ssh://git@github.com/iodm/aime-editor"),
            expected
        );
        assert_eq!(
            normalize_remote("https://linh@github.com/iodm/aime-editor/"),
            expected
        );
        assert_eq!(normalize_remote("  "), None);
    }

    #[test]
    fn a_project_with_memories_is_mirrored_and_a_missing_folder_is_restored_from_it() {
        let base = fresh("restore");
        let (mirrors, project) = (base.join("mirrors"), base.join("project"));
        write_memory(&project, "cents", "Prices are integer cents");
        write_memory(&project, "gone", "");
        fs::write(project.join(".aime/memory/gone.md"), "  \n").expect("emptied memory");
        fs::write(project.join(".aime/memory/INDEX.md"), "# old index\n").expect("legacy page");

        let synced = sync_into(&mirrors, &project).expect("mirrored");
        assert_eq!(
            synced,
            Synced {
                restored: 0,
                mirrored: 1
            }
        );
        assert_eq!(
            names(&mirror_of(&mirrors)),
            ["cents.md"],
            "emptied and legacy files stay out"
        );

        fs::remove_dir_all(project.join(".aime")).expect("the clone has no .aime");
        let synced = sync_into(&mirrors, &project).expect("restored");
        assert_eq!(
            synced,
            Synced {
                restored: 1,
                mirrored: 0
            }
        );
        let back = fs::read_to_string(project.join(".aime/memory/cents.md")).expect("memory back");
        assert!(back.contains("Prices are integer cents"));
    }

    #[test]
    fn the_project_folder_is_the_truth_while_it_exists() {
        let base = fresh("truth");
        let (mirrors, project) = (base.join("mirrors"), base.join("project"));
        write_memory(&project, "a", "first");
        write_memory(&project, "b", "second");
        sync_into(&mirrors, &project).expect("mirrored");

        // One memory deleted, one changed, none added: the mirror follows.
        fs::remove_file(project.join(".aime/memory/a.md")).expect("deleted");
        write_memory(&project, "b", "second, revised");
        let synced = sync_into(&mirrors, &project).expect("mirrored again");
        assert_eq!(
            synced,
            Synced {
                restored: 0,
                mirrored: 1
            }
        );
        let mirror = mirror_of(&mirrors);
        assert_eq!(names(&mirror), ["b.md"]);
        assert!(fs::read_to_string(mirror.join("b.md"))
            .expect("mirrored b")
            .contains("revised"));

        // The last memory deleted on purpose: an empty folder is not restored.
        fs::remove_file(project.join(".aime/memory/b.md")).expect("deleted");
        let synced = sync_into(&mirrors, &project).expect("mirror emptied");
        assert_eq!(synced, Synced::default());
        assert!(names(&mirror).is_empty());
    }

    #[test]
    fn a_linked_worktree_is_left_alone() {
        let base = fresh("worktree");
        let (mirrors, project) = (base.join("mirrors"), base.join("worktree"));
        fs::create_dir_all(&project).expect("worktree");
        fs::write(project.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").expect("git file");
        write_memory(&project, "stale", "an old copy");

        assert_eq!(sync_into(&mirrors, &project).expect("skipped"), Synced::default());
        assert!(!mirrors.exists(), "nothing was mirrored from the worktree");
    }

    #[test]
    fn a_project_that_never_remembered_anything_gets_no_mirror_folder() {
        let base = fresh("nothing");
        let (mirrors, project) = (base.join("mirrors"), base.join("project"));
        fs::create_dir_all(&project).expect("project");

        assert_eq!(
            sync_into(&mirrors, &project).expect("nothing to do"),
            Synced::default()
        );
        assert!(!mirrors.exists());
        assert!(!project.join(".aime").exists());
    }
}
