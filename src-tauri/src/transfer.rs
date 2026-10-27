//! Moving what Aime knows to another machine: a transfer pack.
//!
//! Everything a person builds up in Aime is kept per project folder - the
//! chat history (`session`), the editor state, the project memory and its
//! mirror (`memory_mirror`) - and the AI CLIs keep the transcripts that let a
//! conversation be resumed under their own home folders. None of it travels
//! when the person changes laptops. This module packs it all into one archive
//! and unpacks it on the other side, without touching the person's git, which
//! is why it was chosen over keeping memory on a branch of the repo.
//!
//! The other machine does not have the same paths. So a project in the pack is
//! known not by its folder but by its identity: the remote it is cloned from
//! (normalised as the memory mirror does), or failing that the root commit of
//! its history - both the same for every clone. On import, each project is
//! matched against the folders this machine knows; the rest wait under the app
//! data dir, and are adopted the moment a folder with that identity is opened.
//!
//! The CLIs' transcripts, measured: Claude Code (2.1.307) finds a
//! session by id in any folder under `~/.claude/projects`, so the file is
//! placed in the folder named for the new path and resumes; Codex (0.146.0)
//! resumes from a fresh `CODEX_HOME` holding nothing but the rollout file at
//! its date path. A configured CLI gets no session id from Aime, so for it
//! the chat and the memory are the whole of what there is to carry.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST: &str = "manifest.json";
const MANIFEST_VERSION: u32 = 1;
/// Under the app data dir: imported projects waiting for their folder.
const PENDING_DIR: &str = "transfer/pending";
/// Under the app data dir, as `memory_mirror` and `session` keep them.
const MIRROR_DIR: &str = "memory-mirror";
const SESSIONS_DIR: &str = "sessions";
const WORKSPACES_DIR: &str = "workspaces";
/// Inside a project: the memory notes.
const MEMORY_DIR: &str = ".aime/memory";
/// Sent to every window when a folder just opened took its data from the pack.
const ADOPTED_EVENT: &str = "transfer:adopted";

/// Files bound for the pack, each by the path it takes inside it.
type PackedFiles = Vec<(String, Vec<u8>)>;

// ---- what the pack holds ------------------------------------------------------

/// The index of a pack: one entry per project, each pointing at its folder.
#[derive(Serialize, Deserialize, Debug)]
struct Manifest {
    version: u32,
    exported_at: String,
    projects: Vec<ProjectEntry>,
}

/// One project in the pack, and how to know it again on another machine.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProjectEntry {
    /// `projects/<slot>/` in the pack.
    slot: usize,
    /// The folder's own name, for the person.
    name: String,
    /// The path on the machine it came from, for the person and for a folder kept at the same path.
    path: String,
    identity: Identity,
    chats: usize,
    memories: usize,
    transcripts: usize,
}

/// What a folder is, independently of where it sits.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// The remote `origin`, normalised as the memory mirror does.
    remote: Option<String>,
    /// The first commit of the history; the same for every clone, remote or not.
    root_commit: Option<String>,
}

impl Identity {
    /// Two folders are the same project when they share a remote, or a history.
    fn is_same(&self, other: &Identity) -> bool {
        (self.remote.is_some() && self.remote == other.remote)
            || (self.root_commit.is_some() && self.root_commit == other.root_commit)
    }

    fn is_known(&self) -> bool {
        self.remote.is_some() || self.root_commit.is_some()
    }
}

/// The folders on this machine the code reads from and writes to.
#[derive(Clone, Debug)]
pub struct Places {
    pub data_dir: PathBuf,
    /// `~/.claude`, or `CLAUDE_CONFIG_DIR` when set - where the CLI keeps `projects/`.
    pub claude_home: PathBuf,
    /// `~/.codex`, or `CODEX_HOME` when set - where the CLI keeps `sessions/`.
    pub codex_home: PathBuf,
}

impl Places {
    fn of(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let home = crate::home::home_dir().ok_or("the home directory is not set")?;
        let from_env = |variable: &str, default: &str| {
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(default))
        };
        Ok(Self {
            data_dir,
            claude_home: from_env("CLAUDE_CONFIG_DIR", ".claude"),
            codex_home: from_env("CODEX_HOME", ".codex"),
        })
    }

    fn pending(&self) -> PathBuf {
        self.data_dir.join(PENDING_DIR)
    }
}

// ---- export -------------------------------------------------------------------

/// What an export packed, for the line Settings shows.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub projects: usize,
    pub chats: usize,
    pub memories: usize,
    pub transcripts: usize,
    /// Conversations whose CLI transcript was not on this machine: the chat
    /// still travels, the CLI will not resume it.
    pub transcripts_missing: usize,
}

/// Packs the projects at `roots` - the folders this machine has opened - into
/// the zip at `target`.
#[tauri::command]
pub async fn transfer_export(app: AppHandle, roots: Vec<String>, target: String) -> Result<Exported, String> {
    let places = Places::of(&app)?;
    crate::background::off_main_thread(move || export(&places, &roots, Path::new(&target)))
        .await?
        .map_err(|e| e.to_string())
}

pub fn export(places: &Places, roots: &[String], target: &Path) -> io::Result<Exported> {
    let file = fs::File::create(target)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    let mut put = |path: &str, bytes: &[u8]| -> io::Result<()> {
        zip.start_file(path, options)?;
        zip.write_all(bytes)
    };

    let mut manifest = Manifest {
        version: MANIFEST_VERSION,
        exported_at: now_iso(),
        projects: Vec::new(),
    };
    let mut summary = Exported::default();
    for (slot, root) in unique(roots).iter().enumerate() {
        let Some(entry) = pack_project(places, root, slot, &mut put, &mut summary)? else {
            continue;
        };
        manifest.projects.push(entry);
    }
    // Every mirror travels too: it is keyed by identity already, and covers a
    // project this machine no longer lists among its folders.
    for (relative, bytes) in files_under(&places.data_dir.join(MIRROR_DIR))? {
        put(&format!("mirrors/{relative}"), &bytes)?;
    }
    put(MANIFEST, &serde_json::to_vec_pretty(&manifest)?)?;
    zip.finish()?;
    summary.projects = manifest.projects.len();
    Ok(summary)
}

/// Writes one project's files into the pack; None for a folder Aime knows
/// nothing about (no chat, no memory), which has nothing to carry.
fn pack_project(
    places: &Places,
    root: &str,
    slot: usize,
    put: &mut impl FnMut(&str, &[u8]) -> io::Result<()>,
    summary: &mut Exported,
) -> io::Result<Option<ProjectEntry>> {
    let sessions = read_json(&store_file(&places.data_dir, SESSIONS_DIR, root))?;
    let workspace = read_json(&store_file(&places.data_dir, WORKSPACES_DIR, root))?;
    let memory = files_under(&Path::new(root).join(MEMORY_DIR))?;
    // Every conversation travels; only those with a CLI session id can resume.
    let chats = sessions.as_ref().map_or(0, session_count);
    if chats == 0 && memory.is_empty() {
        return Ok(None);
    }
    let base = format!("projects/{slot}");
    if let Some(sessions) = &sessions {
        put(&format!("{base}/sessions.json"), &serde_json::to_vec(sessions)?)?;
    }
    if let Some(workspace) = &workspace {
        put(&format!("{base}/workspace.json"), &serde_json::to_vec(workspace)?)?;
    }
    for (relative, bytes) in &memory {
        put(&format!("{base}/memory/{relative}"), bytes)?;
    }
    let mut transcripts = 0;
    for (provider, session_id) in session_refs(&sessions) {
        match transcript_of(places, root, &provider, &session_id)? {
            Some(found) => {
                for (relative, bytes) in found {
                    put(&format!("{base}/cli/{provider}/{relative}"), &bytes)?;
                }
                transcripts += 1;
            }
            None => summary.transcripts_missing += 1,
        }
    }
    summary.chats += chats;
    summary.memories += memory.len();
    summary.transcripts += transcripts;
    Ok(Some(ProjectEntry {
        slot,
        name: folder_name(root),
        path: root.to_string(),
        identity: identity_of(Path::new(root)),
        chats,
        memories: memory.len(),
        transcripts,
    }))
}

/// The CLI and session id of every conversation the CLI could resume.
fn session_refs(sessions: &Option<Value>) -> Vec<(String, String)> {
    let Some(list) = sessions
        .as_ref()
        .and_then(|value| value.get("sessions"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|session| {
            let id = session.get("sessionId")?.as_str()?;
            // A conversation saved before providers existed is Claude's (`sessionToResume`).
            let provider = session
                .get("providerId")
                .and_then(Value::as_str)
                .unwrap_or("claude");
            Some((provider.to_string(), id.to_string()))
        })
        .collect()
}

/// The files that let `provider` resume `session_id`, by their path under
/// the pack's `cli/<provider>/` folder; None when this machine has none.
fn transcript_of(
    places: &Places,
    root: &str,
    provider: &str,
    session_id: &str,
) -> io::Result<Option<PackedFiles>> {
    if !is_safe_id(session_id) {
        return Ok(None);
    }
    match provider {
        "claude" => claude_transcript(places, root, session_id),
        "codex" => codex_transcript(places, session_id),
        _ => Ok(None),
    }
}

/// `projects/<any folder>/<id>.jsonl`, plus the project folder's own
/// `memory/` once - the CLI's notes about the project, which it reads by cwd.
fn claude_transcript(places: &Places, root: &str, session_id: &str) -> io::Result<Option<PackedFiles>> {
    let projects = places.claude_home.join("projects");
    let file_name = format!("{session_id}.jsonl");
    let Some(folder) = subfolders(&projects)?
        .into_iter()
        .find(|folder| folder.join(&file_name).is_file())
    else {
        return Ok(None);
    };
    let mut files = vec![(file_name.clone(), fs::read(folder.join(&file_name))?)];
    let own = projects.join(claude_folder_name(root));
    for (relative, bytes) in files_under(&own.join("memory"))? {
        files.push((format!("memory/{relative}"), bytes));
    }
    Ok(Some(files))
}

/// `sessions/<year>/<month>/<day>/rollout-<stamp>-<id>.jsonl`, at the same
/// relative path, which is where the CLI looks for it.
fn codex_transcript(places: &Places, session_id: &str) -> io::Result<Option<PackedFiles>> {
    let sessions = places.codex_home.join("sessions");
    let suffix = format!("-{session_id}.jsonl");
    let Some(file) = walk_files(&sessions)?.into_iter().find(|file| {
        file.file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(&suffix))
    }) else {
        return Ok(None);
    };
    let relative = relative_path(&places.codex_home, &file);
    Ok(Some(vec![(relative, fs::read(&file)?)]))
}

// ---- import -------------------------------------------------------------------

/// What an import did, for the line Settings shows.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// Projects matched to a folder on this machine, by name.
    pub adopted: Vec<String>,
    /// Projects waiting for their folder to be opened, by name.
    pub pending: Vec<String>,
    pub chats: usize,
    pub memories: usize,
    pub transcripts: usize,
}

/// Unpacks the zip at `archive`: mirrors go straight in, and each project is
/// matched against `candidates` - the folders this machine has opened - or
/// left waiting for the one that opens with its identity.
#[tauri::command]
pub async fn transfer_import(
    app: AppHandle,
    archive: String,
    candidates: Vec<String>,
) -> Result<Imported, String> {
    let places = Places::of(&app)?;
    crate::background::off_main_thread(move || import(&places, Path::new(&archive), &candidates))
        .await?
        .map_err(|e| e.to_string())
}

pub fn import(places: &Places, archive: &Path, candidates: &[String]) -> io::Result<Imported> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive)?)?;
    let manifest: Manifest = {
        let mut text = String::new();
        zip.by_name(MANIFEST)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "not an Aime transfer pack"))?
            .read_to_string(&mut text)?;
        serde_json::from_str(&text)?
    };
    if manifest.version != MANIFEST_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("transfer pack version {} is not supported", manifest.version),
        ));
    }
    let pending = places.pending();
    let stamp = now_stamp();
    let mut summary = Imported::default();
    for index in 0..zip.len() {
        let mut file = zip.by_index(index)?;
        let Some(inside) = file.enclosed_name() else {
            continue; // a path that climbs out of the pack is not written anywhere
        };
        if file.is_dir() {
            continue;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let inside = inside.to_string_lossy().replace('\\', "/");
        if let Some(relative) = inside.strip_prefix("mirrors/") {
            write_if_absent(&places.data_dir.join(MIRROR_DIR).join(relative), &bytes)?;
        } else if let Some(rest) = inside.strip_prefix("projects/") {
            // `projects/<slot>/...` lands under its own pending folder, with
            // the stamp so two imports of one pack never share a folder.
            let (slot, relative) = rest.split_once('/').unwrap_or((rest, ""));
            write_file(&pending.join(format!("{stamp}-{slot}")).join(relative), &bytes)?;
        }
    }
    for entry in &manifest.projects {
        let folder = pending.join(format!("{stamp}-{}", entry.slot));
        if !folder.is_dir() {
            continue; // listed, but the pack held nothing for it
        }
        write_file(&folder.join("entry.json"), &serde_json::to_vec_pretty(entry)?)?;
        summary.chats += entry.chats;
        summary.memories += entry.memories;
        summary.transcripts += entry.transcripts;
        summary.pending.push(entry.name.clone());
    }
    // Folders this machine already knows take theirs now.
    for candidate in unique(candidates) {
        if !Path::new(&candidate).is_dir() {
            continue;
        }
        for adopted in adopt(places, Path::new(&candidate))? {
            summary.pending.retain(|name| name != &adopted.name);
            summary.adopted.push(adopted.name);
        }
    }
    Ok(summary)
}

/// What one opened folder took from the pack.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Adopted {
    pub name: String,
    pub path: String,
    pub chats: usize,
    pub memories: usize,
    pub transcripts: usize,
}

/// Before a folder's stores are read: gives it whatever the pack holds for
/// its identity. Costs nothing while nothing waits, which is almost always.
pub fn adopt_if_pending(app: &AppHandle, root: &str) {
    let Ok(places) = Places::of(app) else {
        return;
    };
    if !places.pending().is_dir() {
        return;
    }
    match adopt(&places, Path::new(root)) {
        Ok(adopted) => {
            for one in adopted {
                if let Err(err) = app.emit(ADOPTED_EVENT, &one) {
                    eprintln!(
                        "[transfer] could not announce the adoption of '{}': {err}",
                        one.path
                    );
                }
            }
        }
        Err(err) => eprintln!("[transfer] could not adopt the pack's data for '{root}': {err}"),
    }
}

/// Every waiting project with `root`'s identity moves into `root`: its chats
/// merge with the folder's own, its memory fills in what the folder lacks,
/// and the CLIs get their transcripts. Two waiting clones of one repository
/// both land here, merged, since they are one project.
pub fn adopt(places: &Places, root: &Path) -> io::Result<Vec<Adopted>> {
    let pending = places.pending();
    let waiting = subfolders(&pending)?;
    if waiting.is_empty() {
        return Ok(Vec::new());
    }
    let identity = identity_of(root);
    let mut adopted = Vec::new();
    for folder in waiting {
        let entry: ProjectEntry = match read_json(&folder.join("entry.json"))? {
            Some(value) => serde_json::from_value(value)?,
            None => continue,
        };
        let same_place = Path::new(&entry.path) == root;
        if !(same_place || (identity.is_known() && identity.is_same(&entry.identity))) {
            continue;
        }
        adopted.push(take_in(places, root, &folder, &entry)?);
        fs::remove_dir_all(&folder)?;
    }
    if adopted.is_empty() {
        return Ok(adopted);
    }
    let _ = fs::remove_dir(&pending); // only when it is empty; otherwise it stays
    Ok(adopted)
}

fn take_in(places: &Places, root: &Path, folder: &Path, entry: &ProjectEntry) -> io::Result<Adopted> {
    let root_text = root.to_string_lossy().to_string();
    let chats = match read_json(&folder.join("sessions.json"))? {
        Some(theirs) => {
            let store = store_file(&places.data_dir, SESSIONS_DIR, &root_text);
            let merged = merge_sessions(read_json(&store)?, theirs);
            let count = session_count(&merged);
            write_json(&store, &merged)?;
            count
        }
        None => 0,
    };
    if let Some(workspace) = read_json(&folder.join("workspace.json"))? {
        let store = store_file(&places.data_dir, WORKSPACES_DIR, &root_text);
        if !store.exists() {
            write_json(&store, &workspace)?;
        }
    }
    let mut memories = 0;
    for (relative, bytes) in files_under(&folder.join("memory"))? {
        // The project's folder is the truth where it has the note already.
        if write_if_absent(&root.join(MEMORY_DIR).join(&relative), &bytes)? {
            memories += 1;
        }
    }
    let mut transcripts = 0;
    for (relative, bytes) in files_under(&folder.join("cli"))? {
        let (provider, inside) = relative.split_once('/').unwrap_or((relative.as_str(), ""));
        let target = match provider {
            "claude" => places
                .claude_home
                .join("projects")
                .join(claude_folder_name(&root_text))
                .join(inside),
            "codex" => places.codex_home.join(inside),
            _ => continue,
        };
        if write_if_absent(&target, &bytes)? && inside.ends_with(".jsonl") {
            transcripts += 1;
        }
    }
    Ok(Adopted {
        name: entry.name.clone(),
        path: root_text,
        chats,
        memories,
        transcripts,
    })
}

/// The folder's own conversations and the pack's, as one list: the same
/// conversation (by `localId`) keeps whichever was updated last, and the
/// list stays newest first, as the store keeps it.
fn merge_sessions(mine: Option<Value>, theirs: Value) -> Value {
    let list_of = |value: &Value| -> Vec<Value> {
        value
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let updated = |session: &Value| session.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
    let mut by_id: BTreeMap<String, Value> = BTreeMap::new();
    for session in list_of(&theirs).into_iter().chain(mine.iter().flat_map(list_of)) {
        let Some(id) = session.get("localId").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let newer = by_id
            .get(&id)
            .is_none_or(|kept| updated(&session) > updated(kept));
        if newer {
            by_id.insert(id, session);
        }
    }
    let mut sessions: Vec<Value> = by_id.into_values().collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(updated(session)));
    let mut merged = mine.unwrap_or_else(|| theirs.clone());
    if let Some(object) = merged.as_object_mut() {
        object.insert("sessions".into(), Value::Array(sessions));
    }
    merged
}

fn session_count(store: &Value) -> usize {
    store
        .get("sessions")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

// ---- identity -----------------------------------------------------------------

/// The remote and root commit of `root`, as git reports them; empty for a
/// folder that is no repository.
pub fn identity_of(root: &Path) -> Identity {
    Identity {
        remote: git_line(root, &["config", "--get", "remote.origin.url"])
            .and_then(|url| crate::memory_mirror::normalize_remote(&url)),
        // A history can have several roots (a merged-in project); the
        // smallest id is a stable choice for the same history anywhere.
        root_commit: git_line(root, &["rev-list", "--max-parents=0", "HEAD"]),
    }
}

/// The first line of git's answer, sorted - None when git fails or says nothing.
fn git_line(root: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines.sort_unstable();
    lines.first().map(|line| (*line).to_string())
}

// ---- the CLIs' naming ---------------------------------------------------------

/// How Claude Code names a project's folder under `projects/`: the path with
/// every character but letters and digits turned into `-` (observed 2.1.307:
/// `C:\Users\x\Temp\xfer\A` → `C--Users-x-Temp-xfer-A`).
fn claude_folder_name(root: &str) -> String {
    root.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// A session id is a file name in the CLIs' folders; anything else is refused
/// rather than joined into a path.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ---- files --------------------------------------------------------------------

/// `<data>/<kind>/<key>.json`, the way `session` keys a folder's store.
fn store_file(data_dir: &Path, kind: &str, root: &str) -> PathBuf {
    data_dir
        .join(kind)
        .join(format!("{}.json", crate::session::store_key(root)))
}

fn read_json(file: &Path) -> io::Result<Option<Value>> {
    match fs::read(file) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn write_json(file: &Path, value: &Value) -> io::Result<()> {
    write_file(file, &serde_json::to_vec_pretty(value)?)
}

/// Writes through a temporary name, so a reader never sees half a file.
fn write_file(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = file
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a file needs a folder"))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.part",
        file.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
    ));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, file)
}

/// Writes the file unless one is there already; says whether it did.
fn write_if_absent(file: &Path, bytes: &[u8]) -> io::Result<bool> {
    if file.exists() {
        return Ok(false);
    }
    write_file(file, bytes)?;
    Ok(true)
}

/// Every file under `dir`, by its path relative to `dir` with `/` separators; empty for no folder.
fn files_under(dir: &Path) -> io::Result<PackedFiles> {
    let mut files = Vec::new();
    for file in walk_files(dir)? {
        files.push((relative_path(dir, &file), fs::read(&file)?));
    }
    Ok(files)
}

fn walk_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        for entry in entries {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    Ok(files)
}

fn subfolders(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut folders = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            folders.push(entry.path());
        }
    }
    folders.sort();
    Ok(folders)
}

fn relative_path(base: &Path, file: &Path) -> String {
    file.strip_prefix(base)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

fn folder_name(root: &str) -> String {
    root.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(root)
        .to_string()
}

fn unique(paths: &[String]) -> Vec<String> {
    let mut seen = Vec::new();
    for path in paths {
        let path = path.trim_end_matches(['/', '\\']).to_string();
        if !path.is_empty() && !seen.contains(&path) {
            seen.push(path);
        }
    }
    seen
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn now_stamp() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aime-transfer-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn places_in(dir: &Path) -> Places {
        Places {
            data_dir: dir.join("data"),
            claude_home: dir.join("home/.claude"),
            codex_home: dir.join("home/.codex"),
        }
    }

    fn sessions_store(entries: &[(&str, &str, i64)]) -> Value {
        json!({
            "version": 1,
            "sessions": entries.iter().map(|(local, session, updated)| json!({
                "localId": local,
                // An empty id stands for a conversation the CLI never numbered.
                "sessionId": if session.is_empty() { Value::Null } else { Value::String((*session).to_string()) },
                "providerId": if session.starts_with("01") { "codex" } else { "claude" },
                "title": local, "createdAt": 1, "updatedAt": updated, "totalCostUsd": 0, "messages": []
            })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn claude_names_a_project_folder_after_its_path() {
        assert_eq!(
            claude_folder_name(r"C:\Users\x\AppData\Local\Temp\xfer\A"),
            "C--Users-x-AppData-Local-Temp-xfer-A"
        );
        assert_eq!(claude_folder_name("/home/x/work/shop.io"), "-home-x-work-shop-io");
    }

    #[test]
    fn a_project_is_the_same_by_remote_or_by_history_and_never_by_nothing() {
        let by_remote = Identity {
            remote: Some("github.com/a/b".into()),
            root_commit: Some("111".into()),
        };
        let other_clone = Identity {
            remote: Some("github.com/a/b".into()),
            root_commit: Some("111".into()),
        };
        let fork = Identity {
            remote: Some("github.com/c/b".into()),
            root_commit: Some("111".into()),
        };
        let stranger = Identity {
            remote: Some("github.com/c/d".into()),
            root_commit: Some("222".into()),
        };
        assert!(by_remote.is_same(&other_clone));
        assert!(
            by_remote.is_same(&fork),
            "one history is one project, whoever hosts it"
        );
        assert!(!by_remote.is_same(&stranger));
        assert!(
            !Identity::default().is_same(&Identity::default()),
            "two unknowns are not one project"
        );
    }

    #[test]
    fn merging_keeps_the_newer_of_a_conversation_and_every_other_one() {
        let mine = sessions_store(&[("a", "s-a", 10), ("b", "s-b", 50)]);
        let theirs = sessions_store(&[("a", "s-a2", 20), ("c", "s-c", 30)]);
        let merged = merge_sessions(Some(mine), theirs);
        let ids: Vec<(String, i64)> = merged["sessions"]
            .as_array()
            .expect("list")
            .iter()
            .map(|s| {
                (
                    s["sessionId"].as_str().expect("id").into(),
                    s["updatedAt"].as_i64().expect("t"),
                )
            })
            .collect();
        assert_eq!(
            ids,
            vec![("s-b".into(), 50), ("s-c".into(), 30), ("s-a2".into(), 20)]
        );
    }

    #[test]
    fn a_pack_round_trips_into_a_folder_at_another_path() {
        let dir = fresh("roundtrip");
        let old_machine = places_in(&dir.join("old"));
        let new_machine = places_in(&dir.join("new"));
        let old_root = dir.join("old/work/shop");
        let new_root = dir.join("new/elsewhere/shop-clone");
        for root in [&old_root, &new_root] {
            fs::create_dir_all(root.join(MEMORY_DIR)).expect("project");
        }
        let old_text = old_root.to_string_lossy().to_string();
        // The old machine: two chats, one memory, both CLIs' transcripts.
        write_json(
            &store_file(&old_machine.data_dir, SESSIONS_DIR, &old_text),
            &sessions_store(&[("a", "s-claude", 10), ("b", "01-codex", 20), ("c", "", 30)]),
        )
        .expect("sessions");
        fs::write(
            old_root.join(MEMORY_DIR).join("lib-router.md"),
            "lib routes requests",
        )
        .expect("memory");
        let claude_dir = old_machine
            .claude_home
            .join("projects")
            .join("some-old-folder-name");
        write_file(&claude_dir.join("s-claude.jsonl"), b"{\"cwd\":\"old\"}\n").expect("claude transcript");
        write_file(
            &old_machine
                .codex_home
                .join("sessions/2026/10/22/rollout-2026-10-22T10-42-55-01-codex.jsonl"),
            b"{}\n",
        )
        .expect("codex transcript");
        write_file(
            &old_machine
                .data_dir
                .join(MIRROR_DIR)
                .join("shop-abc/lib-router.md"),
            b"mirrored",
        )
        .expect("mirror");

        let pack = dir.join("pack.zip");
        let exported = export(&old_machine, std::slice::from_ref(&old_text), &pack).expect("export");
        assert_eq!(
            exported,
            Exported {
                projects: 1,
                chats: 3,
                memories: 1,
                transcripts: 2,
                transcripts_missing: 0
            }
        );

        // The new machine, where nothing matches yet: the project waits.
        let imported = import(&new_machine, &pack, &[]).expect("import");
        assert_eq!(imported.pending, vec!["shop".to_string()]);
        assert!(imported.adopted.is_empty());
        assert!(new_machine
            .data_dir
            .join(MIRROR_DIR)
            .join("shop-abc/lib-router.md")
            .is_file());

        // The folder is no repository, so only its old path could match - and
        // it is elsewhere. Adoption happens through the identity check, which
        // this test stands in for by writing the same path into the entry.
        let pending = subfolders(&new_machine.pending()).expect("pending");
        assert_eq!(pending.len(), 1);
        let entry_file = pending[0].join("entry.json");
        let mut entry: ProjectEntry =
            serde_json::from_value(read_json(&entry_file).expect("read").expect("entry")).expect("entry");
        entry.path = new_root.to_string_lossy().to_string();
        write_json(&entry_file, &serde_json::to_value(&entry).expect("json")).expect("entry");

        let adopted = adopt(&new_machine, &new_root).expect("adopt");
        assert_eq!(adopted.len(), 1);
        assert_eq!(
            (adopted[0].chats, adopted[0].memories, adopted[0].transcripts),
            (3, 1, 2)
        );
        let new_text = new_root.to_string_lossy().to_string();
        let store = read_json(&store_file(&new_machine.data_dir, SESSIONS_DIR, &new_text))
            .expect("read")
            .expect("chats landed under the new path");
        assert_eq!(session_count(&store), 3);
        assert_eq!(
            fs::read_to_string(new_root.join(MEMORY_DIR).join("lib-router.md")).expect("memory"),
            "lib routes requests"
        );
        assert!(new_machine
            .claude_home
            .join("projects")
            .join(claude_folder_name(&new_text))
            .join("s-claude.jsonl")
            .is_file());
        assert!(new_machine
            .codex_home
            .join("sessions/2026/10/22/rollout-2026-10-22T10-42-55-01-codex.jsonl")
            .is_file());
        assert!(
            !new_machine.pending().exists(),
            "nothing waits once everything was taken"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_that_is_nothing_to_aime_is_not_packed_and_a_foreign_zip_is_refused() {
        let dir = fresh("empty");
        let places = places_in(&dir);
        let root = dir.join("plain");
        fs::create_dir_all(&root).expect("folder");
        let pack = dir.join("pack.zip");
        let exported = export(&places, &[root.to_string_lossy().to_string()], &pack).expect("export");
        assert_eq!(exported.projects, 0);

        let foreign = dir.join("foreign.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&foreign).expect("zip"));
        zip.start_file("hello.txt", zip::write::SimpleFileOptions::default())
            .expect("entry");
        zip.write_all(b"hi").expect("write");
        zip.finish().expect("finish");
        let err = import(&places, &foreign, &[]).expect_err("not a pack");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        let _ = fs::remove_dir_all(&dir);
    }
}
