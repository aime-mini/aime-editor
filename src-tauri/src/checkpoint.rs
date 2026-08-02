//! Undo for a whole AI turn.
//!
//! The editor invites the AI to change the project, so the frightening moment
//! is the turn that touched twenty files the user did not want touched. Git
//! protects what was committed; everything since is unprotected, which is
//! precisely where an agent works.
//!
//! A checkpoint is taken before each turn and costs nothing when the AI
//! changes nothing:
//! - `git stash create` writes a commit object for the current worktree
//!   **without touching the index, the worktree, or the stash list** - so a
//!   checkpoint can never disturb what the user was doing.
//! - untracked files are not in that commit, so their paths are listed
//!   separately; restoring deletes the ones the turn introduced.
//!
//! Restoring uses `git restore --worktree`, which leaves the index alone: a
//! user who had staged something keeps it staged.

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// What is needed to put the workspace back the way it was.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Commit object holding the worktree as it was; empty for an empty repo.
    pub sha: String,
    /// Untracked files that already existed, so new ones can be told apart.
    pub untracked: Vec<String>,
}

async fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = command
        .output()
        .await
        .map_err(|e| format!("git not available: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn lines_of(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Takes a checkpoint. Answers `None` outside a git repository, where there is
/// no cheap way to snapshot a project - the UI then simply offers no undo
/// rather than pretending to have one.
#[tauri::command]
pub async fn checkpoint_create(root: String) -> Result<Option<Checkpoint>, String> {
    if git(&root, &["rev-parse", "--is-inside-work-tree"]).await.is_err() {
        return Ok(None);
    }
    // Empty when the worktree matches HEAD; HEAD is then the snapshot.
    let stash = git(&root, &["stash", "create"]).await.unwrap_or_default();
    let sha = if stash.is_empty() {
        git(&root, &["rev-parse", "HEAD"]).await.unwrap_or_default()
    } else {
        stash
    };
    let untracked = git(&root, &["ls-files", "--others", "--exclude-standard"])
        .await
        .map(|text| lines_of(&text))
        .unwrap_or_default();
    Ok(Some(Checkpoint { sha, untracked }))
}

/// Files that differ from a checkpoint - what an undo would change back.
#[tauri::command]
pub async fn checkpoint_diff(root: String, checkpoint: Checkpoint) -> Result<Vec<String>, String> {
    let mut changed = if checkpoint.sha.is_empty() {
        Vec::new()
    } else {
        lines_of(&git(&root, &["diff", "--name-only", &checkpoint.sha]).await?)
    };
    // A file the turn created is a change too, and diff against a commit
    // cannot see it.
    let untracked_now = lines_of(&git(&root, &["ls-files", "--others", "--exclude-standard"]).await?);
    changed.extend(
        untracked_now
            .into_iter()
            .filter(|path| !checkpoint.untracked.contains(path)),
    );
    changed.sort();
    changed.dedup();
    Ok(changed)
}

/// Puts the workspace back to a checkpoint and reports how many files moved.
#[tauri::command]
pub async fn checkpoint_restore(root: String, checkpoint: Checkpoint) -> Result<usize, String> {
    let changed = checkpoint_diff(root.clone(), checkpoint.clone()).await?;
    if checkpoint.sha.is_empty() {
        return Err("This checkpoint has nothing to restore".into());
    }

    // Tracked files first: --worktree leaves the index untouched, so anything
    // the user had staged before the turn stays staged.
    git(
        &root,
        &["restore", "--source", &checkpoint.sha, "--worktree", "--", "."],
    )
    .await?;

    // Then remove what the turn created. Only files that were untracked
    // before are spared; nothing tracked is ever deleted here.
    let untracked_now = lines_of(&git(&root, &["ls-files", "--others", "--exclude-standard"]).await?);
    for path in untracked_now {
        if checkpoint.untracked.contains(&path) {
            continue;
        }
        let absolute = std::path::Path::new(&root).join(&path);
        std::fs::remove_file(&absolute).map_err(|e| format!("could not remove {path}: {e}"))?;
    }
    Ok(changed.len())
}

#[cfg(test)]
mod tests {
    use super::{lines_of, Checkpoint};

    #[test]
    fn git_output_becomes_a_clean_list() {
        assert_eq!(lines_of("a.rs\n\nb.rs\n"), vec!["a.rs", "b.rs"]);
        assert!(lines_of("   \n").is_empty());
    }

    #[test]
    fn a_checkpoint_round_trips_through_json() {
        let checkpoint = Checkpoint {
            sha: "abc123".into(),
            untracked: vec!["notes.md".into()],
        };
        let json = serde_json::to_string(&checkpoint).expect("serializes");
        // camelCase on the wire, because the frontend stores it in the session.
        assert!(json.contains("\"untracked\""));
        assert_eq!(
            serde_json::from_str::<Checkpoint>(&json).expect("deserializes"),
            checkpoint
        );
    }
}
