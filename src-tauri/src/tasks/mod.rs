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
    /// Answers "is this code acceptable?" without changing anything: a linter, a
    /// type check, a formatter asked only to report. Kept apart from Test
    /// because a Task Run gates on both and they fail for different reasons.
    Check,
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

    /// The command that installs this folder's dependencies, spelled the way
    /// this manager spells it. All four accept the bare verb.
    fn install(self) -> String {
        format!("{} install", self.program())
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

/// A .NET solution, in either of the two file formats.
///
/// `.slnx` is not an edge case: measured 2026-09-03, `dotnet new sln` on SDK
/// 10.0.300 produces `Name.slnx` and nothing else, so every solution created
/// with a current SDK is one. Recognising only `.sln` left those repositories
/// with no tasks at all.
fn is_dotnet_solution(name: &str) -> bool {
    name.ends_with(".sln") || name.ends_with(".slnx")
}

/// The one npm script Aime treats as "Run", most idiomatic name first.
const NPM_RUN_SCRIPTS: [&str; 4] = ["dev", "start", "serve", "develop"];

/// Segments that turn a test script into something that never answers: it does
/// not terminate on its own.
///
/// Measured over the 44 package.json files on this machine (2026-08-24):
/// `test:watch` is `jest --watch`, `test:ui` is `vitest --ui`, and `test:debug`
/// is `node --inspect-brk …`, which sits waiting for a debugger to attach. Each
/// is a fine thing to start and watch, so each is still offered — as a Run
/// rather than as a suite. A gate that ran one would spend its whole timeout
/// learning nothing.
const NEVER_FINISHES: [&str; 4] = ["watch", "ui", "debug", "inspect"];

/// Scripts that judge the code without rewriting it, most common name first.
///
/// Measured over the same package.json files: `lint` in 19 of them, then
/// `format` (5), `lint:fix` (3), `check` (2), `format:check`, `type-check`,
/// `prettier`. Only the read-only half is here. `format`, `prettier` and
/// anything `:fix` REWRITE the tree — in this very repository `format` is
/// `prettier --write "src/**"` — and a gate that edits the code it is judging
/// has stopped being a gate.
const NPM_CHECK_SCRIPTS: [&str; 6] = ["check", "lint", "typecheck", "type-check", "tsc", "format:check"];

/// Whether a script name declares itself a test suite, and its segments.
///
/// The FIRST segment decides, which is what tells `test:e2e` from `build:test` —
/// the latter being a build with a test configuration, measured on this machine
/// as `ng build --configuration=test`. `e2e` alone is here because that is how
/// Angular spells it. A name like `nodejs-tests` or `truffle:test:bsc_testnet`
/// is left alone: it may well be a suite, but nothing in the name says so, and
/// running a command on a hunch is worse than not offering it.
fn test_script_segments(name: &str) -> Option<Vec<String>> {
    let lower = name.to_ascii_lowercase();
    let segments: Vec<String> = lower.split(':').map(str::to_string).collect();
    let first = segments.first()?;
    (first == "test" || first == "e2e").then_some(segments)
}

fn node_tasks(facts: &FolderFacts, tasks: &mut Vec<TaskDef>) {
    let manager = facts.package_manager;
    let has = |name: &str| facts.npm_scripts.iter().any(|s| s == name);
    let mut push = |id: String, script: &str, kind: TaskKind, command: String| {
        tasks.push(TaskDef::new(
            &id,
            &format!("{} {script}", manager.program()),
            kind,
            command,
        ));
    };

    if let Some(script) = NPM_RUN_SCRIPTS.into_iter().find(|s| has(s)) {
        push("node.run".to_string(), script, TaskKind::Run, manager.run(script));
    }
    // Building every member at once is what a workspace root is for, and the
    // only sound answer when the root declares no script of its own. "Run" is
    // deliberately left out of that: starting every member's dev server at once
    // is not what the play button promises.
    let build = if has("build") {
        Some(manager.run("build"))
    } else if facts.workspace_root {
        manager.run_in_every_member("build", facts.yarn_is_berry)
    } else {
        None
    };
    if let Some(command) = build {
        push("node.build".to_string(), "build", TaskKind::Build, command);
    }

    // Every suite the project declares, not the first one: a repository that
    // keeps `test` apart from `test:e2e` has two, and a gate running one of them
    // measures half the project while claiming to have measured the project.
    let mut suites = 0;
    for script in &facts.npm_scripts {
        let Some(segments) = test_script_segments(script) else {
            continue;
        };
        let kind = if segments.iter().any(|s| NEVER_FINISHES.contains(&s.as_str())) {
            TaskKind::Run
        } else {
            suites += 1;
            TaskKind::Test
        };
        // `node.test` for the plain script, so a `tasks.json` entry written
        // against it keeps overriding the same task it always did.
        push(format!("node.{script}"), script, kind, manager.run(script));
    }
    if suites == 0 {
        if let Some(command) = facts
            .workspace_root
            .then(|| manager.run_in_every_member("test", facts.yarn_is_berry))
            .flatten()
        {
            push("node.test".to_string(), "test", TaskKind::Test, command);
        }
    }

    for script in NPM_CHECK_SCRIPTS.into_iter().filter(|s| has(s)) {
        push(
            format!("node.{script}"),
            script,
            TaskKind::Check,
            manager.run(script),
        );
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
        // Both ship with the toolchain and both only report: `--check` is what
        // keeps rustfmt from rewriting the tree it is judging.
        tasks.push(TaskDef::new(
            "cargo.clippy",
            "cargo clippy",
            TaskKind::Check,
            "cargo clippy --all-targets".into(),
        ));
        tasks.push(TaskDef::new(
            "cargo.fmt",
            "cargo fmt --check",
            TaskKind::Check,
            "cargo fmt --check".into(),
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
        // `dotnet run` takes a *project*; a solution is not one. Measured
        // 2026-09-03 against SDK 10.0.300: `run --project Classic.sln` fails
        // with MSB4025 and `--project Solu.slnx` with MSB4068, while build,
        // test and publish accept all three forms. So a solution is offered
        // everything except Run — which project of twenty it should start is
        // not a guess Aime gets to make from a file name.
        if !is_dotnet_solution(project) {
            tasks.push(TaskDef::new(
                "dotnet.run",
                "dotnet run",
                TaskKind::Run,
                format!("dotnet run --project {quoted}"),
            ));
        }
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
            is_dotnet_solution(&name) || (name.ends_with(".csproj") && facts.dotnet_project.is_none());
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

/// Whether this folder builds something of its own, or only says how to
/// package whatever lies underneath it.
///
/// A Dockerfile is the one signal that says nothing about where the source is,
/// and taking it for a project is how a whole repository ends up with a single
/// task. Measured 2026-09-03 on a real .NET repository: its root held a
/// `Dockerfile` and a `global.json`, its two solutions sat in `src/` and
/// `control-plane/`, and because the Dockerfile alone made the root "already
/// detected", the member scan never ran — the project offered `docker build`
/// and no way to compile anything.
fn builds_its_own_source(facts: &FolderFacts) -> bool {
    facts.has_package_json
        || facts.workspace_root
        || facts.has_cargo
        || facts.has_go_mod
        || facts.has_python_project
        || facts.has_main_py
        || facts.dotnet_project.is_some()
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
    let facts = gather_facts(root);
    let mut tasks = detect_from(&facts);
    // A root that builds its own source *is* the project, and burying its Test
    // task under a member's would be worse than saying nothing about the
    // members. A root that only knows how to package what is under it is not,
    // so its members are asked as well — and its own tasks are kept, because
    // `docker build` is still worth offering next to them.
    if !builds_its_own_source(&facts) {
        tasks.extend(member_tasks(root));
        tasks.sort_by_key(|task| task.kind);
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
/// The command that makes a fresh checkout of this folder runnable, or `None`.
///
/// A parallel run works in a just-created git worktree, and a JavaScript
/// project's worktree has no `node_modules` — every suite would fail for a
/// reason that has nothing to do with the change. This answers only what the
/// project itself declares: the install verb of the package manager named by
/// its manifest or lockfile. Toolchains that fetch their own dependencies on
/// build (cargo, go) need nothing, and a folder with no manifest gets `None`
/// rather than a guess.
#[tauri::command]
pub fn worktree_setup_command(root_path: String) -> Option<String> {
    let facts = gather_facts(Path::new(&root_path));
    facts.has_package_json.then(|| facts.package_manager.install())
}

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

/// What Aime could confirm about one command an AI proposed.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCheck {
    /// The program the command starts, as written.
    pub program: String,
    /// Whether that program is on this machine.
    pub program_found: bool,
    /// Whether the folder the command would run in exists in this repository.
    pub folder_found: bool,
}

/// The program a command line starts, as a shell would take it.
///
/// Only the first word, and only when the command really begins with one: a
/// line that opens with a redirect, a variable assignment or a pipe is not
/// something Aime can check this way, and saying so beats checking the wrong
/// token. Quotes are stripped because a path with a space arrives quoted.
fn program_of(command: &str) -> Option<String> {
    let line = command.trim_start();
    // A quoted program runs to its closing quote, spaces and all — that is the
    // whole reason it was quoted. Splitting on whitespace first would cut
    // `"C:\Program Files\…"` in half and then look for a tool called
    // `"C:\Program`.
    let quote = line.chars().next().filter(|c| *c == '"' || *c == '\'');
    let name = match quote {
        Some(quote) => line[1..].split(quote).next()?,
        None => line.split_whitespace().next()?,
    };
    let unusable = name.is_empty() || name.contains('=') || name.starts_with(['<', '>', '|', '&']);
    (!unusable).then(|| name.to_string())
}

/// Checks commands an AI read out of a project, before any of them is offered.
///
/// Two things are checkable without running anything, and both are the failures
/// that would otherwise reach the user: the tool is not installed on this
/// machine, or the folder does not exist in this repository. Whether the build
/// then *succeeds* is not Aime's question — a project that does not compile is
/// news for the user, not a reason to hide the command that told them so.
///
/// Deliberately not "run it and look at the exit code": `mvn package` failing
/// on a broken repository and `mvn` not existing are the same exit code to a
/// shell, and telling them apart by matching error text is the kind of guess
/// this codebase does not make.
#[tauri::command]
pub fn check_task_commands(root_path: String, commands: Vec<String>, folders: Vec<String>) -> Vec<TaskCheck> {
    let root = Path::new(&root_path);
    commands
        .iter()
        .zip(folders.iter().chain(std::iter::repeat(&String::new())))
        .map(|(command, folder)| {
            let program = program_of(command);
            TaskCheck {
                program_found: program
                    .as_deref()
                    .is_some_and(|name| crate::program::Program::resolve(name).exists()),
                program: program.unwrap_or_default(),
                folder_found: folder.is_empty() || folder == "." || root.join(folder).is_dir(),
            }
        })
        .collect()
}

/// Writes tasks into the project's `.aime/tasks.json`, replacing entries that
/// share an id and keeping every other one — including the user's own.
///
/// The file is the existing override channel (`custom_tasks`), so a task Aime
/// learned this way survives a restart and can be edited by hand afterwards
/// like any other. Only usable checks reach here; the caller has filtered.
#[tauri::command]
pub fn save_tasks(root_path: String, tasks: Vec<TaskDef>) -> Result<(), String> {
    let root = Path::new(&root_path);
    let dir = root.join(crate::aime_dir::AIME_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    crate::aime_dir::ensure_self_ignored(root)
        .map_err(|e| format!("Could not keep .aime out of git: {e}"))?;

    let path = dir.join("tasks.json");
    let mut kept = custom_tasks(root);
    for task in tasks {
        match kept.iter_mut().find(|existing| existing.id == task.id) {
            Some(existing) => *existing = task,
            None => kept.push(task),
        }
    }
    let text = serde_json::to_string_pretty(&kept).map_err(|e| format!("Could not write tasks: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    // Stamped even when the list was empty: "asked and found nothing" and
    // "never asked" are different, and only one of them is worth paying for a
    // second time.
    std::fs::write(dir.join(PROFILE_MARKER), b"")
        .map_err(|e| format!("Could not record the task profile: {e}"))
}

/// Records that this project has been read for its tasks, so opening it again
/// does not spend another AI call on a question already answered.
const PROFILE_MARKER: &str = "task-profile";

/// Whether the AI has already read this project's tasks.
///
/// Deliberately a file rather than a session flag: a developer who opens the
/// same repository every morning should pay for that reading once, not once a
/// day. Deleting `.aime/task-profile` asks again, which is the escape hatch
/// for a repository that has since grown a build.
#[tauri::command]
pub fn task_profile_exists(root_path: String) -> bool {
    Path::new(&root_path)
        .join(crate::aime_dir::AIME_DIR)
        .join(PROFILE_MARKER)
        .exists()
}

#[cfg(test)]
mod tests {
    use super::{
        check_task_commands, detect_from, manager_of, manifest_of, member_tasks, npm_scripts_of, program_of,
        save_tasks, task_profile_exists, FolderFacts, PackageManager, TaskDef, TaskKind,
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

    /// Ids and commands of every task of one kind, in the order detected.
    fn of_kind(tasks: &[super::TaskDef], kind: TaskKind) -> Vec<(&str, &str)> {
        tasks
            .iter()
            .filter(|task| task.kind == kind)
            .map(|task| (task.id.as_str(), task.command.as_str()))
            .collect()
    }

    #[test]
    fn every_test_script_is_a_suite_of_its_own() {
        // The hole this closes: a repository that keeps its unit tests apart from
        // its end-to-end tests has two suites, and running one of them measures
        // half the project while claiming to have measured the project.
        let tasks = detect_from(&facts_with_scripts(&["test", "test:e2e", "e2e"]));
        assert_eq!(
            of_kind(&tasks, TaskKind::Test),
            vec![
                ("node.test", "npm test"),
                ("node.test:e2e", "npm run test:e2e"),
                ("node.e2e", "npm run e2e"),
            ]
        );
    }

    #[test]
    fn a_suite_that_never_finishes_is_offered_to_start_rather_than_to_measure() {
        // `jest --watch`, `vitest --ui` and `node --inspect-brk` all sit there
        // until stopped. Worth starting by hand, never worth waiting on: a gate
        // that ran one would spend its whole timeout learning nothing.
        let tasks = detect_from(&facts_with_scripts(&[
            "test",
            "test:watch",
            "test:ui",
            "test:debug",
        ]));
        assert_eq!(of_kind(&tasks, TaskKind::Test), vec![("node.test", "npm test")]);
        let watchers: Vec<&str> = of_kind(&tasks, TaskKind::Run)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(
            watchers,
            vec!["node.test:watch", "node.test:ui", "node.test:debug"]
        );
    }

    #[test]
    fn a_build_configured_for_test_is_not_a_suite() {
        // Measured on this machine: `build:test` is `ng build --configuration=test`.
        // The first segment is what says which of the two a script is, and
        // `nodejs-tests` says nothing either way - so nothing is claimed about it.
        let tasks = detect_from(&facts_with_scripts(&["build:test", "pretest", "nodejs-tests"]));
        assert!(of_kind(&tasks, TaskKind::Test).is_empty(), "{tasks:?}");
    }

    #[test]
    fn only_the_checks_that_do_not_rewrite_the_code_are_offered() {
        // `format` is `prettier --write` in this very repository, and `lint:fix`
        // says what it does in its name. A gate that reformats the code it is
        // judging turns every verdict into a verdict about its own edit.
        let tasks = detect_from(&facts_with_scripts(&[
            "check",
            "lint",
            "lint:fix",
            "format",
            "type-check",
            "format:check",
        ]));
        assert_eq!(
            of_kind(&tasks, TaskKind::Check),
            vec![
                ("node.check", "npm run check"),
                ("node.lint", "npm run lint"),
                ("node.type-check", "npm run type-check"),
                ("node.format:check", "npm run format:check"),
            ]
        );
    }

    #[test]
    fn a_cargo_project_is_checked_by_the_two_tools_it_ships_with() {
        let tasks = detect_from(&FolderFacts {
            has_cargo: true,
            ..FolderFacts::default()
        });
        assert_eq!(
            of_kind(&tasks, TaskKind::Check),
            vec![
                ("cargo.clippy", "cargo clippy --all-targets"),
                ("cargo.fmt", "cargo fmt --check"),
            ]
        );
    }

    #[test]
    fn a_script_aime_knows_nothing_about_yields_no_task() {
        let tasks = detect_from(&facts_with_scripts(&["docs", "release-notes"]));
        assert!(tasks.is_empty(), "{tasks:?}");
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

    /// The shape of a real .NET repository, and the reason this rule exists: a
    /// `Dockerfile` at the top said how to package the project, the solutions
    /// lived a level down, and the Dockerfile alone used to make the member
    /// scan look unnecessary — leaving `docker build` as the only task in a
    /// repository with two solutions in it.
    #[test]
    fn a_dockerfile_at_the_top_does_not_hide_the_projects_under_it() {
        let root = project("packaged");
        std::fs::write(root.join("Dockerfile"), "FROM scratch\n").expect("dockerfile");
        std::fs::write(root.join("global.json"), r#"{"sdk":{"version":"9.0.100"}}"#).expect("sdk pin");
        for (folder, solution) in [("src", "Shop.sln"), ("control-plane", "ControlPlane.sln")] {
            std::fs::create_dir_all(root.join(folder)).expect("member folder");
            std::fs::write(
                root.join(folder).join(solution),
                "Microsoft Visual Studio Solution File",
            )
            .expect("solution");
        }

        let tasks = detect_tasks_in(&root);
        let ids: Vec<&str> = tasks.iter().map(|task| task.id.as_str()).collect();

        assert!(
            ids.contains(&"src/dotnet.build") && ids.contains(&"control-plane/dotnet.build"),
            "both solutions must be buildable, got {ids:?}"
        );
        // No Run: `dotnet run` refuses a solution, and which of a solution's
        // projects to start is what the AI discovery answers (`ai_tasks`).
        assert!(
            !ids.iter().any(|id| id.ends_with("dotnet.run")),
            "a solution must not be offered a Run that cannot work: {ids:?}"
        );
        assert!(
            ids.contains(&"docker.build"),
            "the root's own packaging task is still worth offering: {ids:?}"
        );
        let build = tasks
            .iter()
            .find(|task| task.id == "src/dotnet.build")
            .expect("src build");
        assert_eq!(build.cwd.as_deref(), Some("src"));
        assert_eq!(build.command, "dotnet build \"Shop.sln\"");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The half of the same rule that must not regress: a root that really is
    /// the project keeps answering alone, members or no members.
    #[test]
    fn a_root_that_builds_its_own_source_answers_alone() {
        let root = project("real-root");
        std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"x\"\n").expect("cargo");
        std::fs::write(root.join("Dockerfile"), "FROM scratch\n").expect("dockerfile");
        std::fs::create_dir_all(root.join("web")).expect("member folder");
        std::fs::write(
            root.join("web").join("package.json"),
            r#"{"scripts":{"dev":"vite"}}"#,
        )
        .expect("manifest");

        let ids: Vec<String> = detect_tasks_in(&root).into_iter().map(|task| task.id).collect();

        assert!(ids.contains(&"cargo.build".to_string()), "{ids:?}");
        assert!(
            !ids.iter().any(|id| id.starts_with("web/")),
            "a project's own tasks must not be buried under a member's: {ids:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dotnet_project_runs_but_a_solution_only_builds() {
        let project = detect_from(&FolderFacts {
            dotnet_project: Some("App.csproj".into()),
            ..FolderFacts::default()
        });
        assert_eq!(
            project.iter().map(|t| t.kind).collect::<Vec<TaskKind>>(),
            vec![TaskKind::Run, TaskKind::Build, TaskKind::Test, TaskKind::Publish]
        );
        assert_eq!(
            command_of(&project, "dotnet.run"),
            "dotnet run --project \"App.csproj\""
        );

        // Measured, not assumed: `dotnet run --project` refuses both solution
        // formats, so offering a Run for one would offer a broken command.
        for solution in ["App.sln", "App.slnx"] {
            let tasks = detect_from(&FolderFacts {
                dotnet_project: Some(solution.into()),
                ..FolderFacts::default()
            });
            assert_eq!(
                tasks.iter().map(|t| t.kind).collect::<Vec<TaskKind>>(),
                vec![TaskKind::Build, TaskKind::Test, TaskKind::Publish],
                "{solution} must not be offered a Run"
            );
            assert_eq!(
                command_of(&tasks, "dotnet.build"),
                format!("dotnet build \"{solution}\"")
            );
        }
    }

    /// The format `dotnet new sln` produces on a current SDK. Missing it left
    /// every freshly created solution with no tasks whatsoever.
    #[test]
    fn a_slnx_solution_is_found_the_same_as_a_sln() {
        let root = project("slnx");
        std::fs::write(root.join("Shop.slnx"), "<Solution />").expect("solution");

        let ids: Vec<String> = detect_tasks_in(&root).into_iter().map(|task| task.id).collect();

        assert!(ids.contains(&"dotnet.build".to_string()), "{ids:?}");
        let _ = std::fs::remove_dir_all(&root);
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
        // Three per stack, plus the two checks cargo ships with.
        assert_eq!(tasks.len(), 8, "{tasks:?}");
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
    fn the_program_of_a_command_is_its_first_word_unquoted() {
        assert_eq!(program_of("mvn -q package").as_deref(), Some("mvn"));
        assert_eq!(
            program_of("\"C:\\Program Files\\x\\g.exe\" build").as_deref(),
            Some("C:\\Program Files\\x\\g.exe")
        );
        // Not something a first word can answer for, so it says so.
        assert_eq!(program_of("").as_deref(), None);
        assert_eq!(program_of("FOO=1 make all").as_deref(), None);
        assert_eq!(program_of("| tee log").as_deref(), None);
    }

    /// The gate the AI's answers pass through, against this machine: `git` is
    /// here wherever this repository is, and a made-up tool is not.
    #[test]
    fn a_proposed_command_is_checked_for_its_tool_and_its_folder() {
        let root = project("checks");
        std::fs::create_dir_all(root.join("api")).expect("member folder");

        let checks = check_task_commands(
            root.to_string_lossy().to_string(),
            vec![
                "git status".into(),
                "aime-no-such-build-tool package".into(),
                "git status".into(),
            ],
            vec!["api".into(), ".".into(), "nowhere".into()],
        );

        assert_eq!(checks.len(), 3);
        assert!(
            checks[0].program_found && checks[0].folder_found,
            "an installed tool in a folder that exists: {:?}",
            checks[0]
        );
        assert!(!checks[1].program_found, "a tool nobody has must not pass");
        assert!(!checks[2].folder_found, "a folder the repo lacks must not pass");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A learned task has to survive a restart, and must not cost the user the
    /// entries they wrote by hand.
    #[test]
    fn saving_a_learned_task_keeps_the_users_own_and_replaces_by_id() {
        let root = project("saved");
        let mine = TaskDef::new("mine", "my script", TaskKind::Run, "./go.sh".into());
        let path = root.to_string_lossy().to_string();
        save_tasks(path.clone(), vec![mine]).expect("first save");
        save_tasks(
            path.clone(),
            vec![TaskDef::new(
                "ai.build.root",
                "mvn package",
                TaskKind::Build,
                "mvn -q package".into(),
            )],
        )
        .expect("second save");
        // The same id again: replaced, not duplicated.
        save_tasks(
            path.clone(),
            vec![TaskDef::new(
                "ai.build.root",
                "mvn verify",
                TaskKind::Build,
                "mvn -q verify".into(),
            )],
        )
        .expect("third save");

        let tasks = detect_tasks_in(&root);
        let ids: Vec<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(
            ids.iter().filter(|id| **id == "ai.build.root").count(),
            1,
            "{ids:?}"
        );
        assert!(ids.contains(&"mine"), "the user's own task was lost: {ids:?}");
        assert_eq!(command_of(&tasks, "ai.build.root"), "mvn -q verify");
        assert!(
            root.join(".aime").join(".gitignore").is_file(),
            "a learned task must not turn up in the user's commits"
        );
        assert!(
            task_profile_exists(path),
            "without the marker every launch pays for the same reading again"
        );
        let _ = std::fs::remove_dir_all(&root);
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
