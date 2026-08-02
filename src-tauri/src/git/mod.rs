//! Git integration: spawns the system `git` (inherits the user's credentials,
//! SSH setup, and hooks) and parses `status --porcelain=v2 -z`.

use serde::Serialize;
use tokio::process::Command;

#[derive(Serialize, Debug, PartialEq)]
pub struct GitFile {
    /// Path relative to the repo root, forward slashes (as git reports).
    pub path: String,
    /// Previous path for renames.
    pub orig_path: Option<String>,
    /// Index (staged) status letter, " " when clean.
    pub staged: String,
    /// Worktree (unstaged) status letter, " " when clean; "?" = untracked.
    pub unstaged: String,
    pub conflicted: bool,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<GitFile>,
}

/// Runs git in `root` and returns stdout; stderr becomes the error message.
async fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("git not available: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "git failed".to_string()
        } else {
            stderr
        })
    }
}

/// Parses `git status --porcelain=v2 --branch -z` output.
/// Records are NUL-terminated; a rename record ("2") is followed by one extra
/// NUL-separated field carrying the original path.
fn parse_porcelain_v2(text: &str) -> GitStatus {
    let mut status = GitStatus {
        is_repo: true,
        ..GitStatus::default()
    };
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());

    while let Some(record) = tokens.next() {
        if let Some(header) = record.strip_prefix("# ") {
            if let Some(head) = header.strip_prefix("branch.head ") {
                status.branch = Some(head.to_string());
            } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
                status.upstream = Some(upstream.to_string());
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                for part in ab.split(' ') {
                    if let Some(n) = part.strip_prefix('+') {
                        status.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        status.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }

        let mut push_entry = |xy: &str, path: &str, orig: Option<String>, conflicted: bool| {
            let mut chars = xy.chars();
            let staged = chars.next().unwrap_or(' ');
            let unstaged = chars.next().unwrap_or(' ');
            status.files.push(GitFile {
                path: path.to_string(),
                orig_path: orig,
                staged: staged.to_string(),
                unstaged: unstaged.to_string(),
                conflicted,
            });
        };

        match record.split(' ').next() {
            Some("1") => {
                // 1 XY sub mH mI mW hH hI path
                let fields: Vec<&str> = record.splitn(9, ' ').collect();
                if let (Some(xy), Some(path)) = (fields.get(1), fields.get(8)) {
                    push_entry(xy, path, None, false);
                }
            }
            Some("2") => {
                // 2 XY sub mH mI mW hH hI Xscore path  (NUL)  origPath
                let fields: Vec<&str> = record.splitn(10, ' ').collect();
                let orig = tokens.next().map(String::from);
                if let (Some(xy), Some(path)) = (fields.get(1), fields.get(9)) {
                    push_entry(xy, path, orig, false);
                }
            }
            Some("u") => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let fields: Vec<&str> = record.splitn(11, ' ').collect();
                if let (Some(xy), Some(path)) = (fields.get(1), fields.get(10)) {
                    push_entry(xy, path, None, true);
                }
            }
            Some("?") => {
                if let Some(path) = record.strip_prefix("? ") {
                    push_entry(" ?", path, None, false);
                }
            }
            _ => {} // "!" (ignored) and anything unknown
        }
    }
    status
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    match run_git(&root, &["status", "--porcelain=v2", "--branch", "-z"]).await {
        Ok(out) => Ok(parse_porcelain_v2(&out)),
        Err(err) if err.contains("not a git repository") => Ok(GitStatus::default()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(&root, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(&root, &args).await.map(|_| ())
}

/// Discards worktree changes. Untracked files are deleted instead (git can't restore them).
#[tauri::command]
pub async fn git_discard(root: String, path: String, untracked: bool) -> Result<(), String> {
    if untracked {
        let absolute = std::path::Path::new(&root).join(&path);
        return std::fs::remove_file(&absolute).map_err(|e| e.to_string());
    }
    run_git(&root, &["restore", "--", &path]).await.map(|_| ())
}

/// Commit; `amend` rewrites the last commit (keeping its message when the
/// new one is empty — the "fix what I just committed" flow).
#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool) -> Result<String, String> {
    let args: Vec<&str> = match (amend, message.is_empty()) {
        (true, true) => vec!["commit", "--amend", "--no-edit"],
        (true, false) => vec!["commit", "--amend", "-m", &message],
        (false, _) => vec!["commit", "-m", &message],
    };
    run_git(&root, &args).await
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitStashEntry {
    pub index: u32,
    pub message: String,
}

/// Parses `git stash list --pretty=%gd%x00%s` ("stash@{N}" NUL message).
fn parse_stash_list(text: &str) -> Vec<GitStashEntry> {
    text.lines()
        .filter_map(|line| {
            let (gd, message) = line.split_once('\0')?;
            let index = gd.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
            Some(GitStashEntry {
                index,
                message: message.to_string(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_stash_list(root: String) -> Result<Vec<GitStashEntry>, String> {
    match run_git(&root, &["stash", "list", "--pretty=%gd%x00%s"]).await {
        Ok(out) => Ok(parse_stash_list(&out)),
        Err(err) if err.contains("not a git repository") => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

/// Stashes everything including untracked files; message is optional.
#[tauri::command]
pub async fn git_stash_push(root: String, message: String) -> Result<String, String> {
    if message.is_empty() {
        run_git(&root, &["stash", "push", "-u"]).await
    } else {
        run_git(&root, &["stash", "push", "-u", "-m", &message]).await
    }
}

#[tauri::command]
pub async fn git_stash_apply(root: String, index: u32) -> Result<String, String> {
    run_git(&root, &["stash", "apply", &format!("stash@{{{index}}}")]).await
}

#[tauri::command]
pub async fn git_stash_pop(root: String, index: u32) -> Result<String, String> {
    run_git(&root, &["stash", "pop", &format!("stash@{{{index}}}")]).await
}

#[tauri::command]
pub async fn git_stash_drop(root: String, index: u32) -> Result<String, String> {
    run_git(&root, &["stash", "drop", &format!("stash@{{{index}}}")]).await
}

/// Push, and on the classic first-push failure ("no upstream branch")
/// automatically retry with `-u origin HEAD` — no manual setup step.
#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    match run_git(&root, &["push"]).await {
        Err(err) if err.contains("no upstream branch") => {
            run_git(&root, &["push", "-u", "origin", "HEAD"]).await
        }
        other => other,
    }
}

/// Unstaged worktree diff — fallback input for AI commit messages.
#[tauri::command]
pub async fn git_worktree_diff(root: String) -> Result<String, String> {
    run_git(&root, &["diff"]).await
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<String, String> {
    run_git(&root, &["pull", "--ff-only"]).await
}

#[tauri::command]
pub async fn git_init(root: String) -> Result<String, String> {
    run_git(&root, &["init"]).await
}

/// File content at HEAD (empty for files new in this revision) — the diff baseline.
#[tauri::command]
pub async fn git_show_head(root: String, path: String) -> Result<String, String> {
    match run_git(&root, &["show", &format!("HEAD:{path}")]).await {
        Ok(content) => Ok(content),
        Err(_) => Ok(String::new()),
    }
}

/// Unstaged staged diff of everything in the index — input for AI commit messages.
#[tauri::command]
pub async fn git_staged_diff(root: String) -> Result<String, String> {
    run_git(&root, &["diff", "--cached"]).await
}

/// Zero-context unified diff of one file vs HEAD — parsed for editor gutter marks.
#[tauri::command]
pub async fn git_file_diff(root: String, path: String) -> Result<String, String> {
    match run_git(&root, &["diff", "-U0", "HEAD", "--", &path]).await {
        Ok(diff) => Ok(diff),
        Err(_) => Ok(String::new()), // no HEAD yet (fresh repo) → no gutter marks
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitLogEntry {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// Relative time as git renders it ("2 hours ago").
    pub when: String,
    pub subject: String,
}

/// Parses `git log --pretty=format:%H%x00%h%x00%an%x00%ar%x00%s` output
/// (one commit per line, NUL between fields — subjects never contain NUL).
fn parse_log(text: &str) -> Vec<GitLogEntry> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            Some(GitLogEntry {
                hash: fields.next()?.to_string(),
                short: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                when: fields.next()?.to_string(),
                subject: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_log(root: String, limit: u32) -> Result<Vec<GitLogEntry>, String> {
    let count = format!("-n{limit}");
    match run_git(
        &root,
        &["log", &count, "--pretty=format:%H%x00%h%x00%an%x00%ar%x00%s"],
    )
    .await
    {
        Ok(out) => Ok(parse_log(&out)),
        // Fresh repo without commits (or no repo at all) → an empty history, not an error.
        Err(err) if err.contains("does not have any commits") || err.contains("not a git repository") => {
            Ok(Vec::new())
        }
        Err(err) => Err(err),
    }
}

/// Full patch of one commit (stat + diff) for the read-only commit view.
#[tauri::command]
pub async fn git_show_commit(root: String, hash: String) -> Result<String, String> {
    run_git(&root, &["show", "--stat", "--patch", &hash]).await
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<GitBranch>, String> {
    let out = run_git(&root, &["branch", "--format=%(HEAD)%00%(refname:short)"]).await?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let (head, name) = line.split_once('\0')?;
            Some(GitBranch {
                name: name.to_string(),
                current: head == "*",
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_checkout(root: String, name: String) -> Result<String, String> {
    run_git(&root, &["checkout", &name]).await
}

#[tauri::command]
pub async fn git_create_branch(root: String, name: String) -> Result<String, String> {
    run_git(&root, &["checkout", "-b", &name]).await
}

#[tauri::command]
pub async fn git_rename_branch(root: String, from: String, to: String) -> Result<String, String> {
    run_git(&root, &["branch", "-m", &from, &to]).await
}

/// Deletes a branch. Plain delete refuses to drop unmerged work — the UI turns
/// that refusal into an explicit "delete anyway", so losing commits is always
/// a decision the user made, never a side effect.
#[tauri::command]
pub async fn git_delete_branch(root: String, name: String, force: bool) -> Result<String, String> {
    let flag = if force { "-D" } else { "-d" };
    run_git(&root, &["branch", flag, &name]).await
}

/// Merges a branch into the current one. A merge that stops on conflicts is a
/// normal outcome: the conflicted files then appear in the panel's conflict
/// section, where the resolver handles them.
#[tauri::command]
pub async fn git_merge_branch(root: String, name: String) -> Result<String, String> {
    run_git(&root, &["merge", "--no-edit", &name]).await
}

/// A remote and where it points. Aime shows these so a user never has to open
/// a terminal to find out which server a project talks to.
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

/// `git remote -v` lists fetch and push lines per remote; they are almost
/// always the same URL, so one entry per remote is what the UI wants.
fn parse_remotes(text: &str) -> Vec<GitRemote> {
    let mut remotes: Vec<GitRemote> = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else {
            continue;
        };
        if remotes.iter().any(|remote| remote.name == name) {
            continue;
        }
        remotes.push(GitRemote {
            name: name.to_string(),
            url: url.to_string(),
        });
    }
    remotes
}

#[tauri::command]
pub async fn git_remotes(root: String) -> Result<Vec<GitRemote>, String> {
    Ok(parse_remotes(&run_git(&root, &["remote", "-v"]).await?))
}

/// Adds a remote, or repoints an existing one — the user thinks "this project
/// lives here now", not "add versus set-url".
#[tauri::command]
pub async fn git_set_remote(root: String, name: String, url: String) -> Result<String, String> {
    let exists = run_git(&root, &["remote", "-v"])
        .await
        .map(|text| parse_remotes(&text).iter().any(|remote| remote.name == name))
        .unwrap_or(false);
    let action = if exists { "set-url" } else { "add" };
    run_git(&root, &["remote", action, &name, &url]).await
}

/// Refreshes remote branches without touching the working tree; `--prune`
/// drops references to branches deleted on the server.
#[tauri::command]
pub async fn git_fetch(root: String) -> Result<String, String> {
    run_git(&root, &["fetch", "--all", "--prune"]).await
}

#[tauri::command]
pub async fn git_clone(url: String, parent: String, folder: String) -> Result<String, String> {
    run_git(&parent, &["clone", &url, &folder]).await?;
    Ok(std::path::Path::new(&parent)
        .join(&folder)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub async fn git_tags(root: String) -> Result<Vec<String>, String> {
    let text = run_git(&root, &["tag", "--sort=-creatordate"]).await?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// An annotated tag when a message is given (what releases want), a light one
/// otherwise.
#[tauri::command]
pub async fn git_create_tag(root: String, name: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        run_git(&root, &["tag", &name]).await
    } else {
        run_git(&root, &["tag", "-a", &name, "-m", &message]).await
    }
}

#[tauri::command]
pub async fn git_delete_tag(root: String, name: String) -> Result<String, String> {
    run_git(&root, &["tag", "-d", &name]).await
}

#[tauri::command]
pub async fn git_push_tags(root: String) -> Result<String, String> {
    run_git(&root, &["push", "--tags"]).await
}

/// Undoes a commit by adding the opposite one — the safe way to take back
/// work that is already published.
#[tauri::command]
pub async fn git_revert_commit(root: String, sha: String) -> Result<String, String> {
    run_git(&root, &["revert", "--no-edit", &sha]).await
}

#[tauri::command]
pub async fn git_cherry_pick(root: String, sha: String) -> Result<String, String> {
    run_git(&root, &["cherry-pick", &sha]).await
}

/// Moves the current branch to a commit. `soft` keeps the changes staged,
/// `mixed` keeps them in the working tree, `hard` discards them — which is why
/// the UI asks twice for that one.
#[tauri::command]
pub async fn git_reset_to(root: String, sha: String, mode: String) -> Result<String, String> {
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        "mixed" => "--mixed",
        other => return Err(format!("Unknown reset mode: {other}")),
    };
    run_git(&root, &["reset", flag, &sha]).await
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct BlameLine {
    pub sha: String,
    pub author: String,
    /// Unix epoch seconds of the author date (0 for uncommitted lines).
    pub time: i64,
    pub summary: String,
}

/// Parses `git blame --line-porcelain`: every line gets a full header block
/// (sha + metadata tags) followed by one TAB-prefixed content line.
fn parse_blame(text: &str) -> Vec<BlameLine> {
    let mut lines = Vec::new();
    let mut current = BlameLine::default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("author ") {
            current.author = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            current.time = rest.parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("summary ") {
            current.summary = rest.to_string();
        } else if line.starts_with('\t') {
            lines.push(current.clone());
        } else if !line.contains(' ') || line.split(' ').next().is_some_and(|t| t.len() == 40) {
            // New header line: "<40-hex sha> origLine finalLine [numLines]"
            if let Some(sha) = line.split(' ').next() {
                if sha.len() == 40 {
                    // Full sha — the blame view links each line to its commit.
                    current.sha = sha.to_string();
                }
            }
        }
    }
    lines
}

/// Per-line authorship of a file (for inline blame in the editor).
#[tauri::command]
pub async fn git_blame(root: String, path: String) -> Result<Vec<BlameLine>, String> {
    match run_git(&root, &["blame", "--line-porcelain", "--", &path]).await {
        Ok(out) => Ok(parse_blame(&out)),
        Err(_) => Ok(Vec::new()), // untracked / fresh repo → no blame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_header_and_ahead_behind() {
        let text = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0";
        let status = parse_porcelain_v2(text);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert!(status.files.is_empty());
    }

    #[test]
    fn parses_ordinary_untracked_and_conflicted_entries() {
        let text = concat!(
            "1 M. N... 100644 100644 100644 aaaa bbbb src/main.rs\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb README.md\0",
            "? new-file.txt\0",
            "u UU N... 100644 100644 100644 100644 a b c conflicted.rs\0",
        );
        let status = parse_porcelain_v2(text);
        assert_eq!(status.files.len(), 4);
        assert_eq!(
            status.files[0],
            GitFile {
                path: "src/main.rs".into(),
                orig_path: None,
                staged: "M".into(),
                unstaged: ".".into(),
                conflicted: false,
            }
        );
        assert_eq!(status.files[1].unstaged, "M");
        assert_eq!(status.files[2].unstaged, "?");
        assert!(status.files[3].conflicted);
    }

    #[test]
    fn parses_stash_list() {
        let text = "stash@{0}\0WIP on main: abc feat\nstash@{1}\0my stash message";
        let stashes = parse_stash_list(text);
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[1].message, "my stash message");
    }

    #[test]
    fn parses_line_porcelain_blame() {
        let sha = "a".repeat(40);
        let text = format!(
            "{sha} 1 1 2\nauthor Linh\nauthor-time 1700000000\nsummary first commit\n\tline one\n{sha} 2 2\nauthor Linh\nauthor-time 1700000000\nsummary first commit\n\tline two\n"
        );
        let blame = parse_blame(&text);
        assert_eq!(blame.len(), 2);
        assert_eq!(blame[0].sha, "a".repeat(40));
        assert_eq!(blame[0].author, "Linh");
        assert_eq!(blame[1].summary, "first commit");
    }

    #[test]
    fn remotes_are_listed_once_even_though_git_prints_fetch_and_push() {
        let text = "origin	https://github.com/aime-mini/aime-editor.git (fetch)
                    origin	https://github.com/aime-mini/aime-editor.git (push)
                    upstream	git@github.com:other/repo.git (fetch)
                    upstream	git@github.com:other/repo.git (push)
";
        let remotes = super::parse_remotes(text);
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url, "https://github.com/aime-mini/aime-editor.git");
        assert_eq!(remotes[1].url, "git@github.com:other/repo.git");
    }

    #[test]
    fn a_repo_without_remotes_lists_none() {
        assert!(super::parse_remotes("").is_empty());
    }

    #[test]
    fn parses_log_lines() {
        // NUL separators are spelled \x00 where a digit follows, so they cannot
        // be misread (by a human or by clippy) as octal escapes.
        let text = "aaaa\0aaa\0Linh\x002 hours ago\0feat: first\nbbbb\0bbb\0Linh\x003 days ago\0fix: second\0with tail";
        let log = parse_log(text);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].short, "aaa");
        assert_eq!(log[0].subject, "feat: first");
        assert_eq!(log[1].when, "3 days ago");
    }

    #[test]
    fn parses_renames_with_original_path() {
        let text = "2 R. N... 100644 100644 100644 aaaa bbbb R100 new-name.rs\0old-name.rs\0";
        let status = parse_porcelain_v2(text);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "new-name.rs");
        assert_eq!(status.files[0].orig_path.as_deref(), Some("old-name.rs"));
        assert_eq!(status.files[0].staged, "R");
    }
}
