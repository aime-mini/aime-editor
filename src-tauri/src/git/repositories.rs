//! Which git repositories a workspace holds.
//!
//! A folder that is opened is not always a repository's root. It can sit inside
//! one - a package opened on its own - or hold several side by side, the way a
//! product folder holds its frontend and its backend. VS Code finds both
//! (`git.autoRepositoryDetection`). Measured 2026-09-24, Aime found neither: the
//! parent folder answered "not a git repository", and a folder inside a
//! repository got paths relative to a root nobody had asked git for, so the
//! tree's badges and staging pointed one level off.

use std::path::{Component, Path, PathBuf};
use tokio::process::Command;

/// How deep below the workspace a repository is looked for. Two levels reach
/// `product/frontend` and `product/apps/web`; VS Code's default stops at one.
const SCAN_DEPTH: usize = 2;

/// Folders never searched: dependencies and build output hold other people's
/// repositories, or thousands of folders and none of the user's.
const SKIPPED: &[&str] = &["node_modules", "target", "bin", "obj", "dist", "build", "vendor"];

/// Every repository the workspace holds, each root spelled the way the
/// workspace's own path is spelled - so a path under it compares as a prefix
/// even when the folder was opened by its 8.3 short name. The repository the
/// workspace sits in comes first, the ones below it after, in path order.
#[tauri::command]
pub async fn git_repositories(root: String) -> Result<Vec<String>, String> {
    let workspace = PathBuf::from(&root);
    let mut found = Vec::new();
    if let Some(enclosing) = enclosing_repository(&workspace).await {
        found.push(enclosing);
    }
    let scanned = tokio::task::spawn_blocking(move || {
        let mut below = Vec::new();
        scan(&workspace, SCAN_DEPTH, &mut below);
        below.sort();
        below
    })
    .await
    .map_err(|err| format!("could not look for repositories in {root}: {err}"))?;
    for repository in scanned {
        if !found.contains(&repository) {
            found.push(repository);
        }
    }
    Ok(found
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

/// The repository `folder` is inside of, reached from `folder` itself.
///
/// `--show-cdup` rather than `--show-toplevel`: the top level comes back
/// canonical (the long name, forward slashes), while walking up from the
/// workspace keeps its spelling and every path under it comparable.
async fn enclosing_repository(folder: &Path) -> Option<PathBuf> {
    let mut command = Command::new("git");
    command.arg("-C").arg(folder).args(["rev-parse", "--show-cdup"]);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = command.output().await.ok()?;
    if !output.status.success() {
        return None; // not inside a repository at all
    }
    let up = String::from_utf8_lossy(&output.stdout);
    Some(walk_up(folder, up.trim()))
}

/// `folder` followed by a relative path made only of `..` - resolved on the path
/// itself, never on the disk, so the spelling it started with survives.
fn walk_up(folder: &Path, relative: &str) -> PathBuf {
    let mut path = folder.to_path_buf();
    for component in Path::new(relative).components() {
        if component == Component::ParentDir {
            path.pop();
        }
    }
    path
}

/// Collects the repositories below `dir`, not descending into one once found:
/// what lives inside a repository is that repository's business (submodules).
fn scan(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // unreadable folders hold nothing we could open anyway
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Symlinks are not followed: a link back up the tree would loop.
        if !kind.is_dir() || name.starts_with('.') || SKIPPED.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        if path.join(".git").exists() {
            found.push(path);
        } else {
            scan(&path, depth - 1, found);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{git_repositories, walk_up};
    use std::path::{Path, PathBuf};

    fn init(dir: &Path) {
        std::fs::create_dir_all(dir).expect("mkdir");
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git init: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn found_in(root: &Path) -> Vec<String> {
        tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(git_repositories(root.to_string_lossy().to_string()))
            .expect("looked")
    }

    fn spelled(path: PathBuf) -> String {
        path.to_string_lossy().to_string()
    }

    /// The layout the user named: a product folder holding its two repositories,
    /// next to the folders that must never be searched.
    #[test]
    fn a_folder_holding_repositories_side_by_side_finds_each_of_them() {
        let base = std::env::temp_dir().join(format!("aime-repos-{}", std::process::id()));
        let product = base.join("IODM");
        init(&product.join("frontend"));
        init(&product.join("backend"));
        init(&product.join("apps").join("web")); // two levels down
        init(&product.join("node_modules").join("left-pad")); // someone else's
        init(&product.join("frontend").join("vendored")); // inside a found repository
        std::fs::create_dir_all(product.join("docs")).expect("mkdir");

        assert_eq!(
            found_in(&product),
            vec![
                spelled(product.join("apps").join("web")),
                spelled(product.join("backend")),
                spelled(product.join("frontend")),
            ]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_folder_inside_a_repository_finds_the_repository_in_its_own_spelling() {
        let base = std::env::temp_dir().join(format!("aime-enclosing-{}", std::process::id()));
        let repository = base.join("frontend");
        init(&repository);
        let inside = repository.join("src").join("components");
        std::fs::create_dir_all(&inside).expect("mkdir");

        assert_eq!(found_in(&inside), vec![spelled(repository.clone())]);
        // The root itself is its own repository, and it is not listed twice.
        assert_eq!(found_in(&repository), vec![spelled(repository)]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_folder_with_no_repository_anywhere_finds_none() {
        let base = std::env::temp_dir().join(format!("aime-norepo-{}", std::process::id()));
        std::fs::create_dir_all(base.join("notes")).expect("mkdir");
        // The temp folder itself must not be inside a repository for this to mean anything.
        assert!(found_in(&base).is_empty(), "{:?}", found_in(&base));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn walking_up_keeps_the_spelling_the_path_started_with() {
        // An 8.3 short name, the spelling a canonical path would have replaced.
        let repository = Path::new("LINHPH~1.STS").join("IODM").join("frontend");
        let inside = repository.join("src");
        assert_eq!(walk_up(&inside, "../"), repository);
        assert_eq!(walk_up(&inside, ""), inside);
    }
}
