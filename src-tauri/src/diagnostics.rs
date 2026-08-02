//! A record of what went wrong, kept on the user's own machine.
//!
//! Deliberately not a crash-reporting service. An editor that opens a person's
//! private repositories has no business posting their stack traces - and file
//! paths, project names and prompts leak through stack traces - to a third
//! party, least of all silently (ARCHITECTURE.md §1.6). What a report actually
//! needs is to survive the window that died and be readable when the user asks
//! for it, and a file does both.

use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Past this the log is rewritten with its newer half. Big enough to hold the
/// history of a long-running problem, small enough never to be a disk concern.
const MAX_BYTES: u64 = 256 * 1024;

/// One thing that went wrong, as the UI saw it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReport {
    /// Where it came from: "render", "unhandled-rejection", "ai", …
    pub kind: String,
    pub message: String,
    /// Stack trace or any other detail; may be empty.
    #[serde(default)]
    pub detail: String,
}

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("errors.log"))
}

/// Drops the older half once the file grows past its limit, so a loop that
/// logs on every frame cannot fill a disk and the newest entries always stay.
fn trim(path: &PathBuf) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() <= MAX_BYTES {
        return Ok(());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let keep = text.split_at(text.len() / 2).1;
    // Start at a line boundary: half an entry reads as corruption.
    let tail = keep.find('\n').map_or(keep, |at| &keep[at + 1..]);
    fs::write(path, tail).map_err(|e| e.to_string())
}

/// Appends one entry. Called by the UI when it catches something it cannot
/// recover from - and never by the UI's own error path, which would recurse.
#[tauri::command]
pub fn report_error(app: AppHandle, report: ErrorReport, timestamp: String) -> Result<(), String> {
    let path = log_path(&app)?;
    trim(&path)?;

    let mut entry = String::new();
    let _ = writeln!(entry, "[{timestamp}] {} - {}", report.kind, report.message);
    if !report.detail.trim().is_empty() {
        for line in report.detail.lines() {
            let _ = writeln!(entry, "    {line}");
        }
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(entry.as_bytes()).map_err(|e| e.to_string())
}

/// Where the log lives, so the UI can offer to open it.
#[tauri::command]
pub fn error_log_path(app: AppHandle) -> Result<String, String> {
    Ok(log_path(&app)?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::MAX_BYTES;
    use std::fs;

    /// The trimming rule, exercised on a real file rather than in the head.
    #[test]
    fn trimming_keeps_the_newest_entries_and_whole_lines() {
        let path = std::env::temp_dir().join("aime-errors-test.log");
        let entry = "[2026-01-01] render - something broke\n";
        let repeats = (MAX_BYTES as usize / entry.len()) + 100;
        fs::write(&path, entry.repeat(repeats)).expect("write");

        super::trim(&path).expect("trim");

        let after = fs::read_to_string(&path).expect("read");
        assert!((after.len() as u64) < MAX_BYTES, "the log was not shortened");
        assert!(after.starts_with('['), "trimming left half an entry at the top");
        assert!(after.ends_with('\n'), "the last entry lost its newline");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn a_short_log_is_left_alone() {
        let path = std::env::temp_dir().join("aime-errors-short.log");
        fs::write(&path, "[2026-01-01] render - one line\n").expect("write");
        super::trim(&path).expect("trim");
        assert_eq!(
            fs::read_to_string(&path).expect("read"),
            "[2026-01-01] render - one line\n"
        );
        fs::remove_file(&path).ok();
    }
}
