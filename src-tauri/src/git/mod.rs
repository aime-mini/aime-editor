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

/// `--untracked-files=all` is what makes a new folder show its files. Git's
/// default collapses an untracked directory into one record ending in `/`, so a
/// feature branch that adds a whole folder arrives as a single unopenable row -
/// no diff, and discarding it asks `remove_file` to delete a directory.
#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    match run_git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await
    {
        Ok(out) => Ok(parse_porcelain_v2(&out)),
        Err(err) if err.contains("not a git repository") => Ok(GitStatus::default()),
        Err(err) => Err(err),
    }
}

/// Characters of paths one git call may carry. Windows refuses to start a
/// process whose command line passes 32 767 characters ("The filename or
/// extension is too long"), and staging a newly added folder is measured in
/// thousands of paths - 2 000 of them come to 96 000 characters.
const PATH_ARGUMENT_BUDGET: usize = 24_000;

/// Splits paths into runs that fit one command line. A path longer than the
/// whole budget still gets a call of its own: dropping it would lose a file.
fn batches(paths: &[String]) -> Vec<&[String]> {
    let mut batches = Vec::new();
    let mut start = 0;
    let mut length = 0;
    for (index, path) in paths.iter().enumerate() {
        // `length > 0` is what guarantees progress: the first path of a batch
        // is always taken, however long it is.
        if length > 0 && length + path.len() + 1 > PATH_ARGUMENT_BUDGET {
            batches.push(&paths[start..index]);
            start = index;
            length = 0;
        }
        length += path.len() + 1;
    }
    if start < paths.len() {
        batches.push(&paths[start..]);
    }
    batches
}

/// Runs one git subcommand over every path, in as few calls as fit.
async fn run_git_over_paths(root: &str, subcommand: &[&str], paths: &[String]) -> Result<(), String> {
    for batch in batches(paths) {
        let mut args = subcommand.to_vec();
        args.extend(batch.iter().map(String::as_str));
        run_git(root, &args).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    run_git_over_paths(&root, &["add", "--"], &paths).await
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    run_git_over_paths(&root, &["restore", "--staged", "--"], &paths).await
}

/// Turns a repo-relative path into a pattern that matches that path and nothing
/// else. The leading `/` anchors it to the repository root - without it, a name
/// like `debug.log` would ignore every `debug.log` in the project, and a file
/// whose name starts with `#` or `!` would read as a comment or a negation. The
/// backslashes keep the glob characters of a real file name (`page[id].tsx`)
/// literal. A trailing `/` is what tells git the pattern is a directory, so a
/// file called `build` later on is not swept up with the folder called `build`.
fn ignore_pattern(path: &str, is_dir: bool) -> String {
    let mut pattern = String::from("/");
    for character in path.chars() {
        if matches!(character, '\\' | '*' | '?' | '[') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    if is_dir {
        pattern.push('/');
    }
    pattern
}

/// Appends the patterns a `.gitignore` does not already carry, leaving what is
/// there untouched - it is the user's file, and often reviewed by their team.
fn with_patterns(existing: &str, patterns: &[String]) -> String {
    let known: Vec<&str> = existing.lines().map(str::trim).collect();
    let mut text = existing.to_string();
    for pattern in patterns.iter().filter(|p| !known.contains(&p.as_str())) {
        // A file that does not end in a newline would otherwise glue the first
        // new pattern onto its last line.
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(pattern);
        text.push('\n');
    }
    text
}

/// Adds paths to the project's `.gitignore` (created when missing).
#[tauri::command]
pub async fn git_ignore(root: String, paths: Vec<String>) -> Result<(), String> {
    let file = std::path::Path::new(&root).join(".gitignore");
    let existing = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("could not read .gitignore: {err}")),
    };
    // Whether a path is a directory is read off the disk rather than passed in:
    // the caller is a menu, and the answer belongs to the filesystem.
    let root_path = std::path::Path::new(&root);
    let patterns: Vec<String> = paths
        .iter()
        .map(|path| ignore_pattern(path, root_path.join(path).is_dir()))
        .collect();
    let updated = with_patterns(&existing, &patterns);
    if updated == existing {
        return Ok(()); // every path was already ignored
    }
    std::fs::write(&file, updated).map_err(|err| format!("could not write .gitignore: {err}"))
}

/// Stops tracking a path, then ignores it.
///
/// `.gitignore` has no effect on a path git already tracks — the rule applies to
/// untracked paths only — so for a tracked file the two steps are one action or
/// nothing happens at all. `--cached` removes the path from the index and leaves
/// it on disk untouched; the removal becomes real for everyone else at the next
/// commit, which is what the UI has to say out loud before offering this.
#[tauri::command]
pub async fn git_untrack_and_ignore(root: String, paths: Vec<String>) -> Result<(), String> {
    // `-r` because a folder is the case this exists for; `--` so a path that
    // looks like an option is still a path.
    let mut args: Vec<&str> = vec!["rm", "--cached", "-r", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(&root, &args).await?;
    git_ignore(root, paths).await
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

/// The byte order mark, as the character it decodes to (see `fs_cmds::read_file`).
const BOM: char = '\u{feff}';

/// Text for a read-only view, with the byte order mark taken out.
///
/// git hands back the bytes a file really has, and most .cs files of a Visual
/// Studio solution begin with a BOM. The editor already hides it, so leaving it
/// in these strings drew the character on screen again - and worse, made line 1
/// of every such file look changed in the diff view, whose left side comes from
/// git while its right side comes from the editor.
///
/// Removed wherever it appears rather than only at the front, because in a patch
/// the mark sits *after* the line's `+` or leading space - measured against real
/// git output, not assumed. Nothing here is ever written back to disk, so nothing
/// can be lost by dropping it; `fs_cmds::write_file` is what keeps the mark.
fn without_bom(text: String) -> String {
    if text.contains(BOM) {
        text.replace(BOM, "")
    } else {
        text
    }
}

/// Unstaged worktree diff — fallback input for AI commit messages.
#[tauri::command]
pub async fn git_worktree_diff(root: String) -> Result<String, String> {
    run_git(&root, &["diff"]).await.map(without_bom)
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
        Ok(content) => Ok(without_bom(content)),
        Err(_) => Ok(String::new()),
    }
}

/// Unstaged staged diff of everything in the index — input for AI commit messages.
#[tauri::command]
pub async fn git_staged_diff(root: String) -> Result<String, String> {
    run_git(&root, &["diff", "--cached"]).await.map(without_bom)
}

/// Zero-context unified diff of one file vs HEAD — parsed for editor gutter marks.
#[tauri::command]
pub async fn git_file_diff(root: String, path: String) -> Result<String, String> {
    match run_git(&root, &["diff", "-U0", "HEAD", "--", &path]).await {
        Ok(diff) => Ok(without_bom(diff)),
        Err(_) => Ok(String::new()), // no HEAD yet (fresh repo) → no gutter marks
    }
}

/// Paths git ignores, a fully ignored directory collapsed into one entry.
///
/// `--directory` is the design of this call rather than a flag on it: measured
/// on this repository it answers 12 paths in 65 ms where the expanded list is
/// 33 590 paths in 541 ms. The file tree only needs to know where an ignored
/// region begins - everything below it inherits - so `node_modules/` never has
/// to be enumerated to be greyed out.
#[tauri::command]
pub async fn git_ignored(root: String) -> Result<Vec<String>, String> {
    match run_git(
        &root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )
    .await
    {
        Ok(out) => Ok(parse_ignored(&out)),
        Err(_) => Ok(Vec::new()), // not a repository → nothing is ignored
    }
}

/// Splits `-z` output into repo-relative paths, dropping the trailing slash git
/// puts on a directory so that a directory and a file are keyed the same way.
fn parse_ignored(text: &str) -> Vec<String> {
    text.split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.trim_end_matches('/').to_string())
        .collect()
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

/// One file a commit touched.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Path relative to the repo root, forward slashes (as git reports).
    pub path: String,
    /// Where a renamed or copied file came from.
    pub orig_path: Option<String>,
    /// `A`, `M`, `D`, `R`, `C`, `T` — the letter without git's similarity score.
    pub status: String,
    pub added: u32,
    pub removed: u32,
    /// Binary files have no line counts; the two above are then meaningless.
    pub binary: bool,
}

/// A commit as the reader needs it: who, when, why, and what it touched.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub subject: String,
    /// The message past its first line, empty when there is none.
    pub body: String,
    pub author: String,
    /// Seconds since the epoch, formatted where it is shown.
    pub when: i64,
    pub files: Vec<CommitFile>,
}

/// Everything about one commit except the patches themselves.
///
/// The files come back as a list rather than inside one long patch because a
/// commit touching twenty files is unreadable as a wall of text: the reader
/// wants to see what moved and then open the one file they care about. The
/// patch for that file is a separate call ([`git_show_commit_file`]), so a
/// hundred-file commit costs nothing until something is opened.
#[tauri::command]
pub async fn git_commit_detail(root: String, hash: String) -> Result<CommitDetail, String> {
    // `%x00` separates the fields; the body comes last because it is the only
    // one that can itself contain newlines.
    let header = run_git(
        &root,
        &["show", "-s", "--format=%H%x00%an%x00%at%x00%s%x00%b", &hash],
    )
    .await
    .map(without_bom)?;
    let fields: Vec<&str> = header.splitn(5, '\0').collect();

    // `-z` because a rename is otherwise unreadable (see `commit_files`), and
    // `--first-parent` because a merge otherwise lists files whose patch git
    // then refuses to print: measured 2026-08-23 against git 2.40, a merge
    // answers `--numstat` with the files it brought in, `--name-status` with
    // nothing at all, and `--patch` with nothing at all - a viewer showing rows
    // that all open blank. Against the first parent all three agree, and "what
    // this merge brought into this branch" is what the reader came for. A commit
    // with one parent is unaffected: its first parent is its only one.
    let counts = run_git(
        &root,
        &["show", "--format=", "--numstat", "-z", "--first-parent", &hash],
    )
    .await?;
    let statuses = run_git(
        &root,
        &[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "--first-parent",
            &hash,
        ],
    )
    .await?;

    Ok(CommitDetail {
        hash: fields.first().unwrap_or(&"").trim().to_string(),
        author: fields.get(1).unwrap_or(&"").to_string(),
        when: fields.get(2).and_then(|at| at.parse().ok()).unwrap_or_default(),
        subject: fields.get(3).unwrap_or(&"").to_string(),
        body: fields.get(4).unwrap_or(&"").trim_end().to_string(),
        files: commit_files(&counts, &statuses),
    })
}

/// Merges the two things git will only report separately: how many lines moved
/// (`--numstat`) and what kind of change it was (`--name-status`).
///
/// Both are read in git's `-z` form, and that is not a tidiness choice. In the
/// human form a rename is **one** field spelling `old => new` - and, when the
/// two names share a folder, `src/{old => new}.ts` - which is a sentence, not a
/// path. Reading it as a path is what made the commit viewer open a blank pane:
/// the row was called `a.txt => renamed.txt`, git was asked for a file by that
/// name, matched nothing, and printed nothing (measured 2026-08-23 against git
/// 2.40 on a real rename). With `-z` the two names arrive as two fields and
/// records are separated by NUL, so nothing has to be un-spelled.
fn commit_files(counts: &str, statuses: &str) -> Vec<CommitFile> {
    let mut files: Vec<CommitFile> = Vec::new();
    let mut fields = counts.split('\0');
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let mut parts = record.split('\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        // A rename leaves the path of this record empty and writes the old and
        // the new name as the next two fields. The new one is what a reader
        // opens: a list keyed on the old name would open nothing.
        let (orig_path, path) = if path.is_empty() {
            match (fields.next(), fields.next()) {
                // An empty new name is a record git did not finish writing, and
                // a row with no path is a row that opens nothing.
                (Some(old), Some(new)) if !new.is_empty() => (Some(old.to_string()), new.to_string()),
                _ => continue,
            }
        } else {
            (None, path.to_string())
        };
        files.push(CommitFile {
            path,
            orig_path,
            // Binary files are reported as `-` for both counts.
            binary: added == "-",
            added: added.parse().unwrap_or_default(),
            removed: removed.parse().unwrap_or_default(),
            ..CommitFile::default()
        });
    }

    let mut fields = statuses.split('\0');
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        // A rename or a copy carries both names; everything else carries one.
        let renamed = status.starts_with('R') || status.starts_with('C');
        let (Some(first), second) = (fields.next(), renamed.then(|| fields.next()).flatten()) else {
            break;
        };
        if renamed && second.is_none() {
            break;
        }
        let path = second.unwrap_or(first);
        let Some(file) = files.iter_mut().find(|file| file.path == path) else {
            continue;
        };
        // `R100`, `C75`: the score is git's confidence, not something to show.
        file.status = status.chars().take(1).collect();
        if renamed {
            file.orig_path = Some(first.to_string());
        }
    }
    files
}

/// The patch of one file in one commit.
///
/// A renamed file is asked for under **both** names, because a pathspec naming
/// only the new one leaves git unable to pair the two: it then prints the file
/// as freshly added, every line of it, instead of the two lines that say it
/// moved. With both names it prints `similarity index 100% / rename from … /
/// rename to …`, which is what happened (measured 2026-08-23, git 2.40).
///
/// `--first-parent` for the reason `git_commit_detail` gives: without it a merge
/// prints no patch at all.
#[tauri::command]
pub async fn git_show_commit_file(
    root: String,
    hash: String,
    path: String,
    orig_path: Option<String>,
) -> Result<String, String> {
    // `--` keeps a path that looks like a revision from being read as one.
    let mut args = vec![
        "show",
        "--format=",
        "--patch",
        "--first-parent",
        &hash,
        "--",
        &path,
    ];
    if let Some(orig) = orig_path.as_deref() {
        args.push(orig);
    }
    run_git(&root, &args).await.map(without_bom)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    /// True for a remote-tracking branch (`origin/feature`): offered for
    /// checkout, never for rename or delete.
    pub remote: bool,
}

/// Local **and** remote-tracking branches. A freshly cloned repository has one
/// local branch and everything else under `origin/`, so a list of local
/// branches alone reads as "there are no other branches" — the exact opposite
/// of the truth.
///
/// Measured against real `for-each-ref` output (2026-08-24): `%(HEAD)` is `*`
/// on the checked-out branch and a space otherwise, and a clone's
/// `origin/HEAD` is a symbolic ref whose *short name is just `origin`* — any
/// line with a non-empty `%(symref)` is an alias for another ref, not a
/// branch, and listing it would offer a branch named after the remote.
#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<GitBranch>, String> {
    let out = run_git(
        &root,
        &[
            "for-each-ref",
            "refs/heads",
            "refs/remotes",
            "--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(symref)",
        ],
    )
    .await?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let head = parts.next()?;
            let full = parts.next()?;
            let short = parts.next()?;
            let symref = parts.next().unwrap_or("");
            if symref.is_empty() {
                Some(GitBranch {
                    name: short.to_string(),
                    current: head == "*",
                    remote: full.starts_with("refs/remotes/"),
                })
            } else {
                None
            }
        })
        .collect())
}

/// Checks out a remote-tracking branch as a local branch that tracks it.
///
/// `--track origin/x` rather than the bare `x`: the shorthand only works while
/// exactly one remote has the branch, and a second remote turns it into an
/// "ambiguous" refusal that nothing in the menu explains.
#[tauri::command]
pub async fn git_checkout_tracking(root: String, name: String) -> Result<String, String> {
    run_git(&root, &["checkout", "--track", &name]).await
}

/// Adds a detached worktree at `path`, for a run that must not share the
/// user's working tree.
///
/// Detached on purpose: the run picks its branch name inside the worktree the
/// same way it does in the main tree — trying the next free name — and a
/// branch created here belongs to the repository, so the user sees it at home
/// when the run is done.
#[tauri::command]
pub async fn git_worktree_add(root: String, path: String) -> Result<String, String> {
    run_git(&root, &["worktree", "add", "--detach", &path]).await
}

/// Stages everything in a run's worktree and commits it onto the run's branch.
///
/// Only a worktree run ever calls this: its checkout is a workplace the user
/// never visits, so the branch is the only honest way the change reaches them.
/// A run in the user's own tree never commits — reviewing that diff is the
/// user's own moment, exactly as before.
#[tauri::command]
pub async fn git_commit_all(root: String, message: String) -> Result<String, String> {
    run_git(&root, &["add", "-A"]).await?;
    run_git(&root, &["commit", "-m", &message]).await
}

/// Removes a worktree and what it still holds.
///
/// `--force`, because the caller is the cleanup a person just confirmed: the
/// worktree's uncommitted leftovers are exactly what they asked to be rid of.
/// The branch the run made is not touched — it is the deliverable.
#[tauri::command]
pub async fn git_worktree_remove(root: String, path: String) -> Result<String, String> {
    run_git(&root, &["worktree", "remove", "--force", &path]).await
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

    /// A real clone, because the whole point is what git prints: a fresh clone
    /// has one local branch, every other branch lives under `origin/`, and
    /// `origin/HEAD` is a symref whose short name is just "origin" — the three
    /// facts the branch list must survive.
    #[tokio::test]
    async fn a_clone_lists_remote_branches_and_never_the_head_alias() {
        let base = std::env::temp_dir().join(format!("aime-branches-{}", std::process::id()));
        let source = base.join("src");
        let clone = base.join("clone");
        std::fs::create_dir_all(&source).expect("mkdir");
        let git = |dir: &std::path::Path, args: &[&str]| {
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
        };
        git(&source, &["init", "-q", "-b", "main"]);
        git(&source, &["config", "user.email", "t@t"]);
        git(&source, &["config", "user.name", "t"]);
        git(&source, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(&source, &["branch", "feature/checkout"]);
        git(
            &base,
            &[
                "clone",
                "-q",
                source.to_str().expect("utf8"),
                clone.to_str().expect("utf8"),
            ],
        );

        let branches = git_branches(clone.to_string_lossy().to_string())
            .await
            .expect("branches");

        let names: Vec<(&str, bool, bool)> = branches
            .iter()
            .map(|b| (b.name.as_str(), b.current, b.remote))
            .collect();
        assert!(
            names.contains(&("main", true, false)),
            "local main missing: {names:?}"
        );
        assert!(
            names.contains(&("origin/feature/checkout", false, true)),
            "the remote branch never arrived: {names:?}"
        );
        assert!(
            !branches.iter().any(|b| b.name == "origin"),
            "origin/HEAD leaked in as a branch named after the remote: {names:?}"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// A parallel run's whole isolation rests on these two calls, so they are
    /// exercised against a real repository: the worktree appears detached (the
    /// run picks its own branch name inside it), and removal takes the
    /// leftovers with it even when the tree is dirty.
    #[tokio::test]
    async fn a_worktree_is_added_detached_and_removed_dirty() {
        let base = std::env::temp_dir().join(format!("aime-worktree-{}", std::process::id()));
        let repo = base.join("repo");
        let tree = base.join("tree");
        std::fs::create_dir_all(&repo).expect("mkdir");
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git runs");
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        git(&["commit", "-q", "--allow-empty", "-m", "one"]);

        let root = repo.to_string_lossy().to_string();
        let path = tree.to_string_lossy().to_string();
        git_worktree_add(root.clone(), path.clone()).await.expect("add");
        assert!(tree.is_dir(), "the worktree never appeared");
        let head = std::process::Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(&tree)
            .output()
            .expect("git runs");
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "",
            "the worktree took a branch instead of starting detached"
        );

        // Dirty on purpose: cleanup removes a tree that still holds leftovers.
        std::fs::write(tree.join("scratch.log"), "leftover").expect("write");
        git_worktree_remove(root, path).await.expect("remove");
        assert!(!tree.exists(), "the worktree is still on disk");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn short_path_lists_go_to_git_in_one_call() {
        let paths = vec!["src/main.rs".to_string(), "README.md".to_string()];
        assert_eq!(batches(&paths), vec![&paths[..]]);
        assert!(batches(&[]).is_empty());
    }

    /// Staging a newly added folder is the case that used to fail to spawn.
    #[test]
    fn a_folder_worth_of_paths_is_split_and_nothing_is_lost() {
        let paths: Vec<String> = (0..2000)
            .map(|n| format!("vendor/lib/module_with_a_realistic_name_{n:04}.ts"))
            .collect();
        let batches = batches(&paths);

        assert!(
            batches.len() > 1,
            "96 000 characters cannot travel as one command line"
        );
        for batch in &batches {
            let width: usize = batch.iter().map(|p| p.len() + 1).sum();
            assert!(width <= PATH_ARGUMENT_BUDGET, "a batch was too wide: {width}");
        }
        let carried: Vec<&String> = batches.iter().flat_map(|b| b.iter()).collect();
        assert_eq!(carried, paths.iter().collect::<Vec<_>>());
    }

    /// Every case here was put to git itself (`git check-ignore -v` on a real
    /// repository): `/debug.log` leaves `sub/debug.log` alone, the escaped `[`
    /// stops the name from also matching `pageXid].tsx`, and the leading `/` is
    /// what keeps `#notes.md` from being read as a comment. A closing `]` needs
    /// no escape - outside a bracket expression it is already literal. The
    /// trailing `/` on a folder is git's own way of saying "a directory called
    /// this", which leaves a file of the same name tracked.
    #[test]
    fn a_folder_is_ignored_as_a_folder() {
        assert_eq!(ignore_pattern("build", true), "/build/");
        assert_eq!(ignore_pattern("src/generated", true), "/src/generated/");
    }

    #[test]
    fn ignore_patterns_are_anchored_and_literal() {
        assert_eq!(ignore_pattern("debug.log", false), "/debug.log");
        assert_eq!(
            ignore_pattern("src/app/page[id].tsx", false),
            "/src/app/page\\[id].tsx"
        );
        assert_eq!(ignore_pattern("#notes.md", false), "/#notes.md");
        assert_eq!(ignore_pattern("!important.txt", false), "/!important.txt");
    }

    /// Real output of `ls-files --others --ignored --exclude-standard --directory -z`
    /// on this repository: a directory arrives with a trailing slash and a file
    /// without one, and the tree looks both up by the same key.
    #[test]
    fn ignored_directories_and_files_are_keyed_alike() {
        let text = "node_modules/\0STATUS.md\0src-tauri/target/\0";
        assert_eq!(
            parse_ignored(text),
            vec!["node_modules", "STATUS.md", "src-tauri/target"]
        );
        assert!(parse_ignored("").is_empty());
    }

    #[test]
    fn patterns_are_appended_without_disturbing_the_file() {
        let existing = "# build output\nnode_modules/\n";
        let updated = with_patterns(existing, &["/dist".to_string()]);
        assert_eq!(updated, "# build output\nnode_modules/\n/dist\n");
    }

    /// Both strings below are real git output, printed by a probe on a repository
    /// whose `Program.cs` carries a mark: `show HEAD:path` puts it first, while in
    /// a patch it lands *after* the line's leading space or `+`. That is why the
    /// mark is removed wherever it sits rather than only at the front.
    #[test]
    fn the_byte_order_mark_is_taken_out_of_file_text_and_of_patches() {
        assert_eq!(
            without_bom("\u{feff}class Program\n".to_string()),
            "class Program\n"
        );
        assert_eq!(
            without_bom(" \u{feff}class Program\n {\n-    static void Main() {}\n".to_string()),
            " class Program\n {\n-    static void Main() {}\n"
        );
    }

    #[test]
    fn text_without_a_mark_comes_back_unchanged() {
        let patch = "@@ -1,4 +1,4 @@\n+    static void Main() { Run(); }\n".to_string();
        assert_eq!(without_bom(patch.clone()), patch);
    }

    /// A file people edit by hand often has no closing newline.
    #[test]
    fn a_file_without_a_trailing_newline_does_not_glue_the_next_pattern_on() {
        let updated = with_patterns("node_modules/", &["/dist".to_string()]);
        assert_eq!(updated, "node_modules/\n/dist\n");
    }

    #[test]
    fn a_pattern_already_there_is_not_written_twice() {
        let existing = "/dist\n";
        assert_eq!(
            with_patterns(existing, &["/dist".to_string(), "/coverage".to_string()]),
            "/dist\n/coverage\n"
        );
        assert_eq!(with_patterns(existing, &["/dist".to_string()]), existing);
    }

    /// One path over the budget is still a file the user asked to stage.
    #[test]
    fn a_single_oversized_path_travels_alone() {
        let paths = vec!["a".repeat(PATH_ARGUMENT_BUDGET + 10), "b.txt".to_string()];
        let batches = batches(&paths);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0], &paths[0..1]);
        assert_eq!(batches[1], &paths[1..2]);
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
    fn a_commit_s_files_carry_both_what_changed_and_how_much() {
        // Real `git show -z` output: NUL after every record, numstat says how
        // many lines, name-status says what kind of change, and neither one
        // alone is enough for the list.
        let counts = "3\t1\tsrc/cart.ts\x000\t40\tsrc/old.ts\x009\t0\tsrc/new.ts\0-\t-\tlogo.png\0";
        let statuses = "M\0src/cart.ts\0D\0src/old.ts\0A\0src/new.ts\0M\0logo.png\0";
        let files = commit_files(counts, statuses);

        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, "M");
        assert_eq!((files[0].added, files[0].removed), (3, 1));
        assert_eq!(files[1].status, "D");
        assert_eq!(files[2].status, "A");
        // A binary file has no line counts, and pretending it has zero of each
        // would read as "nothing changed".
        assert!(files[3].binary, "a binary file must say so");
        assert_eq!((files[3].added, files[3].removed), (0, 0));
    }

    #[test]
    fn a_rename_is_listed_under_its_new_name_and_remembers_the_old_one() {
        // Captured from `git show --numstat -z` and `--name-status -z` on a real
        // rename (git 2.40): the counts record ends at its second tab and the
        // two names follow as fields of their own. Written from the bytes git
        // produced rather than from what the format looks like it should be -
        // the fixture this replaces was the second kind, and the viewer opened
        // a blank pane for every renamed file because of it.
        let counts = "2\t2\t\0src/old-name.ts\0src/new-name.ts\0";
        let statuses = "R096\0src/old-name.ts\0src/new-name.ts\0";
        let files = commit_files(counts, statuses);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/new-name.ts");
        assert_eq!(files[0].orig_path.as_deref(), Some("src/old-name.ts"));
        // The similarity score is git's confidence, not something to show.
        assert_eq!(files[0].status, "R");
        // The bug itself: git's human format spells a rename `old => new`, and a
        // row carrying that sentence is a row git can find no file for.
        assert!(
            !files[0].path.contains("=>"),
            "a path must be a path, not a sentence about one: {}",
            files[0].path
        );
    }

    #[test]
    fn a_truncated_answer_invents_nothing() {
        // git killed mid-write, or a record this parser has never seen. Neither
        // may become a row that opens a blank pane.
        assert!(commit_files("", "").is_empty());
        assert!(commit_files("2\t2\t\0src/only-the-old-name.ts\0", "").is_empty());
        // A status without its path is dropped rather than attached to whatever
        // came before it.
        let files = commit_files("1\t0\tsrc/a.ts\0", "R096\0src/a.ts\0");
        assert_eq!(files[0].status, "", "a half-written rename must not be believed");
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
