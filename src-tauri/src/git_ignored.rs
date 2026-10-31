//! Which changed paths of a workspace git ignores.
//!
//! A folder written to constantly - a browser profile, a cache, build output -
//! is usually ignored, and none of what follows a change in the workspace (git
//! status, the task list, every message re-checking the paths it names) has
//! anything to learn from it. Git decides (`git check-ignore`), so nested
//! `.gitignore` files, `info/exclude` and the global excludes all count. The
//! ignored folders found are remembered: git cannot re-include anything under
//! an excluded folder, so every later change inside one is known without asking.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The file whose change can make a remembered folder no longer ignored.
const GITIGNORE: &str = ".gitignore";

/// `git check-ignore`'s exit codes: some paths ignored, none ignored. Anything
/// else (128) means it could not tell - the folder is not in a repository, or a
/// path lies outside it - and then nothing is treated as ignored.
const SOME_IGNORED: i32 = 0;
const NONE_IGNORED: i32 = 1;

/// The changed paths of one batch, told apart.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Split {
    pub kept: Vec<String>,
    pub ignored: Vec<String>,
}

pub struct GitIgnored {
    root: PathBuf,
    /// Folders git ignores, each the topmost ignored one on its branch.
    folders: Vec<PathBuf>,
}

impl GitIgnored {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            folders: Vec::new(),
        }
    }

    /// Splits `paths` into the ones git keeps and the ones it ignores.
    pub fn split(&mut self, paths: Vec<String>) -> Split {
        if paths.iter().any(|path| Path::new(path).ends_with(GITIGNORE)) {
            self.folders.clear();
        }
        let (known, unknown): (Vec<String>, Vec<String>) = paths
            .into_iter()
            .partition(|path| self.in_ignored_folder(Path::new(path)));
        let mut split = Split {
            kept: Vec::new(),
            ignored: known,
        };
        if unknown.is_empty() {
            return split;
        }
        let asked = self.with_folders_above(&unknown);
        let ignored = match ask_git(&self.root, &asked) {
            Ok(ignored) => ignored,
            Err(err) => {
                eprintln!(
                    "[git_ignored] could not ask git what it ignores in {}: {err}",
                    self.root.display()
                );
                BTreeSet::new()
            }
        };
        for path in unknown {
            if let Some(folder) = self.topmost_ignored_folder(Path::new(&path), &ignored) {
                if !self.folders.contains(&folder) {
                    self.folders.push(folder);
                }
                split.ignored.push(path);
            } else if ignored.contains(&path) {
                split.ignored.push(path);
            } else {
                split.kept.push(path);
            }
        }
        split
    }

    fn in_ignored_folder(&self, path: &Path) -> bool {
        self.folders.iter().any(|folder| path.starts_with(folder))
    }

    /// The folders between the root and each path, below the root: asked about
    /// with the paths, they say which folder made a path ignored.
    fn folders_between(&self, path: &Path) -> Vec<PathBuf> {
        path.ancestors()
            .skip(1)
            .take_while(|folder| folder.starts_with(&self.root) && *folder != self.root)
            .map(Path::to_path_buf)
            .collect()
    }

    fn with_folders_above(&self, paths: &[String]) -> Vec<String> {
        let mut asked: BTreeSet<String> = paths.iter().cloned().collect();
        for path in paths {
            for folder in self.folders_between(Path::new(path)) {
                asked.insert(folder.to_string_lossy().into_owned());
            }
        }
        asked.into_iter().collect()
    }

    fn topmost_ignored_folder(&self, path: &Path, ignored: &BTreeSet<String>) -> Option<PathBuf> {
        self.folders_between(path)
            .into_iter()
            .rev()
            .find(|folder| ignored.contains(folder.to_string_lossy().as_ref()))
    }
}

/// Asks git which of `paths` it ignores in `root`; it answers with the paths
/// as they were given.
fn ask_git(root: &Path, paths: &[String]) -> Result<BTreeSet<String>, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("git not available: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("could not write to git")?;
    let input: Vec<u8> = paths.iter().flat_map(|path| path.bytes().chain([0])).collect();
    // Written beside the read: git answers while it reads, and a long answer
    // filling its pipe would otherwise stall both sides.
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    writer
        .join()
        .map_err(|_| "the writer to git panicked".to_string())?
        .map_err(|e| format!("could not hand git the paths: {e}"))?;
    match output.status.code() {
        Some(SOME_IGNORED | NONE_IGNORED) => Ok(String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect()),
        _ => Ok(BTreeSet::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::{GitIgnored, Split};
    use std::path::{Path, PathBuf};

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

    /// A repository ignoring a browser-profile folder and log files.
    fn workspace(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aime-git-ignored-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("data/profile/Cache")).expect("mkdir");
        std::fs::create_dir_all(root.join("src")).expect("mkdir");
        git(&root, &["init", "-q"]);
        std::fs::write(root.join(".gitignore"), "data/profile/\n*.log\n").expect("write");
        root
    }

    fn path(root: &Path, relative: &str) -> String {
        root.join(relative).to_string_lossy().into_owned()
    }

    #[test]
    fn tells_the_paths_git_ignores_from_the_ones_it_keeps() {
        let root = workspace("split");
        let cache = path(&root, "data/profile/Cache/f_1");
        let log = path(&root, "src/run.log");
        let source = path(&root, "src/main.ts");
        let split = GitIgnored::new(&root).split(vec![cache.clone(), log.clone(), source.clone()]);
        assert_eq!(
            split,
            Split {
                kept: vec![source],
                ignored: vec![cache, log]
            }
        );
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    #[test]
    fn remembers_an_ignored_folder_and_forgets_it_when_the_ignore_file_changes() {
        let root = workspace("remember");
        let mut ignored = GitIgnored::new(&root);
        ignored.split(vec![path(&root, "data/profile/Cache/f_1")]);
        assert_eq!(ignored.folders, vec![root.join("data/profile")]);
        // Known now without asking: the folder is remembered.
        assert!(ignored.in_ignored_folder(&root.join("data/profile/Cache/f_2")));

        std::fs::write(root.join(".gitignore"), "*.log\n").expect("write");
        let split = ignored.split(vec![
            path(&root, ".gitignore"),
            path(&root, "data/profile/Cache/f_3"),
        ]);
        assert_eq!(split.ignored, Vec::<String>::new());
        assert!(ignored.folders.is_empty());
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    #[test]
    fn keeps_everything_in_a_folder_that_is_not_a_repository() {
        let root = std::env::temp_dir().join(format!("aime-git-ignored-bare-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("mkdir");
        let file = path(&root, "notes.txt");
        let split = GitIgnored::new(&root).split(vec![file.clone()]);
        assert_eq!(split.kept, vec![file]);
        std::fs::remove_dir_all(&root).expect("clean up");
    }
}
