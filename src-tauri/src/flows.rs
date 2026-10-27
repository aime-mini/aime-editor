//! What Flows needs from the backend (the engine itself is `src/lib/flows/`,
//! beside the task runs, because the CLIs' event streams are normalised on
//! the frontend):
//!
//! - the flow files of a project, `.aime/flows/<slug>.json`, which travel
//!   with the repository: `.aime/` ignores itself, and this module opens the
//!   one exception for them;
//! - the journal of a run, `.aime/flow-runs/<flow>/<run>.jsonl`, one JSON
//!   line per event, which is what a run resumes from;
//! - compiled transforms, jq programs run in-process by `jaq`: nothing to
//!   install, no file or network reach, the same answer on every platform;
//! - a command step's shared form - a program with its arguments, run with
//!   no shell in between, so it means the same thing everywhere.

use crate::exec::{self, CommandOutcome, ExecState};
use crate::flow_services::{too_big, VALUE_LIMIT};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

const AIME_DIR: &str = ".aime";
const FLOWS_DIR: &str = "flows";
const RUNS_DIR: &str = "flow-runs";
/// Added to `.aime/.gitignore` so the flows - and only they - reach git.
const FLOWS_UNIGNORED: &str = "!flows/\n!flows/**\n";
/// How much of a jq program's output a step may produce; a filter that
/// explodes (`range(1e9)`) is cut, not allowed to fill memory.
const MOST_OUTPUTS: usize = 10_000;

// ---- flow files --------------------------------------------------------------

/// One flow file, as stored, with the slug it is stored under.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredFlow {
    pub slug: String,
    pub flow: Value,
}

/// Every flow of the project, by slug.
#[tauri::command]
pub fn flow_list(root: String) -> Result<Vec<StoredFlow>, String> {
    list_flows(Path::new(&root)).map_err(|e| e.to_string())
}

/// Writes a flow under its slug and makes sure git can see the folder.
#[tauri::command]
pub fn flow_save(root: String, slug: String, flow: Value) -> Result<(), String> {
    save_flow(Path::new(&root), &slug, &flow).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flow_delete(root: String, slug: String) -> Result<(), String> {
    let file = flow_file(Path::new(&root), &slug).map_err(|e| e.to_string())?;
    match fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

pub fn list_flows(root: &Path) -> io::Result<Vec<StoredFlow>> {
    let dir = root.join(AIME_DIR).join(FLOWS_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut flows = Vec::new();
    for entry in entries {
        let path = entry?.path();
        let Some(slug) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|_| path.extension().is_some_and(|ext| ext == "json"))
        else {
            continue;
        };
        // One unreadable file must not hide the others; it is reported as such.
        let flow =
            match fs::read(&path).and_then(|bytes| serde_json::from_slice(&bytes).map_err(io::Error::from)) {
                Ok(flow) => flow,
                Err(err) => serde_json::json!({ "unreadable": err.to_string() }),
            };
        flows.push(StoredFlow {
            slug: slug.to_string(),
            flow,
        });
    }
    flows.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(flows)
}

pub fn save_flow(root: &Path, slug: &str, flow: &Value) -> io::Result<()> {
    let file = flow_file(root, slug)?;
    write_atomically(&file, &serde_json::to_vec_pretty(flow)?)?;
    let_git_see_flows(root)
}

/// `.aime/flows/<slug>.json`; a slug is a file name, nothing else.
fn flow_file(root: &Path, slug: &str) -> io::Result<PathBuf> {
    if !is_slug(slug) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{slug}' is not a flow name: letters, digits and dashes only"),
        ));
    }
    Ok(root.join(AIME_DIR).join(FLOWS_DIR).join(format!("{slug}.json")))
}

pub(crate) fn is_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 80
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
}

/// `.aime/.gitignore` says `*`; the flows folder is the one thing under
/// `.aime/` meant for the repository, so the guard gets the two lines that
/// let it through. A guard the person wrote themselves is extended, not
/// replaced, and only once.
fn let_git_see_flows(root: &Path) -> io::Result<()> {
    crate::aime_dir::ensure_self_ignored(root)?;
    let guard = root.join(AIME_DIR).join(".gitignore");
    let current = fs::read_to_string(&guard).unwrap_or_default();
    if current.lines().any(|line| line.trim() == "!flows/") {
        return Ok(());
    }
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(FLOWS_UNIGNORED);
    fs::write(guard, text)
}

// ---- the person's own flows -------------------------------------------------------

/// Under the app data dir: a hidden project of its own, so the same functions serve it.
const MINE_DIR: &str = "my-flows";

fn mine_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(MINE_DIR))
}

/// The flows kept in the app data rather than a project: usable anywhere.
#[tauri::command]
pub fn my_flow_list(app: AppHandle) -> Result<Vec<StoredFlow>, String> {
    list_flows(&mine_root(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn my_flow_save(app: AppHandle, slug: String, flow: Value) -> Result<(), String> {
    save_flow(&mine_root(&app)?, &slug, &flow).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn my_flow_delete(app: AppHandle, slug: String) -> Result<(), String> {
    flow_delete(mine_root(&app)?.to_string_lossy().to_string(), slug)
}

// ---- journal -----------------------------------------------------------------

/// Appends one event to a run's journal, creating it on the first.
#[tauri::command]
pub fn flow_journal_append(root: String, flow: String, run: String, event: Value) -> Result<(), String> {
    append_event(Path::new(&root), &flow, &run, &event).map_err(|e| e.to_string())
}

/// Every event of a run, in order; empty for a run that never wrote one.
#[tauri::command]
pub fn flow_journal_read(root: String, flow: String, run: String) -> Result<Vec<Value>, String> {
    read_events(Path::new(&root), &flow, &run).map_err(|e| e.to_string())
}

/// The runs of a flow, newest first, each with its first event (the snapshot
/// a run starts with) so a list needs no second read.
#[tauri::command]
pub fn flow_runs(root: String, flow: String) -> Result<Vec<RunHead>, String> {
    list_runs(Path::new(&root), &flow).map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunHead {
    pub run: String,
    pub first: Value,
    pub last: Value,
}

pub fn append_event(root: &Path, flow: &str, run: &str, event: &Value) -> io::Result<()> {
    let file = journal_file(root, flow, run)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?
        .write_all(&line)
}

pub fn read_events(root: &Path, flow: &str, run: &str) -> io::Result<Vec<Value>> {
    let file = journal_file(root, flow, run)?;
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    // A line cut short by a crash is the one event the run did not finish
    // writing; everything before it stands.
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

pub fn list_runs(root: &Path, flow: &str) -> io::Result<Vec<RunHead>> {
    let dir = runs_dir(root, flow)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut runs = Vec::new();
    for entry in entries {
        let path = entry?.path();
        let Some(run) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|_| path.extension().is_some_and(|ext| ext == "jsonl"))
        else {
            continue;
        };
        let events = read_events(root, flow, run)?;
        let (Some(first), Some(last)) = (events.first(), events.last()) else {
            continue;
        };
        runs.push(RunHead {
            run: run.to_string(),
            first: first.clone(),
            last: last.clone(),
        });
    }
    // Run ids start with their time, so the name orders them.
    runs.sort_by(|a, b| b.run.cmp(&a.run));
    Ok(runs)
}

fn runs_dir(root: &Path, flow: &str) -> io::Result<PathBuf> {
    if !is_slug(flow) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{flow}' is not a flow name"),
        ));
    }
    Ok(root.join(AIME_DIR).join(RUNS_DIR).join(flow))
}

fn journal_file(root: &Path, flow: &str, run: &str) -> io::Result<PathBuf> {
    if !is_slug(run) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{run}' is not a run id"),
        ));
    }
    Ok(runs_dir(root, flow)?.join(format!("{run}.jsonl")))
}

// ---- jq ------------------------------------------------------------------------

/// Runs a jq program over one input and returns every output. The program
/// is compiled each time - a flow step runs seconds apart, and compiling
/// takes microseconds - so there is nothing to cache or invalidate.
#[tauri::command]
pub fn flow_jq(program: String, input: Value) -> Result<Vec<Value>, String> {
    run_jq(&program, input)
}

pub fn run_jq(program: &str, input: Value) -> Result<Vec<Value>, String> {
    use jaq_core::load::{Arena, File, Loader};
    use jaq_core::{data, Compiler, Ctx, Vars};
    use jaq_json::Val;

    let defs = jaq_core::defs().chain(jaq_std::defs()).chain(jaq_json::defs());
    let funs = jaq_core::funs().chain(jaq_std::funs()).chain(jaq_json::funs());
    let loader = Loader::new(defs);
    let arena = Arena::default();
    let modules = loader
        .load(
            &arena,
            File {
                code: program,
                path: (),
            },
        )
        .map_err(|errors| format!("jq: {}", describe_load_errors(&errors)))?;
    let filter = Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|errors| format!("jq: {}", describe_load_errors(&errors)))?;
    let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
    // In and out through JSON text: jaq's value is its own type, and the
    // text form is the one contract both sides keep.
    let input = jaq_json::read::parse_single(&serde_json::to_vec(&input).map_err(|e| e.to_string())?)
        .map_err(|err| format!("jq: the input is not JSON: {err}"))?;
    let mut outputs = Vec::new();
    for output in filter.id.run((ctx, input)).map(jaq_core::unwrap_valr) {
        let value = output.map_err(|err| format!("jq: {err}"))?;
        let value: Value = serde_json::from_str(&value.to_string())
            .map_err(|err| format!("jq: the output is not JSON: {err}"))?;
        outputs.push(value);
        if outputs.len() >= MOST_OUTPUTS {
            return Err(format!(
                "jq: more than {MOST_OUTPUTS} outputs - the program does not end"
            ));
        }
    }
    Ok(outputs)
}

/// The loader's and compiler's errors come per module, each a list of
/// (what, where) pairs; the first "what" is the one a person needs.
fn describe_load_errors<T: core::fmt::Debug>(errors: &T) -> String {
    let text = format!("{errors:?}");
    text.chars().take(300).collect()
}

// ---- commands ------------------------------------------------------------------

/// One program invocation of a command step, as the frontend sends it.
#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProgramRequest {
    pub cwd: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Added on top of the process's own environment.
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
}

/// Runs one program with its arguments in `cwd`, no shell in between: the
/// shared form of a flow's command step, which means the same thing on
/// every platform. The program is resolved the way the AI CLIs are (a batch
/// shim on Windows included).
#[tauri::command]
pub async fn flow_run_program(
    app: AppHandle,
    state: State<'_, ExecState>,
    id: String,
    request: ProgramRequest,
) -> Result<CommandOutcome, String> {
    if request.program.trim().is_empty() {
        return Err("no program to run".into());
    }
    let mut command = crate::providers::cli_command(&request.program, &request.args);
    command.envs(&request.env);
    let label = std::iter::once(request.program.as_str())
        .chain(request.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let outcome = exec::run_program(
        &app,
        &state,
        &id,
        &label,
        command,
        &request.cwd,
        exec::Limits {
            timeout_ms: request.timeout_ms,
            capture: VALUE_LIMIT,
        },
    )
    .await?;
    // The output is the step's value; one cut short would mislead every step after it.
    if outcome.clipped {
        return Err(format!("`{label}` printed {}", too_big()));
    }
    Ok(outcome)
}

/// Which platform arm of a command step applies here.
#[tauri::command]
pub fn host_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

// ---- files ---------------------------------------------------------------------

fn write_atomically(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = file
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a file needs a folder"))?;
    fs::create_dir_all(dir)?;
    let tmp = file.with_extension("json.part");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Command;

    fn fresh(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aime-flows-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_flow_is_stored_under_its_slug_and_listed_back() {
        let root = fresh("store");
        save_flow(&root, "fix-bug", &json!({ "name": "Fix bug" })).expect("saved");
        save_flow(&root, "release", &json!({ "name": "Release" })).expect("saved");
        let listed = list_flows(&root).expect("listed");
        assert_eq!(
            listed.iter().map(|f| f.slug.as_str()).collect::<Vec<_>>(),
            vec!["fix-bug", "release"]
        );
        assert_eq!(listed[0].flow["name"], "Fix bug");
        assert!(
            save_flow(&root, "../escape", &json!({})).is_err(),
            "a slug is a file name"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// Measured with git itself, since gitignore has more rules than anyone remembers.
    #[test]
    fn git_sees_the_flows_and_nothing_else_under_aime() {
        let root = fresh("gitsee");
        let git = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git runs")
        };
        git(&["init", "-q"]);
        fs::create_dir_all(root.join(".aime/memory")).expect("memory dir");
        fs::write(root.join(".aime/memory/note.md"), "x").expect("note");
        save_flow(&root, "fix-bug", &json!({ "name": "Fix bug" })).expect("saved");
        let out = git(&["status", "--porcelain", "--untracked-files=all"]);
        let status = String::from_utf8_lossy(&out.stdout).replace('\\', "/");
        assert!(
            status.contains(".aime/flows/fix-bug.json"),
            "the flow is invisible to git:\n{status}"
        );
        assert!(
            !status.contains(".aime/memory"),
            "the memory leaked into git:\n{status}"
        );
        assert!(
            !status.contains(".aime/.gitignore"),
            "the guard leaked into git:\n{status}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_journal_is_appended_and_read_back_and_a_torn_last_line_is_dropped() {
        let root = fresh("journal");
        append_event(&root, "fix-bug", "20261022-1", &json!({ "kind": "started" })).expect("appended");
        append_event(
            &root,
            "fix-bug",
            "20261022-1",
            &json!({ "kind": "step", "id": "a" }),
        )
        .expect("appended");
        let file = journal_file(&root, "fix-bug", "20261022-1").expect("path");
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .expect("open")
            .write_all(b"{\"kind\":\"ste")
            .expect("torn line");
        let events = read_events(&root, "fix-bug", "20261022-1").expect("read");
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["id"], "a");
        let runs = list_runs(&root, "fix-bug").expect("runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].first["kind"], "started");
        assert_eq!(runs[0].last["id"], "a");
        assert!(read_events(&root, "fix-bug", "nope").expect("empty").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn jq_runs_a_mapping_a_condition_and_refuses_a_broken_program() {
        let input =
            json!({ "items": [{ "key": "A-1", "priority": "P1" }, { "key": "A-2", "priority": "P3" }] });
        assert_eq!(
            run_jq("[.items[] | select(.priority == \"P1\") | .key]", input.clone()).expect("mapping"),
            vec![json!(["A-1"])]
        );
        assert_eq!(
            run_jq(".items | length > 1", input.clone()).expect("condition"),
            vec![json!(true)]
        );
        assert_eq!(
            run_jq(".items[].key", input).expect("several outputs"),
            vec![json!("A-1"), json!("A-2")]
        );
        let err = run_jq(".items[", json!({})).expect_err("a broken program");
        assert!(err.starts_with("jq:"), "{err}");
        let err = run_jq("range(1e9)", json!(null)).expect_err("a program that does not end");
        assert!(err.contains("does not end"), "{err}");
    }

    #[test]
    fn a_step_id_with_a_hyphen_is_read_by_name_not_by_dotted_path() {
        let input = json!({ "run-tests": { "value": { "passed": true } }, "run_tests": { "value": 1 } });
        // Read as `.run - tests`: "tests" is no filter jq knows.
        assert!(run_jq(".run-tests.value.passed", input.clone()).is_err());
        assert_eq!(
            run_jq(".[\"run-tests\"].value.passed", input.clone()).expect("by name"),
            vec![json!(true)]
        );
        assert_eq!(
            run_jq(".run_tests.value", input).expect("an underscore id"),
            vec![json!(1)]
        );
    }
}
