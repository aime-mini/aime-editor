//! Debug adapters Aime was taught, rather than shipped with.
//!
//! The built-in table (`catalog.rs`) only holds adapters that were driven end to
//! end before being written down, which is why it is small — and why a language
//! outside it cannot be debugged no matter what the user installs. That is the
//! wall an AI editor has to be able to walk through: the adapter for Java, C++
//! or Ruby is not code, it is **four facts and a launch shape**, so an agent can
//! find out what this machine needs, install it, and write those facts here.
//!
//! What stays Aime's: the framing, the DAP conversation, breakpoint semantics,
//! and the transports themselves. An entry is configuration a person can read —
//! a command line and some JSON — never code.
//!
//! Nothing written here is believed on anyone's word. A learned adapter is
//! usable only once Aime has started it, set a breakpoint, launched, and seen
//! the program stop on that line (`dap_verify`, driven by the frontend's own DAP
//! client). Until then it is "not verified yet", which is the same rule as
//! ARCHITECTURE.md §5's "only adapters that have been driven for real", enforced
//! at run time instead of at commit time.
//!
//! Two files, both optional: `<app-data>/debug-adapters.json` for what this
//! machine can debug, and `<project>/.aime/debug-adapters.json` for what one
//! project needs. The project's entry wins over the machine's; a built-in wins
//! over both, because a measured adapter is never overridden by a guess.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// How Aime reaches a learned adapter — the same two shapes the built-ins use.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum LearnedTransport {
    /// DAP over the adapter's own stdin and stdout.
    Stdio,
    /// The adapter prints the address it bound to; every session is a connection.
    TcpServer,
    /// The adapter lives *inside* a language server: Aime starts that server,
    /// asks it over LSP to open a debug session, and connects to the port it
    /// answers with. This is how java-debug works - it is a JDT LS plugin, with
    /// no standalone process to launch - and it is the third and last shape,
    /// because everything else an agent can teach is data.
    LanguageServer,
}

/// What has to run before the debugger can see the program (compile, bundle).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LearnedPrepare {
    /// A command line, run in the target's folder. Shown in the console first:
    /// Aime never runs something on a machine without saying what it ran.
    pub command: String,
}

/// One adapter Aime was taught.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LearnedAdapter {
    /// Free-form, and shown to the user: "java-debug", "lldb-dap".
    pub id: String,
    /// Monaco language ids this serves. The same id twice is the file's problem.
    pub language_ids: Vec<String>,
    /// The `type` the launch configuration must carry.
    pub config_type: String,
    pub transport: LearnedTransport,
    /// The program that starts the adapter, and what proves it is installed.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Arguments that prove the adapter is really there. Presence on PATH is not
    /// enough when the program is a runtime — `python` exists on most machines
    /// whether or not the adapter was ever installed into it.
    #[serde(default)]
    pub probe_args: Vec<String>,
    /// Fields this adapter requires in its launch configuration, merged on top
    /// of the ones every adapter gets. `{"mainClass": "com.example.App"}`.
    #[serde(default)]
    pub launch: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub prepare: Option<LearnedPrepare>,
    /// What to tell the user when the program is not on this machine.
    /// The LSP command that makes the server open a debug session and answer
    /// with a port. Required for the `languageServer` transport and ignored
    /// otherwise - java-debug's is `vscode.java.startDebugSession`.
    #[serde(default)]
    pub language_server_command: Option<String>,
    #[serde(default)]
    pub install_hint: String,
    /// The program and line the agent expects Aime to stop on when it checks
    /// this entry. Without it a taught adapter can only be verified by hand,
    /// which for an AI editor is the wrong way round.
    #[serde(default)]
    pub verify_with: Option<VerifyWith>,
    /// For mobile: what this adapter can run on, and which launch field takes it.
    #[serde(default)]
    pub device_query: Option<DeviceQuery>,
    /// Written by Aime after a real session stopped on a real breakpoint, and by
    /// nothing else. Absent means "not proven here yet".
    #[serde(default)]
    pub verified: Option<Verification>,
}

/// How to ask what a mobile adapter could run on, and where the answer goes.
///
/// The one concept mobile adds that desktop debugging has no use for: a program
/// is not launched on *this* machine but on a device or emulator, and the
/// adapter takes its id as a launch field. Both halves are data, so an agent can
/// write them: `flutter devices --machine` answers JSON, `adb devices` answers
/// lines of `id<tab>state`, and the field is `deviceId` for Flutter.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceQuery {
    /// The command that lists devices, run in the project folder.
    pub command: String,
    /// `json` for an array of objects, `lines` for `id<whitespace>rest`.
    pub format: DeviceFormat,
    /// Which JSON field holds the id, and which holds something readable.
    #[serde(default)]
    pub id_field: Option<String>,
    #[serde(default)]
    pub label_field: Option<String>,
    /// The launch-configuration field the chosen id is written into.
    pub device_field: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceFormat {
    Json,
    Lines,
}

/// One device a program could be run on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub label: String,
}

/// Reads a device list out of whatever the query printed.
///
/// Pure, because the parsing is the part that can be wrong: `adb devices` starts
/// with a banner line and ends with a blank one, and a JSON field name is the
/// agent's guess until it is proven against a real answer.
pub fn parse_devices(output: &str, query: &DeviceQuery) -> Vec<Device> {
    match query.format {
        DeviceFormat::Json => {
            let id_field = query.id_field.as_deref().unwrap_or("id");
            let label_field = query.label_field.as_deref().unwrap_or("name");
            serde_json::from_str::<Vec<serde_json::Value>>(output.trim())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|entry| {
                    let id = entry.get(id_field)?.as_str()?.to_string();
                    let label = entry
                        .get(label_field)
                        .and_then(|value| value.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some(Device { id, label })
                })
                .collect()
        }
        DeviceFormat::Lines => output
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                // `adb devices` prints a banner, blank lines and "offline" rows.
                if trimmed.is_empty() || trimmed.ends_with(':') || trimmed.contains("offline") {
                    return None;
                }
                let mut parts = trimmed.split_whitespace();
                let id = parts.next()?.to_string();
                let rest = parts.collect::<Vec<_>>().join(" ");
                let label = if rest.is_empty() {
                    id.clone()
                } else {
                    format!("{id} ({rest})")
                };
                Some(Device { id, label })
            })
            .collect(),
    }
}

/// Asks a taught adapter's own command what it could run on.
#[tauri::command]
pub async fn dap_devices(
    app: AppHandle,
    language_id: String,
    root: Option<String>,
) -> Result<Vec<Device>, String> {
    let path = root.as_ref().map(Path::new);
    let Some(adapter) = adapters_for(&app, path, &language_id) else {
        return Ok(Vec::new());
    };
    let Some(query) = adapter.device_query else {
        return Ok(Vec::new());
    };

    let output = crate::dap::shell_command(&query.command, root.as_deref())
        .output()
        .await
        .map_err(|e| format!("Could not run `{}`: {e}", query.command))?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("`{}` failed: {reason}", query.command));
    }
    Ok(parse_devices(&String::from_utf8_lossy(&output.stdout), &query))
}

/// A program that is known to stop where it is told, for checking an entry.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyWith {
    /// Path to the program, relative to the project root or absolute.
    pub program: String,
    /// A line with a statement on it — adapters refuse or move the others.
    pub line: u32,
}

/// The evidence that a learned adapter actually debugs something.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    /// The program Aime launched, and the line it stopped on.
    pub program: String,
    pub line: u32,
    /// Timestamp from the frontend — the backend has no clock it should trust
    /// more than the one the user sees.
    pub at: String,
}

/// The file's shape. A list, so one file can teach several languages.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LearnedFile {
    #[serde(default)]
    pub adapters: Vec<LearnedAdapter>,
}

pub const LEARNED_FILE: &str = "debug-adapters.json";

/// Where this machine's learned adapters live.
pub fn machine_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(LEARNED_FILE))
}

/// Where one project's own learned adapters live.
pub fn project_file(root: &Path) -> PathBuf {
    root.join(crate::aime_dir::AIME_DIR).join(LEARNED_FILE)
}

/// Reads one file, or nothing. A broken file is reported and skipped: it must
/// not take the built-in adapters down with it.
fn read(path: &Path) -> Vec<LearnedAdapter> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<LearnedFile>(&text) {
        Ok(file) => file.adapters,
        Err(err) => {
            eprintln!("[dap] ignoring {}: {err}", path.display());
            Vec::new()
        }
    }
}

/// Every learned adapter for a language, project before machine.
pub fn adapters_for(app: &AppHandle, root: Option<&Path>, language_id: &str) -> Option<LearnedAdapter> {
    let project = root.map(|root| read(&project_file(root))).unwrap_or_default();
    let machine = machine_file(app).map(|path| read(&path)).unwrap_or_default();
    project
        .into_iter()
        .chain(machine)
        .find(|adapter| adapter.language_ids.iter().any(|id| id == language_id))
}

/// Records that Aime itself watched this adapter stop where it was told to.
///
/// A command rather than something the agent writes: the stamp means "Aime saw
/// it", and an agent that could write it would be marking its own homework.
#[tauri::command]
pub fn dap_mark_verified(
    app: AppHandle,
    language_id: String,
    root: Option<String>,
    verified: Verification,
) -> Result<(), String> {
    record_verification(&app, root.as_ref().map(Path::new), &language_id, verified)
}

/// Writes a verification stamp next to the adapter it belongs to.
fn record_verification(
    app: &AppHandle,
    root: Option<&Path>,
    language_id: &str,
    verified: Verification,
) -> Result<(), String> {
    for path in candidate_files(app, root) {
        let mut adapters = read(&path);
        let Some(found) = adapters
            .iter_mut()
            .find(|adapter| adapter.language_ids.iter().any(|id| id == language_id))
        else {
            continue;
        };
        found.verified = Some(verified);
        let text = serde_json::to_string_pretty(&LearnedFile { adapters })
            .map_err(|e| format!("Could not serialize {}: {e}", path.display()))?;
        return std::fs::write(&path, text).map_err(|e| format!("Could not write {}: {e}", path.display()));
    }
    Err(format!("No learned adapter for {language_id} to stamp"))
}

/// The files that could hold an entry, in the order they are consulted.
fn candidate_files(app: &AppHandle, root: Option<&Path>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(root) = root {
        files.push(project_file(root));
    }
    if let Ok(path) = machine_file(app) {
        files.push(path);
    }
    files
}

#[cfg(test)]
mod tests {
    use super::{LearnedAdapter, LearnedFile, LearnedTransport};

    /// The shape an agent has to produce. Parsed here from the literal text so
    /// the prompt and the parser can never drift apart silently.
    const TAUGHT: &str = r#"{
      "adapters": [
        {
          "id": "java-debug",
          "languageIds": ["java"],
          "configType": "java",
          "transport": "stdio",
          "program": "node",
          "args": ["adapter.js"],
          "probeArgs": ["--version"],
          "launch": { "mainClass": "com.example.App" },
          "prepare": { "command": "javac -d out src/App.java" },
          "installHint": "download Eclipse JDT LS"
        }
      ]
    }"#;

    #[test]
    fn an_entry_an_agent_wrote_parses_into_everything_a_launch_needs() {
        let file: LearnedFile = serde_json::from_str(TAUGHT).expect("the documented shape parses");
        let adapter = file.adapters.first().expect("one adapter");
        assert_eq!(adapter.id, "java-debug");
        assert_eq!(adapter.transport, LearnedTransport::Stdio);
        assert_eq!(adapter.language_ids, ["java"]);
        assert_eq!(adapter.launch["mainClass"], "com.example.App");
        assert_eq!(
            adapter.prepare.as_ref().map(|prepare| prepare.command.as_str()),
            Some("javac -d out src/App.java")
        );
        // Nothing an agent writes counts as proof.
        assert!(adapter.verified.is_none(), "a fresh entry is never verified");
    }

    #[test]
    fn the_optional_half_of_the_shape_really_is_optional() {
        let minimal = r#"{"adapters":[{"id":"x","languageIds":["lua"],"configType":"lua",
            "transport":"tcpServer","program":"lua-dap"}]}"#;
        let file: LearnedFile = serde_json::from_str(minimal).expect("a minimal entry parses");
        let adapter = file.adapters.first().expect("one adapter");
        assert!(adapter.args.is_empty());
        assert!(adapter.probe_args.is_empty());
        assert!(adapter.launch.is_empty());
        assert!(adapter.prepare.is_none());
        assert_eq!(adapter.transport, LearnedTransport::TcpServer);
    }

    /// A file Aime cannot read must cost the user their learned adapters and
    /// nothing else — the built-in ones have to keep working.
    #[test]
    fn a_broken_file_is_skipped_rather_than_fatal() {
        let root = std::env::temp_dir().join("aime-learned-test-broken");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp folder");
        let path = root.join("debug-adapters.json");
        std::fs::write(&path, "{ this is not json").expect("write");
        assert!(super::read(&path).is_empty());
    }

    #[test]
    fn a_project_entry_wins_over_the_machine_wide_one() {
        // The merge order is what makes a project able to pin its own toolchain
        // without touching the machine's answer for every other project.
        let project: Vec<LearnedAdapter> = serde_json::from_str(
            r#"[{"id":"project","languageIds":["lua"],"configType":"lua",
                "transport":"stdio","program":"p"}]"#,
        )
        .expect("parses");
        let machine: Vec<LearnedAdapter> = serde_json::from_str(
            r#"[{"id":"machine","languageIds":["lua"],"configType":"lua",
                "transport":"stdio","program":"m"}]"#,
        )
        .expect("parses");
        let found = project
            .into_iter()
            .chain(machine)
            .find(|adapter| adapter.language_ids.iter().any(|id| id == "lua"))
            .expect("one of them serves lua");
        assert_eq!(found.id, "project");
    }
}

#[cfg(test)]
mod device_tests {
    use super::{parse_devices, DeviceFormat, DeviceQuery};

    fn query(format: DeviceFormat) -> DeviceQuery {
        DeviceQuery {
            command: "irrelevant".into(),
            format,
            id_field: Some("id".into()),
            label_field: Some("name".into()),
            device_field: "deviceId".into(),
        }
    }

    /// The shape `flutter devices --machine` answers with.
    #[test]
    fn a_json_answer_becomes_a_list_of_devices() {
        let output = r#"[{"id":"emulator-5554","name":"Pixel 7 API 34"},{"id":"windows","name":"Windows"}]"#;
        let devices = parse_devices(output, &query(DeviceFormat::Json));
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "emulator-5554");
        assert_eq!(devices[0].label, "Pixel 7 API 34");
    }

    /// What `adb devices` really prints: a banner, then rows, then a blank line.
    #[test]
    fn the_banner_and_the_offline_rows_of_adb_are_not_devices() {
        let output = "List of devices attached:\nemulator-5554\tdevice\n0123456789\toffline\n\n";
        let devices = parse_devices(output, &query(DeviceFormat::Lines));
        assert_eq!(devices.len(), 1, "{devices:?}");
        assert_eq!(devices[0].id, "emulator-5554");
        assert_eq!(devices[0].label, "emulator-5554 (device)");
    }

    #[test]
    fn a_query_that_answered_nonsense_costs_nothing() {
        assert!(parse_devices("not json at all", &query(DeviceFormat::Json)).is_empty());
    }
}
