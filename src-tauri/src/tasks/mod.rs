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
    /// Where the command runs, relative to the project root; `None` is the root
    /// itself. Only a member of a repository that builds nothing of its own
    /// carries one — see `member_tasks`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl TaskDef {
    fn new(id: &str, label: &str, kind: TaskKind, command: String) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind,
            command,
            cwd: None,
        }
    }

    /// The same task, run inside one folder of the repository.
    fn in_folder(self, folder: &str) -> Self {
        Self {
            id: format!("{folder}/{}", self.id),
            label: format!("{folder} · {}", self.label),
            cwd: Some(folder.to_string()),
            ..self
        }
    }
}

/// Which tool runs this project's scripts.
///
/// Not a detail of taste: the four spell the same job differently, and one of
/// them dangerously so. `bun test` is Bun's *own* test runner and ignores the
/// `test` script entirely — measured 2026-08-23 against bun 1.4.0, where it
/// answered "0 test files matching …" while the script it was meant to run sat
/// right there in package.json. Every manager below therefore goes through
/// `run`, except npm, whose two built-ins are the form its users know.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
enum PackageManager {
    #[default]
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    fn program(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }

    /// The command that runs one script of this folder's package.json.
    fn run(self, script: &str) -> String {
        match self {
            // `npm start` and `npm test` are built-ins; everything else needs `run`.
            Self::Npm if script == "start" || script == "test" => format!("npm {script}"),
            Self::Npm => format!("npm run {script}"),
            other => format!("{} run {script}", other.program()),
        }
    }

    /// The command that runs one script in every member of a workspace, for a
    /// root that has no such script of its own.
    ///
    /// Every form here was run against a two-member workspace on 2026-08-23 and
    /// watched to reach both members. Yarn is the one gap: classic's
    /// `yarn workspaces run` is gone in Yarn 2+, which spells it
    /// `workspaces foreach`, and only classic could be measured here — so a
    /// Berry repository is offered nothing rather than a command that may not
    /// exist. Nothing is the honest answer; a wrong command is not.
    fn run_in_every_member(self, script: &str, yarn_is_berry: bool) -> Option<String> {
        match self {
            Self::Npm => Some(format!("npm run {script} --workspaces --if-present")),
            Self::Pnpm => Some(format!("pnpm -r run {script}")),
            Self::Bun => Some(format!("bun run --filter '*' {script}")),
            Self::Yarn if !yarn_is_berry => Some(format!("yarn workspaces run {script}")),
            Self::Yarn => None,
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
    /// The manager whose lockfile — or whose name in `packageManager` — is here.
    package_manager: PackageManager,
    /// True when this folder is the root of a workspace rather than a project:
    /// `workspaces` in package.json, or a `pnpm-workspace.yaml` beside it.
    workspace_root: bool,
    /// Yarn 2+ keeps its settings in `.yarnrc.yml`, and renamed the workspace
    /// commands on the way. Classic left no such file.
    yarn_is_berry: bool,
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

fn node_tasks(facts: &FolderFacts, tasks: &mut Vec<TaskDef>) {
    let manager = facts.package_manager;
    let has = |name: &str| facts.npm_scripts.iter().any(|s| s == name);
    let mut push = |id: &str, script: &str, kind: TaskKind, command: String| {
        tasks.push(TaskDef::new(
            id,
            &format!("{} {script}", manager.program()),
            kind,
            command,
        ));
    };

    if let Some(script) = NPM_RUN_SCRIPTS.into_iter().find(|s| has(s)) {
        push("node.run", script, TaskKind::Run, manager.run(script));
    }
    // Building and testing every member at once is what a workspace root is
    // for, and the only sound answer when the root declares no script of its
    // own. "Run" is deliberately left out of that: starting every member's dev
    // server at once is not what the play button promises.
    for (id, script, kind) in [
        ("node.build", "build", TaskKind::Build),
        ("node.test", "test", TaskKind::Test),
    ] {
        let command = if has(script) {
            Some(manager.run(script))
        } else if facts.workspace_root {
            manager.run_in_every_member(script, facts.yarn_is_berry)
        } else {
            None
        };
        if let Some(command) = command {
            push(id, script, kind, command);
        }
    }
}

/// Detects the tasks a folder supports. An unrecognized folder yields none —
/// the UI then says so instead of offering commands that cannot work.
fn detect_from(facts: &FolderFacts) -> Vec<TaskDef> {
    let mut tasks = Vec::new();

    // A workspace root counts even with no package.json of its own: pnpm keeps
    // its member list in a file beside it.
    if facts.has_package_json || facts.workspace_root {
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

/// What a package.json says about itself beyond its scripts.
#[derive(Default)]
struct Manifest {
    scripts: Vec<String>,
    /// The `packageManager` field, as Corepack writes it: `pnpm@9.1.0`.
    declared_manager: Option<String>,
    /// Whether it declares workspace members of its own.
    workspaces: bool,
}

fn manifest_of(package_json: &str) -> Manifest {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(package_json) else {
        return Manifest::default();
    };
    Manifest {
        scripts: npm_scripts_of(package_json),
        declared_manager: value
            .get("packageManager")
            .and_then(|field| field.as_str())
            .map(|field| field.split('@').next().unwrap_or(field).to_string()),
        // npm and Bun take an array, Yarn also accepts `{ "packages": [...] }`.
        workspaces: value.get("workspaces").is_some(),
    }
}

/// Which lockfile means which manager. Ordered, so a repository carrying two of
/// them — a half-finished migration, and common — resolves the same way twice.
const LOCKFILES: [(&str, PackageManager); 5] = [
    ("pnpm-lock.yaml", PackageManager::Pnpm),
    ("yarn.lock", PackageManager::Yarn),
    ("bun.lockb", PackageManager::Bun),
    ("bun.lock", PackageManager::Bun),
    ("package-lock.json", PackageManager::Npm),
];

/// The manager this folder runs its scripts with.
///
/// The manifest wins over the lockfiles: `packageManager` is what the project
/// says about itself and what Corepack enforces, while a lockfile left behind
/// by a manager the team has moved off outlives the decision.
fn manager_of(declared: Option<&str>, lockfiles: &[PackageManager]) -> PackageManager {
    let named = match declared {
        Some("pnpm") => Some(PackageManager::Pnpm),
        Some("yarn") => Some(PackageManager::Yarn),
        Some("bun") => Some(PackageManager::Bun),
        Some("npm") => Some(PackageManager::Npm),
        _ => None,
    };
    named.or_else(|| lockfiles.first().copied()).unwrap_or_default()
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

    let mut lockfiles: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        match name.as_str() {
            "package.json" => facts.has_package_json = true,
            "pnpm-workspace.yaml" => facts.workspace_root = true,
            ".yarnrc.yml" => facts.yarn_is_berry = true,
            "Cargo.toml" => facts.has_cargo = true,
            "go.mod" => facts.has_go_mod = true,
            "pyproject.toml" | "requirements.txt" => facts.has_python_project = true,
            "main.py" => facts.has_main_py = true,
            "Dockerfile" => facts.has_dockerfile = true,
            _ => {}
        }
        if LOCKFILES.iter().any(|(lockfile, _)| *lockfile == name) {
            lockfiles.push(name.clone());
        }
        // A solution always wins over a bare project: it is what `dotnet`
        // expects, so a .csproj only counts while nothing else was picked.
        let is_dotnet_entry_point =
            name.ends_with(".sln") || (name.ends_with(".csproj") && facts.dotnet_project.is_none());
        if is_dotnet_entry_point {
            facts.dotnet_project = Some(name);
        }
    }
    let manifest = if facts.has_package_json {
        std::fs::read_to_string(root.join("package.json"))
            .map(|text| manifest_of(&text))
            .unwrap_or_default()
    } else {
        Manifest::default()
    };
    facts.npm_scripts = manifest.scripts;
    facts.workspace_root |= manifest.workspaces;
    facts.package_manager = manager_of(
        manifest.declared_manager.as_deref(),
        &LOCKFILES
            .iter()
            .filter(|(name, _)| lockfiles.iter().any(|found| found == name))
            .map(|(_, manager)| *manager)
            .collect::<Vec<_>>(),
    );
    facts
}

/// Folders that never hold a project of their own, whatever they contain.
const NOT_A_MEMBER: [&str; 10] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "vendor",
    "venv",
    "__pycache__",
];

/// How many members are looked at, so a folder of a hundred directories cannot
/// turn opening a project into a hundred filesystem walks.
const MEMBER_LIMIT: usize = 24;

/// The tasks of a repository whose root builds nothing itself.
///
/// One level down and no further. That is where a repository that keeps a
/// `frontend` beside an `api` puts them, and going deeper buys almost nothing:
/// a workspace of the `packages/*` kind declares its members in the manifest,
/// and the recursive command in `run_in_every_member` already covers every one
/// of them from the root.
fn member_tasks(root: &Path) -> Vec<TaskDef> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut folders: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| !name.starts_with('.') && !NOT_A_MEMBER.contains(&name.as_str()))
        .collect();
    // Alphabetical, so the same repository lists its members in the same order
    // however the filesystem felt like answering today.
    folders.sort();
    let mut tasks: Vec<TaskDef> = folders
        .into_iter()
        .take(MEMBER_LIMIT)
        .flat_map(|folder| {
            detect_from(&gather_facts(&root.join(&folder)))
                .into_iter()
                .map(move |task| task.in_folder(&folder))
        })
        .collect();
    // Grouped by kind like every other list of tasks, and — the sort being
    // stable — alphabetical by member inside each group.
    tasks.sort_by_key(|task| task.kind);
    tasks
}

/// Tasks the user defined for this project, overriding detected ones by id.
fn custom_tasks(root: &Path) -> Vec<TaskDef> {
    std::fs::read_to_string(root.join(crate::aime_dir::AIME_DIR).join("tasks.json"))
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
    // Only as a fallback: a root that builds something of its own is the
    // project, and burying its one Test task under a member's would be worse
    // than saying nothing about the members at all.
    if tasks.is_empty() {
        tasks = member_tasks(root);
    }
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
    use super::{
        detect_from, manager_of, manifest_of, member_tasks, npm_scripts_of, FolderFacts, PackageManager,
        TaskKind,
    };
    use std::path::PathBuf;

    fn facts_with_scripts(scripts: &[&str]) -> FolderFacts {
        FolderFacts {
            has_package_json: true,
            npm_scripts: scripts.iter().map(|s| (*s).to_string()).collect(),
            ..FolderFacts::default()
        }
    }

    fn facts_run_by(manager: PackageManager, scripts: &[&str]) -> FolderFacts {
        FolderFacts {
            package_manager: manager,
            ..facts_with_scripts(scripts)
        }
    }

    /// A fresh project folder; the name keeps concurrent tests apart.
    fn project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aime-tasks-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp project");
        root
    }

    fn detect_tasks_in(root: &std::path::Path) -> Vec<super::TaskDef> {
        super::detect_tasks(root.to_string_lossy().to_string()).expect("detection")
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
    fn every_package_manager_runs_the_script_its_own_way() {
        let pnpm = detect_from(&facts_run_by(PackageManager::Pnpm, &["dev", "test"]));
        assert_eq!(command_of(&pnpm, "node.run"), "pnpm run dev");
        assert_eq!(command_of(&pnpm, "node.test"), "pnpm run test");

        let yarn = detect_from(&facts_run_by(PackageManager::Yarn, &["test"]));
        assert_eq!(command_of(&yarn, "node.test"), "yarn run test");
    }

    #[test]
    fn bun_is_told_to_run_the_script_because_bun_test_is_something_else() {
        // `bun test` is Bun's own runner and never reaches the script: measured
        // against bun 1.4.0, it answered "0 test files matching …" instead.
        let tasks = detect_from(&facts_run_by(PackageManager::Bun, &["test"]));
        assert_eq!(command_of(&tasks, "node.test"), "bun run test");
    }

    #[test]
    fn the_manifest_outranks_a_lockfile_left_behind_by_the_last_manager() {
        let manifest = manifest_of(r#"{"packageManager":"pnpm@9.1.0","scripts":{"test":"vitest"}}"#);
        assert_eq!(manifest.declared_manager.as_deref(), Some("pnpm"));
        assert_eq!(
            manager_of(manifest.declared_manager.as_deref(), &[PackageManager::Npm]),
            PackageManager::Pnpm
        );
        // With nothing declared, the lockfile decides; with neither, npm does.
        assert_eq!(manager_of(None, &[PackageManager::Yarn]), PackageManager::Yarn);
        assert_eq!(manager_of(None, &[]), PackageManager::Npm);
    }

    #[test]
    fn a_workspace_root_without_scripts_of_its_own_runs_every_member() {
        let facts = |manager| FolderFacts {
            has_package_json: true,
            package_manager: manager,
            workspace_root: true,
            ..FolderFacts::default()
        };
        assert_eq!(
            command_of(&detect_from(&facts(PackageManager::Npm)), "node.test"),
            "npm run test --workspaces --if-present"
        );
        assert_eq!(
            command_of(&detect_from(&facts(PackageManager::Pnpm)), "node.test"),
            "pnpm -r run test"
        );
        // Never "Run": one dev server is a task, twelve at once is not.
        assert!(detect_from(&facts(PackageManager::Npm))
            .iter()
            .all(|task| task.kind != TaskKind::Run));
    }

    #[test]
    fn a_root_script_beats_the_recursive_form_that_would_replace_it() {
        let tasks = detect_from(&FolderFacts {
            workspace_root: true,
            ..facts_with_scripts(&["test"])
        });
        assert_eq!(command_of(&tasks, "node.test"), "npm test");
    }

    #[test]
    fn yarn_berry_is_offered_nothing_rather_than_classics_command() {
        // Yarn 2+ renamed `workspaces run` to `workspaces foreach`, and only
        // classic could be measured here.
        let tasks = detect_from(&FolderFacts {
            has_package_json: true,
            package_manager: PackageManager::Yarn,
            workspace_root: true,
            yarn_is_berry: true,
            ..FolderFacts::default()
        });
        assert!(tasks.is_empty());
    }

    /// The rules above run on facts; this one proves the facts are read off a
    /// real folder - the lockfile, the manifest field, and the workspace file
    /// pnpm keeps beside the manifest rather than inside it.
    #[test]
    fn the_folder_itself_says_which_manager_and_whether_it_is_a_workspace() {
        let root = project("facts");
        std::fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'").expect("lockfile");
        std::fs::write(root.join("package.json"), r#"{"scripts":{"test":"vitest"}}"#).expect("manifest");
        assert_eq!(command_of(&detect_tasks_in(&root), "node.test"), "pnpm run test");

        // The same folder, now declaring a manager: the manifest outranks the lock.
        std::fs::write(
            root.join("package.json"),
            r#"{"packageManager":"yarn@1.22.22","scripts":{"test":"vitest"}}"#,
        )
        .expect("manifest");
        assert_eq!(command_of(&detect_tasks_in(&root), "node.test"), "yarn run test");

        // And as a workspace root with no test script of its own.
        std::fs::write(root.join("package.json"), r#"{"private":true}"#).expect("manifest");
        std::fs::write(root.join("pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"").expect("workspace");
        assert_eq!(
            command_of(&detect_tasks_in(&root), "node.test"),
            "pnpm -r run test"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_repository_that_builds_nothing_itself_still_finds_its_members() {
        let root = project("members");
        for (folder, manifest) in [
            ("api", r#"{"scripts":{"test":"jest"}}"#),
            ("web", r#"{"scripts":{"dev":"vite","test":"vitest"}}"#),
        ] {
            std::fs::create_dir_all(root.join(folder)).expect("member folder");
            std::fs::write(root.join(folder).join("package.json"), manifest).expect("manifest");
        }
        // Noise that must not be mistaken for a member.
        std::fs::create_dir_all(root.join("node_modules").join("left-pad")).expect("noise");
        std::fs::write(
            root.join("node_modules").join("left-pad").join("package.json"),
            r#"{"scripts":{"test":"nope"}}"#,
        )
        .expect("noise manifest");

        let tasks = member_tasks(&root);
        let ids: Vec<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(ids, vec!["web/node.run", "api/node.test", "web/node.test"]);
        let api = tasks
            .iter()
            .find(|task| task.id == "api/node.test")
            .expect("api test");
        assert_eq!(api.cwd.as_deref(), Some("api"));
        assert_eq!(api.command, "npm test");
        assert_eq!(api.label, "api · npm test");
        let _ = std::fs::remove_dir_all(&root);
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
