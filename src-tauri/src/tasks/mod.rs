//! Task detection: turns "what kind of project is this folder?" into the
//! Run / Build / Test / Publish commands the user expects (ARCHITECTURE.md §5).
//! Detection is a pure function of a few facts about the folder, so the rules
//! are unit-tested without touching a filesystem.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Where a task belongs in the UI; the order is also the order tasks appear in.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Run,
    Build,
    Test,
    Publish,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDef {
    /// Stable across runs, so a `tasks.json` entry can override a detected task.
    pub id: String,
    pub label: String,
    pub kind: TaskKind,
    pub command: String,
}

impl TaskDef {
    fn new(id: &str, label: &str, kind: TaskKind, command: String) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind,
            command,
        }
    }
}

/// What detection needs to know about a folder — gathered once, then matched.
#[derive(Default, Debug)]
struct FolderFacts {
    folder_name: String,
    /// Script names declared in package.json, in file order.
    npm_scripts: Vec<String>,
    has_package_json: bool,
    has_cargo: bool,
    has_go_mod: bool,
    has_python_project: bool,
    has_main_py: bool,
    /// File name of the .NET project or solution, if any.
    dotnet_project: Option<String>,
    has_dockerfile: bool,
}

/// The one npm script Aime treats as "Run", most idiomatic name first.
const NPM_RUN_SCRIPTS: [&str; 4] = ["dev", "start", "serve", "develop"];

fn npm_command(script: &str) -> String {
    // `npm start` and `npm test` are built-ins; everything else needs `run`.
    match script {
        "start" | "test" => format!("npm {script}"),
        other => format!("npm run {other}"),
    }
}

fn node_tasks(facts: &FolderFacts, tasks: &mut Vec<TaskDef>) {
    let has = |name: &str| facts.npm_scripts.iter().any(|s| s == name);
    if let Some(script) = NPM_RUN_SCRIPTS.into_iter().find(|s| has(s)) {
        tasks.push(TaskDef::new(
            "node.run",
            &format!("npm {script}"),
            TaskKind::Run,
            npm_command(script),
        ));
    }
    if has("build") {
        tasks.push(TaskDef::new(
            "node.build",
            "npm build",
            TaskKind::Build,
            npm_command("build"),
        ));
    }
    if has("test") {
        tasks.push(TaskDef::new(
            "node.test",
            "npm test",
            TaskKind::Test,
            npm_command("test"),
        ));
    }
}

/// Detects the tasks a folder supports. An unrecognized folder yields none —
/// the UI then says so instead of offering commands that cannot work.
fn detect_from(facts: &FolderFacts) -> Vec<TaskDef> {
    let mut tasks = Vec::new();

    if facts.has_package_json {
        node_tasks(facts, &mut tasks);
    }
    if facts.has_cargo {
        tasks.push(TaskDef::new(
            "cargo.run",
            "cargo run",
            TaskKind::Run,
            "cargo run".into(),
        ));
        tasks.push(TaskDef::new(
            "cargo.build",
            "cargo build",
            TaskKind::Build,
            "cargo build".into(),
        ));
        tasks.push(TaskDef::new(
            "cargo.test",
            "cargo test",
            TaskKind::Test,
            "cargo test".into(),
        ));
    }
    if facts.has_go_mod {
        tasks.push(TaskDef::new(
            "go.run",
            "go run .",
            TaskKind::Run,
            "go run .".into(),
        ));
        tasks.push(TaskDef::new(
            "go.build",
            "go build ./...",
            TaskKind::Build,
            "go build ./...".into(),
        ));
        tasks.push(TaskDef::new(
            "go.test",
            "go test ./...",
            TaskKind::Test,
            "go test ./...".into(),
        ));
    }
    if let Some(project) = &facts.dotnet_project {
        let quoted = format!("\"{project}\"");
        tasks.push(TaskDef::new(
            "dotnet.run",
            "dotnet run",
            TaskKind::Run,
            format!("dotnet run --project {quoted}"),
        ));
        tasks.push(TaskDef::new(
            "dotnet.build",
            "dotnet build",
            TaskKind::Build,
            format!("dotnet build {quoted}"),
        ));
        tasks.push(TaskDef::new(
            "dotnet.test",
            "dotnet test",
            TaskKind::Test,
            format!("dotnet test {quoted}"),
        ));
        tasks.push(TaskDef::new(
            "dotnet.publish",
            "dotnet publish",
            TaskKind::Publish,
            format!("dotnet publish {quoted} -c Release"),
        ));
    }
    if facts.has_python_project {
        if facts.has_main_py {
            tasks.push(TaskDef::new(
                "python.run",
                "python main.py",
                TaskKind::Run,
                "python main.py".into(),
            ));
        }
        tasks.push(TaskDef::new(
            "python.test",
            "pytest",
            TaskKind::Test,
            "python -m pytest".into(),
        ));
    }
    if facts.has_dockerfile {
        tasks.push(TaskDef::new(
            "docker.build",
            "docker build",
            TaskKind::Build,
            format!("docker build -t {} .", facts.folder_name.to_lowercase()),
        ));
    }

    tasks.sort_by_key(|task| task.kind);
    tasks
}

/// Script names declared in a package.json, ignoring malformed files —
/// a broken manifest must not cost the user their other tasks.
fn npm_scripts_of(package_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(package_json)
        .ok()
        .and_then(|manifest| manifest.get("scripts")?.as_object().cloned())
        .map(|scripts| scripts.keys().cloned().collect())
        .unwrap_or_default()
}

fn gather_facts(root: &Path) -> FolderFacts {
    let mut facts = FolderFacts {
        folder_name: root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "app".into()),
        ..FolderFacts::default()
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return facts;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        match name.as_str() {
            "package.json" => facts.has_package_json = true,
            "Cargo.toml" => facts.has_cargo = true,
            "go.mod" => facts.has_go_mod = true,
            "pyproject.toml" | "requirements.txt" => facts.has_python_project = true,
            "main.py" => facts.has_main_py = true,
            "Dockerfile" => facts.has_dockerfile = true,
            _ => {}
        }
        // A solution always wins over a bare project: it is what `dotnet`
        // expects, so a .csproj only counts while nothing else was picked.
        let is_dotnet_entry_point =
            name.ends_with(".sln") || (name.ends_with(".csproj") && facts.dotnet_project.is_none());
        if is_dotnet_entry_point {
            facts.dotnet_project = Some(name);
        }
    }
    if facts.has_package_json {
        facts.npm_scripts = std::fs::read_to_string(root.join("package.json"))
            .map(|text| npm_scripts_of(&text))
            .unwrap_or_default();
    }
    facts
}

/// Tasks the user defined for this project, overriding detected ones by id.
fn custom_tasks(root: &Path) -> Vec<TaskDef> {
    std::fs::read_to_string(root.join(".aime").join("tasks.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<TaskDef>>(&text).ok())
        .unwrap_or_default()
}

/// Detected tasks merged with the project's `.aime/tasks.json`: an entry
/// reusing a detected id replaces it, anything else is appended.
#[tauri::command]
pub fn detect_tasks(root_path: String) -> Result<Vec<TaskDef>, String> {
    let root = Path::new(&root_path);
    let mut tasks = detect_from(&gather_facts(root));
    for custom in custom_tasks(root) {
        match tasks.iter_mut().find(|task| task.id == custom.id) {
            Some(existing) => *existing = custom,
            None => tasks.push(custom),
        }
    }
    Ok(tasks)
}

/// Printed by the shell after a task so Aime can read its exit code back from
/// the terminal stream. The PTY only reports the *shell's* exit, and an
/// interactive shell stays alive after a task finishes — this marker is the
/// only honest way to know whether the task itself failed. Mirrored in
/// `src/stores/tasks.ts`.
pub const TASK_EXIT_MARKER: &str = "[aime] exit code:";

/// Wraps a task command so the shell reports the exit code, in that shell's
/// own syntax (the terminal runs PowerShell on Windows, `$SHELL` elsewhere).
#[tauri::command]
pub fn task_command_line(command: String) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{command}; Write-Host \"{TASK_EXIT_MARKER} $LASTEXITCODE\"")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("{command}; printf '{TASK_EXIT_MARKER} %s\\n' \"$?\"")
    }
}

#[cfg(test)]
mod tests {
    use super::{detect_from, npm_scripts_of, FolderFacts, TaskKind};

    fn facts_with_scripts(scripts: &[&str]) -> FolderFacts {
        FolderFacts {
            has_package_json: true,
            npm_scripts: scripts.iter().map(|s| (*s).to_string()).collect(),
            ..FolderFacts::default()
        }
    }

    fn command_of<'a>(tasks: &'a [super::TaskDef], id: &str) -> &'a str {
        &tasks.iter().find(|t| t.id == id).expect("task present").command
    }

    #[test]
    fn node_run_prefers_dev_over_the_other_aliases() {
        let tasks = detect_from(&facts_with_scripts(&["start", "dev", "build"]));
        assert_eq!(command_of(&tasks, "node.run"), "npm run dev");
    }

    #[test]
    fn npm_builtins_are_not_prefixed_with_run() {
        let tasks = detect_from(&facts_with_scripts(&["start", "test"]));
        assert_eq!(command_of(&tasks, "node.run"), "npm start");
        assert_eq!(command_of(&tasks, "node.test"), "npm test");
    }

    #[test]
    fn a_script_that_does_not_exist_yields_no_task() {
        let tasks = detect_from(&facts_with_scripts(&["lint"]));
        assert!(tasks.is_empty());
    }

    #[test]
    fn dotnet_projects_get_all_four_task_kinds() {
        let tasks = detect_from(&FolderFacts {
            dotnet_project: Some("App.sln".into()),
            ..FolderFacts::default()
        });
        let kinds: Vec<TaskKind> = tasks.iter().map(|t| t.kind).collect();
        assert_eq!(
            kinds,
            vec![TaskKind::Run, TaskKind::Build, TaskKind::Test, TaskKind::Publish]
        );
        assert_eq!(
            command_of(&tasks, "dotnet.run"),
            "dotnet run --project \"App.sln\""
        );
    }

    #[test]
    fn python_without_an_entry_point_still_offers_tests() {
        let tasks = detect_from(&FolderFacts {
            has_python_project: true,
            ..FolderFacts::default()
        });
        assert!(tasks.iter().all(|t| t.kind == TaskKind::Test));
    }

    #[test]
    fn a_polyglot_folder_lists_every_stack_grouped_by_kind() {
        let tasks = detect_from(&FolderFacts {
            has_cargo: true,
            has_go_mod: true,
            ..FolderFacts::default()
        });
        let kinds: Vec<TaskKind> = tasks.iter().map(|t| t.kind).collect();
        assert!(kinds.windows(2).all(|pair| pair[0] <= pair[1]), "grouped by kind");
        assert_eq!(tasks.len(), 6);
    }

    #[test]
    fn docker_image_name_follows_the_folder() {
        let tasks = detect_from(&FolderFacts {
            has_dockerfile: true,
            folder_name: "My-App".into(),
            ..FolderFacts::default()
        });
        assert_eq!(command_of(&tasks, "docker.build"), "docker build -t my-app .");
    }

    #[test]
    fn an_unknown_folder_offers_nothing_rather_than_guessing() {
        assert!(detect_from(&FolderFacts::default()).is_empty());
    }

    #[test]
    fn the_wrapped_command_keeps_the_original_and_reports_the_exit_code() {
        let line = super::task_command_line("cargo test".into());
        assert!(line.starts_with("cargo test;"));
        assert!(line.contains(super::TASK_EXIT_MARKER));
    }

    #[test]
    fn a_broken_manifest_costs_no_tasks_beyond_its_own() {
        assert!(npm_scripts_of("{ not json").is_empty());
        assert!(npm_scripts_of(r#"{"name":"x"}"#).is_empty());
        assert_eq!(
            npm_scripts_of(r#"{"scripts":{"dev":"vite"}}"#),
            vec!["dev".to_string()]
        );
    }
}
