use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// When it was last written, in milliseconds since the epoch; `None` when the
    /// filesystem would not say. Carried so a caller can tell a file this run
    /// produced from one that was already lying there — the difference between
    /// evidence and decoration.
    pub modified_ms: Option<u64>,
    /// The file's size in bytes; `None` for a directory or when the filesystem
    /// would not say. Carried so a caller can refuse an empty file as evidence
    /// without reading it — the artifacts are often binary, and `read_file`
    /// only speaks UTF-8.
    pub size_bytes: Option<u64>,
}

/// Directories the file tree never shows.
///
/// Version-control metadata and nothing else, which is what VS Code hides by
/// default as well (`files.exclude`, read from the installed copy: `.git`,
/// `.svn`, `.hg`, `.DS_Store`, `Thumbs.db`). Everything a project merely
/// ignores - `node_modules`, `dist`, `target` - is shown and greyed out
/// instead: those hold files people open on purpose, and a tree that pretends
/// they do not exist sends the user to Explorer. Hiding them by name also hid
/// `bin/` and `obj/` in projects where those are tracked source.
const HIDDEN_DIRS: &[&str] = &[".git", ".svn", ".hg"];

/// Directories kept out of the workspace watcher and the quick-open index,
/// where their cost is real and their contents are somebody else's code.
pub const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "bin",
    "obj",
    "__pycache__",
];

/// When a path was last written (milliseconds since the epoch) and how large it
/// is, from one metadata call.
///
/// Every step of it is allowed to fail quietly: a file on a filesystem that
/// keeps no modification time, or one deleted between the listing and this call,
/// answers `None` rather than a made-up number.
fn file_facts(path: &Path, is_dir: bool) -> (Option<u64>, Option<u64>) {
    let Ok(meta) = fs::metadata(path) else {
        return (None, None);
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|since| u64::try_from(since.as_millis()).ok());
    let size = if is_dir { None } else { Some(meta.len()) };
    (modified, size)
}

/// Lists one directory level — folders first, then files; only VCS metadata is skipped.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().ok()?.is_dir();
            if is_dir && HIDDEN_DIRS.contains(&name.as_str()) {
                return None;
            }
            let (modified_ms, size_bytes) = file_facts(&e.path(), is_dir);
            Some(DirEntry {
                path: e.path().to_string_lossy().to_string(),
                name,
                is_dir,
                modified_ms,
                size_bytes,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Hard cap for the quick-open index — keeps huge monorepos responsive.
const MAX_INDEXED_FILES: usize = 20_000;

/// Flat list of workspace files (relative paths, forward slashes) for the
/// command palette's fuzzy quick-open. Ignored directories are skipped.
#[tauri::command]
pub fn list_files(root: String) -> Result<Vec<String>, String> {
    let root_path = Path::new(&root);
    let mut files = Vec::new();
    let mut stack = vec![root_path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue, // unreadable directory (permissions) — skip, don't fail the index
        };
        for entry in entries.filter_map(Result::ok) {
            if files.len() >= MAX_INDEXED_FILES {
                return Ok(files);
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !IGNORED_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if let Ok(relative) = path.strip_prefix(root_path) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(files)
}

/// The byte order mark, as the character it decodes to. Visual Studio puts one
/// at the top of the C# files it generates, so most of a .NET solution has it.
const BOM: &str = "\u{feff}";

/// True when the file on disk starts with a UTF-8 BOM. Read from the bytes each
/// time rather than remembered, so a file another editor changed still keeps
/// whatever it has now.
fn starts_with_bom(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false; // a file that does not exist yet has no mark to keep
    };
    let mut head = [0u8; 3];
    file.read_exact(&mut head).is_ok() && head == [0xEF, 0xBB, 0xBF]
}

/// Reads a file for the editor, without the byte order mark.
///
/// Decoded, the mark is an ordinary character: left in, it draws a stray glyph
/// in front of line 1 and sits between the cursor and the first real character.
/// `write_file` puts it back, so nothing is lost by hiding it here.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(text.strip_prefix(BOM).unwrap_or(&text).to_string())
}

/// Writes a file, keeping the byte order mark it had.
///
/// Dropping it would rewrite the first bytes of every file the user touches -
/// a one-line diff in git for each of them, on files nobody meant to change.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let file = Path::new(&path);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = content.strip_prefix(BOM).unwrap_or(&content);
    let text = if starts_with_bom(file) {
        format!("{BOM}{body}")
    } else {
        body.to_string()
    };
    fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("'{to}' already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if target.is_dir() {
        fs::remove_dir_all(target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(target).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    /// Real files, because the whole point is the bytes on disk.
    fn scratch(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        fs::remove_file(&path).ok();
        path
    }

    const MARKED: &[u8] = b"\xEF\xBB\xBFusing Nop.Core.Caching;\n";

    #[test]
    fn the_editor_never_sees_the_byte_order_mark() {
        let path = scratch("aime-bom-read.cs");
        fs::write(&path, MARKED).expect("write");

        let text = super::read_file(path.to_string_lossy().to_string()).expect("read");

        assert!(text.starts_with("using"), "the mark reached the editor: {text:?}");
        fs::remove_file(&path).ok();
    }

    /// Saving must not quietly rewrite the first bytes of a .NET solution.
    #[test]
    fn a_file_that_had_the_mark_still_has_it_after_a_save() {
        let path = scratch("aime-bom-write.cs");
        fs::write(&path, MARKED).expect("write");

        let text = super::read_file(path.to_string_lossy().to_string()).expect("read");
        super::write_file(path.to_string_lossy().to_string(), text).expect("write");

        assert_eq!(
            fs::read(&path).expect("read back"),
            MARKED,
            "the file changed on disk"
        );
        fs::remove_file(&path).ok();
    }

    #[test]
    fn a_file_without_the_mark_is_not_given_one() {
        let path = scratch("aime-bom-none.cs");
        let plain = b"using Nop.Core.Caching;\n";
        fs::write(&path, plain).expect("write");

        super::write_file(path.to_string_lossy().to_string(), "changed\n".to_string()).expect("write");

        assert_eq!(fs::read(&path).expect("read back"), b"changed\n");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn a_new_file_is_written_as_asked() {
        let path = scratch("aime-bom-new.cs");

        super::write_file(path.to_string_lossy().to_string(), "fresh\n".to_string()).expect("write");

        assert_eq!(fs::read(&path).expect("read back"), b"fresh\n");
        fs::remove_file(&path).ok();
    }
}
