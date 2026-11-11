//! Pictures pasted into the chat.
//!
//! An AI CLI takes a picture the way it takes any file: by its path. A
//! screenshot copied to the clipboard has no path, so the composer hands its
//! bytes here and mentions the file they were written to. The file lives in
//! the project's own `.aime/` folder rather than the system temp folder:
//! every CLI can read inside the project it works in - a sandboxed one
//! (Codex's `workspace-write`) may not reach anywhere else - and `.aime/` is
//! already kept out of the project's commits (`aime_dir`).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request};

use crate::aime_dir::{self, AIME_DIR};

/// Where pasted pictures go, inside `.aime/`.
const PASTED_DIR: &str = "pasted";

/// A pasted picture is read by the turn it was pasted for; a week later
/// nobody is going to ask about it again, and the folder must not grow forever.
const KEPT_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// The formats a clipboard picture arrives in, as the extensions they are saved under.
const EXTENSIONS: &[&str] = &["png", "jpg", "gif", "webp", "bmp"];

/// Larger than any screenshot: a 4K PNG of a busy screen measures under 15 MB.
const MAX_BYTES: usize = 25 * 1024 * 1024;

/// The headers that travel beside the raw bytes - the body is the picture itself.
const ROOT_HEADER: &str = "x-aime-root";
const EXTENSION_HEADER: &str = "x-aime-extension";

/// Saves a pasted picture into the project and returns the file's path.
///
/// The bytes come as the raw request body rather than inside JSON, where a
/// screenshot would travel as an array of a million numbers. The project
/// root is percent-encoded, because a header carries ASCII only.
#[tauri::command]
pub async fn save_pasted_image(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("a pasted picture arrives as raw bytes".into());
    };
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(format!(
            "a pasted picture of {} bytes is not accepted",
            bytes.len()
        ));
    }
    let root = header(&request, ROOT_HEADER)?;
    let root = percent_decode_str(&root)
        .decode_utf8()
        .map_err(|err| format!("the project path is not valid UTF-8: {err}"))?
        .into_owned();
    let extension = header(&request, EXTENSION_HEADER)?;
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "'{extension}' is not a picture format a paste is saved in"
        ));
    }
    let bytes = bytes.clone();
    crate::background::off_main_thread(move || save(Path::new(&root), &extension, &bytes))
        .await?
        .map(|file| file.to_string_lossy().into_owned())
        .map_err(|err| format!("could not save the pasted picture: {err}"))
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| format!("the '{name}' header is missing"))
}

/// Writes the picture under a name no earlier paste has, and sweeps out old ones.
fn save(root: &Path, extension: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let dir = root.join(AIME_DIR).join(PASTED_DIR);
    fs::create_dir_all(&dir)?;
    aime_dir::ensure_self_ignored(root)?;
    forget_older_than(&dir, KEPT_FOR);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file = (0..)
        .map(|n| dir.join(format!("pasted-{stamp}-{n}.{extension}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| dir.join(format!("pasted-{stamp}.{extension}")));
    fs::write(&file, bytes)?;
    Ok(file)
}

/// Removes pictures pasted longer ago than `age`. A file that cannot be
/// removed - open in a viewer, say - is left for the next paste to try again.
fn forget_older_than(dir: &Path, age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(age).unwrap_or(UNIX_EPOCH);
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified < cutoff);
        if old {
            if let Err(err) = fs::remove_file(entry.path()) {
                eprintln!("[pasted] could not remove {}: {err}", entry.path().display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{forget_older_than, save, AIME_DIR, PASTED_DIR};
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aime-pasted-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp project");
        dir
    }

    #[test]
    fn a_pasted_picture_lands_in_the_projects_own_ignored_folder() {
        let root = project("lands");
        let file = save(&root, "png", b"\x89PNG").expect("saved");
        assert!(file.starts_with(root.join(AIME_DIR).join(PASTED_DIR)));
        assert_eq!(fs::read(&file).expect("readable"), b"\x89PNG");
        assert!(
            root.join(AIME_DIR).join(".gitignore").exists(),
            "the .aime guard was not written"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn two_pastes_in_the_same_moment_keep_both_pictures() {
        let root = project("twice");
        let first = save(&root, "png", b"one").expect("first");
        let second = save(&root, "png", b"two").expect("second");
        assert_ne!(first, second);
        assert_eq!(fs::read(first).expect("first kept"), b"one");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn old_pictures_are_swept_and_new_ones_kept() {
        let root = project("sweep");
        let file = save(&root, "png", b"x").expect("saved");
        forget_older_than(file.parent().expect("dir"), Duration::from_secs(3600));
        assert!(file.exists(), "a picture pasted just now was removed");
        forget_older_than(file.parent().expect("dir"), Duration::ZERO);
        assert!(!file.exists(), "an expired picture was kept");
        let _ = fs::remove_dir_all(root);
    }
}
