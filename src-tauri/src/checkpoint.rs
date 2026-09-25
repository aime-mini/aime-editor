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
//!
//! A workspace is not always one repository - a product folder holds its
//! frontend and its backend side by side - and a turn can change any of them,
//! so a checkpoint holds one snapshot per repository (`git::repositories`).
//! Git runs from each repository's own root, where every path it names is
//! relative to that root; asked from a folder inside it, `diff` and `ls-files`
//! answer relative to different places.

use crate::git::repositories::repositories_in;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// What is needed to put the workspace back the way it was.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(from = "StoredCheckpoint")]
pub struct Checkpoint {
    pub repositories: Vec<RepositoryCheckpoint>,
}

/// One repository as it stood before the turn.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCheckpoint {
    /// The repository's root; empty in a checkpoint from before repositories
    /// were told apart, which was always taken in the workspace itself.
    pub root: String,
    /// Commit object holding the worktree as it was; empty for an empty repo.
    pub sha: String,
    /// Untracked files that already existed, so new ones can be told apart.
    pub untracked: Vec<String>,
}

/// A checkpoint as a chat session stored it: this version's, or the single
/// snapshot sessions saved before there could be several.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredCheckpoint {
    Repositories { repositories: Vec<RepositoryCheckpoint> },
    Single { sha: String, untracked: Vec<String> },
}

impl From<StoredCheckpoint> for Checkpoint {
    fn from(stored: StoredCheckpoint) -> Self {
        let repositories = match stored {
            StoredCheckpoint::Repositories { repositories } => repositories,
            StoredCheckpoint::Single { sha, untracked } => vec![RepositoryCheckpoint {
                root: String::new(),
                sha,
                untracked,
            }],
        };
        Self { repositories }
    }
}

impl RepositoryCheckpoint {
    /// Where this snapshot's git runs: its root, or the workspace for an old one.
    fn root_in(&self, workspace: &Path) -> PathBuf {
        if self.root.is_empty() {
            workspace.to_path_buf()
        } else {
            PathBuf::from(&self.root)
        }
    }
}

async fn git(root: &Path, args: &[&str]) -> Result<String, String> {
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

async fn untracked_in(root: &Path) -> Result<Vec<String>, String> {
    Ok(lines_of(
        &git(root, &["ls-files", "--others", "--exclude-standard"]).await?,
    ))
}

/// Takes a checkpoint of every repository in the workspace. Answers `None`
/// where there is none, since there is no cheap way to snapshot a folder git
/// does not keep - the UI then simply offers no undo rather than pretending
/// to have one.
#[tauri::command]
pub async fn checkpoint_create(root: String) -> Result<Option<Checkpoint>, String> {
    let mut repositories = Vec::new();
    for repository in repositories_in(Path::new(&root)).await? {
        repositories.push(snapshot(&repository).await);
    }
    Ok((!repositories.is_empty()).then_some(Checkpoint { repositories }))
}

async fn snapshot(root: &Path) -> RepositoryCheckpoint {
    // Empty when the worktree matches HEAD; HEAD is then the snapshot.
    let stash = git(root, &["stash", "create"]).await.unwrap_or_default();
    let sha = if stash.is_empty() {
        git(root, &["rev-parse", "HEAD"]).await.unwrap_or_default()
    } else {
        stash
    };
    RepositoryCheckpoint {
        root: root.to_string_lossy().to_string(),
        sha,
        untracked: untracked_in(root).await.unwrap_or_default(),
    }
}

/// Files that differ from a checkpoint - what an undo would change back -
/// named from the workspace, the way the person reading them knows the project.
#[tauri::command]
pub async fn checkpoint_diff(root: String, checkpoint: Checkpoint) -> Result<Vec<String>, String> {
    let workspace = Path::new(&root);
    let mut changed = Vec::new();
    for repository in &checkpoint.repositories {
        let repository_root = repository.root_in(workspace);
        for path in changed_in(&repository_root, repository).await? {
            changed.push(shown_from(workspace, &repository_root, &path));
        }
    }
    changed.sort();
    changed.dedup();
    Ok(changed)
}

/// The files of one repository that differ from its snapshot, as git names them.
async fn changed_in(root: &Path, checkpoint: &RepositoryCheckpoint) -> Result<Vec<String>, String> {
    let mut changed = if checkpoint.sha.is_empty() {
        Vec::new()
    } else {
        lines_of(&git(root, &["diff", "--name-only", &checkpoint.sha]).await?)
    };
    // A file the turn created is a change too, and diff against a commit
    // cannot see it.
    changed.extend(
        untracked_in(root)
            .await?
            .into_iter()
            .filter(|path| !checkpoint.untracked.contains(path)),
    );
    Ok(changed)
}

/// A path git named in `repository`, relative to the workspace when it lies
/// inside it - and whole when a turn reached outside it, which a folder opened
/// from inside a repository allows.
fn shown_from(workspace: &Path, repository: &Path, git_path: &str) -> String {
    let path = repository.join(git_path);
    match path.strip_prefix(workspace) {
        Ok(inside) => inside.to_string_lossy().replace('\\', "/"),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

/// Puts the workspace back to a checkpoint and reports how many files moved.
///
/// Every repository is checked before any is touched: an undo that stopped
/// halfway would leave a project nobody asked for.
#[tauri::command]
pub async fn checkpoint_restore(root: String, checkpoint: Checkpoint) -> Result<usize, String> {
    let workspace = Path::new(&root);
    let mut touched = Vec::new();
    for repository in &checkpoint.repositories {
        let repository_root = repository.root_in(workspace);
        let changed = changed_in(&repository_root, repository).await?;
        if changed.is_empty() {
            continue;
        }
        if repository.sha.is_empty() {
            return Err(format!(
                "{} has no commit to go back to, so this turn cannot be undone there",
                repository_root.display()
            ));
        }
        touched.push((repository_root, repository, changed.len()));
    }
    let mut restored = 0;
    for (repository_root, repository, count) in touched {
        restore(&repository_root, repository).await?;
        restored += count;
    }
    Ok(restored)
}

async fn restore(root: &Path, checkpoint: &RepositoryCheckpoint) -> Result<(), String> {
    // Tracked files first: --worktree leaves the index untouched, so anything
    // the user had staged before the turn stays staged.
    git(
        root,
        &["restore", "--source", &checkpoint.sha, "--worktree", "--", "."],
    )
    .await?;

    // Then remove what the turn created. Only files that were untracked
    // before are spared; nothing tracked is ever deleted here.
    for path in untracked_in(root).await? {
        if checkpoint.untracked.contains(&path) {
            continue;
        }
        std::fs::remove_file(root.join(&path)).map_err(|e| format!("could not remove {path}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{checkpoint_create, checkpoint_diff, checkpoint_restore, lines_of, Checkpoint};
    use std::path::Path;

    #[test]
    fn git_output_becomes_a_clean_list() {
        assert_eq!(lines_of("a.rs\n\nb.rs\n"), vec!["a.rs", "b.rs"]);
        assert!(lines_of("   \n").is_empty());
    }

    #[test]
    fn a_checkpoint_round_trips_through_json() {
        let json =
            r#"{"repositories":[{"root":"C:\\IODM\\backend","sha":"abc123","untracked":["notes.md"]}]}"#;
        let checkpoint: Checkpoint = serde_json::from_str(json).expect("deserializes");
        assert_eq!(checkpoint.repositories[0].untracked, vec!["notes.md"]);
        let again = serde_json::to_string(&checkpoint).expect("serializes");
        assert_eq!(
            serde_json::from_str::<Checkpoint>(&again).expect("reads back"),
            checkpoint
        );
    }

    /// Chat sessions saved before a workspace could hold several repositories
    /// carry one snapshot of the workspace; undoing one of their turns must
    /// still work.
    #[test]
    fn a_checkpoint_stored_before_repositories_were_told_apart_still_reads() {
        let checkpoint: Checkpoint =
            serde_json::from_str(r#"{"sha":"abc123","untracked":["notes.md"]}"#).expect("deserializes");
        let only = &checkpoint.repositories[0];
        assert_eq!((only.root.as_str(), only.sha.as_str()), ("", "abc123"));
        assert_eq!(only.root_in(Path::new("C:\\repo")), Path::new("C:\\repo"));
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repository with one committed file.
    fn repository(dir: &Path, file: &str) {
        std::fs::create_dir_all(dir.join(file).parent().expect("has a folder")).expect("mkdir");
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "t@aime.test"]);
        git(dir, &["config", "user.name", "Aime Test"]);
        // Byte for byte on every machine: a global autocrlf would restore CRLF.
        git(dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join(file), "before\n").expect("write");
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "first"]);
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Runtime::new().expect("runtime").block_on(future)
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).expect("read")
    }

    #[test]
    fn a_turn_across_two_repositories_is_undone_in_both() {
        let base = std::env::temp_dir().join(format!("aime-checkpoint-two-{}", std::process::id()));
        let product = base.join("IODM");
        repository(&product.join("frontend"), "src/app.ts");
        repository(&product.join("backend"), "api/main.rs");
        let root = product.to_string_lossy().to_string();

        let checkpoint = block_on(checkpoint_create(root.clone()))
            .expect("taken")
            .expect("the folder holds repositories");
        assert_eq!(checkpoint.repositories.len(), 2);

        // The turn: one edit in each repository, and a file it made up.
        std::fs::write(product.join("frontend/src/app.ts"), "after\n").expect("write");
        std::fs::write(product.join("backend/api/main.rs"), "after\n").expect("write");
        std::fs::write(product.join("backend/api/new.rs"), "made up\n").expect("write");

        assert_eq!(
            block_on(checkpoint_diff(root.clone(), checkpoint.clone())).expect("diffed"),
            vec!["backend/api/main.rs", "backend/api/new.rs", "frontend/src/app.ts"]
        );
        assert_eq!(
            block_on(checkpoint_restore(root, checkpoint)).expect("restored"),
            3
        );
        assert_eq!(read(&product.join("frontend/src/app.ts")), "before\n");
        assert_eq!(read(&product.join("backend/api/main.rs")), "before\n");
        assert!(
            !product.join("backend/api/new.rs").exists(),
            "the made-up file stayed"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// Opened from inside a repository, the turn is measured and undone from
    /// the repository's root - where `diff` and `ls-files` agree on paths.
    #[test]
    fn a_turn_in_a_folder_inside_a_repository_is_named_from_that_folder() {
        let base = std::env::temp_dir().join(format!("aime-checkpoint-inside-{}", std::process::id()));
        let frontend = base.join("frontend");
        repository(&frontend, "src/app.ts");
        let inside = frontend.join("src");
        let root = inside.to_string_lossy().to_string();

        let checkpoint = block_on(checkpoint_create(root.clone()))
            .expect("taken")
            .expect("in a repository");
        std::fs::write(inside.join("app.ts"), "after\n").expect("write");
        std::fs::write(inside.join("extra.ts"), "made up\n").expect("write");

        assert_eq!(
            block_on(checkpoint_diff(root.clone(), checkpoint.clone())).expect("diffed"),
            vec!["app.ts", "extra.ts"]
        );
        assert_eq!(
            block_on(checkpoint_restore(root, checkpoint)).expect("restored"),
            2
        );
        assert_eq!(read(&inside.join("app.ts")), "before\n");
        assert!(!inside.join("extra.ts").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_folder_with_no_repository_offers_no_undo() {
        let base = std::env::temp_dir().join(format!("aime-checkpoint-none-{}", std::process::id()));
        std::fs::create_dir_all(&base).expect("mkdir");
        let taken = block_on(checkpoint_create(base.to_string_lossy().to_string())).expect("looked");
        assert!(taken.is_none());
        std::fs::remove_dir_all(&base).ok();
    }
}
