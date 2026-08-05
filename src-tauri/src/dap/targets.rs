//! What in this project can be debugged.
//!
//! F5 must run the project's program, not whichever file happens to be focused.
//! Opening `utils.ts` and pressing F5 runs a module with no entry point and
//! looks like nothing happened; for Go it is worse than looking wrong —
//! `dlv debug main.go` on a package of several files does not compile at all
//! ("undefined: greet", measured), so the file in front of the user is the one
//! thing delve cannot be handed.
//!
//! Detection lists **candidates** and does not pick one. A repository with a Go
//! service and a Node front end has two right answers, and an editor is not
//! entitled to guess silently between them: the panel names what will run and
//! lets the user change it, the choice is remembered per project, and when the
//! answer is genuinely ambiguous that is where an agent belongs — it reads the
//! repository the way a person would, which no rule in this file can.
//!
//! Everything here is derived from the project's own manifests, which costs
//! nothing and answers instantly for the overwhelming majority of projects.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One program in this project a debugger can be pointed at.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugTarget {
    /// Stable across runs, so a remembered choice survives a restart.
    pub id: String,
    /// The program's path relative to the root — the clearest label there is,
    /// and the one thing that cannot be ambiguous between two candidates.
    pub label: String,
    pub language_id: String,
    /// What the adapter is pointed at: a file, a Go package directory, or the
    /// .NET project that has to be built first. Absolute.
    pub program: String,
    /// The directory the program should run in.
    pub cwd: String,
}

/// Directories a project's own programs are never found in. `IGNORED_DIRS`
/// covers the build output and `node_modules`; these are the ones a scan for
/// entry points adds — vendored copies of other people's programs, fixtures,
/// and virtual environments full of installed packages.
const SKIPPED_DIRS: &[&str] = &["vendor", "testdata", "venv", "site-packages", "Pods"];

/// How deep a project's own entry points are worth looking for. `cmd/api/main.go`
/// and `services/api/src/index.js` both fit; anything deeper is somebody else's
/// tree that escaped the skip list.
const MAX_DEPTH: usize = 4;

/// A picker is a choice, not a directory listing: past this many candidates the
/// list has stopped being useful, and an agent is the better answer anyway.
const MAX_TARGETS: usize = 20;

/// Files that mean "this directory is a Python project", for deciding where a
/// Python program should run: modules resolve from the working directory, so
/// running `services/api/main.py` from the repository root breaks its imports.
const PYTHON_PROJECT_FILES: &[&str] = &["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"];

/// Python entry points by convention, most specific first.
const PYTHON_ENTRIES: &[&str] = &["manage.py", "main.py", "app.py", "__main__.py"];

/// Where a Node package keeps its entry point when the manifest does not say.
const NODE_ENTRIES: &[&str] = &[
    "index.js",
    "index.mjs",
    "index.cjs",
    "src/index.js",
    "src/index.mjs",
    "main.js",
    "src/main.js",
    "server.js",
    "src/server.js",
    "app.js",
    "src/app.js",
];

/// js-debug runs JavaScript. A TypeScript entry needs either a build step or a
/// loader, and which of the two this project uses is exactly the question a
/// rule cannot answer — so TypeScript projects fall back to the open file until
/// an agent resolves it.
fn is_javascript(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("js" | "mjs" | "cjs")
    )
}

/// Whether a Go source file declares the entry package.
///
/// Matched on the declaration itself rather than on the file being called
/// `main.go`: the entry package is regularly split across files, and a package
/// called `mainly` is not it.
fn declares_main_package(source: &str) -> bool {
    source.lines().any(|line| {
        line.trim_start()
            .strip_prefix("package main")
            // What follows is nothing, or a comment: `package mainly` is a
            // different package, `package main // entry` is this one.
            .map(str::trim)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with("//"))
    })
}

/// Whether a .NET project builds something that can be run.
///
/// A class library builds an assembly too, and offering it as a debug target
/// ends in "the build produced no assembly to debug". `OutputType` says so
/// outright; web and worker projects are executables without declaring it.
fn is_dotnet_executable(project_file: &str) -> bool {
    let lowered = project_file.to_lowercase();
    lowered.contains("<outputtype>exe</outputtype>")
        || lowered.contains("microsoft.net.sdk.web")
        || lowered.contains("microsoft.net.sdk.worker")
}

/// The entry file a `package.json` declares, if it declares a usable one.
///
/// `main` is the documented answer; `bin` is what a command-line package has
/// instead. A manifest that says neither is not broken — the conventional file
/// names are tried next.
fn manifest_entry(manifest: &serde_json::Value) -> Option<String> {
    let main = manifest.get("main").and_then(|value| value.as_str());
    let bin = manifest.get("bin").and_then(|value| match value {
        serde_json::Value::String(path) => Some(path.as_str()),
        // A map of command names; serde_json orders its keys, so the same
        // manifest always yields the same target.
        serde_json::Value::Object(map) => map.values().find_map(|entry| entry.as_str()),
        _ => None,
    });
    main.or(bin).map(str::to_string)
}

/// Slash-separated path relative to the root, or the root's own folder name.
fn label_of(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        root.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())
    } else {
        text
    }
}

/// The nearest enclosing directory that looks like a Python project, so a
/// program's imports resolve the way they do when it is run by hand.
fn python_working_dir(root: &Path, entry: &Path) -> PathBuf {
    let mut dir = entry.parent().unwrap_or(root);
    loop {
        if PYTHON_PROJECT_FILES.iter().any(|name| dir.join(name).is_file()) {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(parent) if dir != root => dir = parent,
            _ => return root.to_path_buf(),
        }
    }
}

/// One directory's contents, read once and matched against every rule.
struct DirEntries {
    dirs: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

fn read_dir(dir: &Path) -> DirEntries {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                dirs.push(path);
            } else {
                files.push(path);
            }
        }
    }
    dirs.sort();
    files.sort();
    DirEntries { dirs, files }
}

fn is_scannable(dir: &Path) -> bool {
    let Some(name) = dir.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    // A dotted directory is tooling, not a program: `.git`, `.venv`, `.aime`.
    !name.starts_with('.') && !crate::fs_cmds::IGNORED_DIRS.contains(&name) && !SKIPPED_DIRS.contains(&name)
}

fn target(language_id: &str, root: &Path, program: &Path, cwd: &Path) -> DebugTarget {
    let label = label_of(root, program);
    DebugTarget {
        id: format!("{language_id}:{label}"),
        label,
        language_id: language_id.to_string(),
        program: program.to_string_lossy().to_string(),
        cwd: cwd.to_string_lossy().to_string(),
    }
}

/// Every candidate one directory holds. Go looks at the directory itself
/// because that is what delve compiles; the others name a file.
fn targets_in(root: &Path, dir: &Path, entries: &DirEntries, found: &mut Vec<DebugTarget>) {
    let go_sources = entries.files.iter().filter(|file| {
        file.extension().and_then(|ext| ext.to_str()) == Some("go")
            // Test files declare `package main` in some projects and are not
            // programs; delve builds them into the package regardless.
            && !file.to_string_lossy().ends_with("_test.go")
    });
    if go_sources.clone().any(|file| {
        std::fs::read_to_string(file)
            .map(|source| declares_main_package(&source))
            .unwrap_or(false)
    }) {
        found.push(target("go", root, dir, dir));
    }

    if let Some(manifest_path) = entries.files.iter().find(|file| file.ends_with("package.json")) {
        if let Some(entry) = node_entry(manifest_path) {
            found.push(target("javascript", root, &entry, dir));
        }
    }

    for name in PYTHON_ENTRIES {
        let entry = dir.join(name);
        if entries.files.contains(&entry) {
            let cwd = python_working_dir(root, &entry);
            found.push(target("python", root, &entry, &cwd));
            // One entry point per directory: `main.py` next to `app.py` is one
            // program with a helper, not two programs.
            break;
        }
    }

    for project_file in entries.files.iter().filter(|file| {
        matches!(
            file.extension().and_then(|ext| ext.to_str()),
            Some("csproj" | "fsproj")
        )
    }) {
        let Ok(text) = std::fs::read_to_string(project_file) else {
            continue;
        };
        if is_dotnet_executable(&text) {
            found.push(target("csharp", root, project_file, dir));
        }
    }
}

/// The file a Node package runs, from its manifest or by convention.
fn node_entry(manifest_path: &Path) -> Option<PathBuf> {
    let dir = manifest_path.parent()?;
    let declared = std::fs::read_to_string(manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .as_ref()
        .and_then(manifest_entry)
        .map(|entry| dir.join(entry));

    if let Some(entry) = declared {
        if entry.is_file() && is_javascript(&entry) {
            return Some(entry);
        }
    }
    NODE_ENTRIES
        .iter()
        .map(|name| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Walks the project once, breadth first, and collects every candidate.
pub fn detect_targets(root: &Path) -> Vec<DebugTarget> {
    let mut found: Vec<DebugTarget> = Vec::new();
    let mut level = vec![root.to_path_buf()];

    for _ in 0..MAX_DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let entries = read_dir(dir);
            targets_in(root, dir, &entries, &mut found);
            if found.len() >= MAX_TARGETS {
                found.truncate(MAX_TARGETS);
                return found;
            }
            next.extend(entries.dirs.into_iter().filter(|dir| is_scannable(dir)));
        }
        if next.is_empty() {
            break;
        }
        level = next;
    }
    found
}

/// The programs this project can debug, shallowest first — the outermost
/// program is the one a project is usually about.
#[tauri::command]
pub fn dap_targets(root: String) -> Vec<DebugTarget> {
    detect_targets(Path::new(&root))
}

#[cfg(test)]
mod tests {
    use super::{declares_main_package, detect_targets, is_dotnet_executable, DebugTarget};
    use std::path::{Path, PathBuf};

    /// A fresh project folder; the name keeps concurrent tests apart.
    fn project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aime-targets-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp project");
        root
    }

    fn write(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent folder");
        }
        std::fs::write(path, contents).expect("write fixture");
    }

    fn labels(targets: &[DebugTarget]) -> Vec<&str> {
        targets.iter().map(|t| t.label.as_str()).collect()
    }

    /// A program at the root is labelled by the folder it is in.
    fn folder_name(root: &Path) -> String {
        root.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .expect("temp folder has a name")
    }

    const GO_MAIN: &str = "package main\n\nfunc main() {}\n";

    #[test]
    fn a_go_package_is_offered_as_a_directory_because_that_is_what_delve_compiles() {
        let root = project("go-package");
        write(&root, "go.mod", "module demo\n");
        write(&root, "main.go", GO_MAIN);
        write(
            &root,
            "helper.go",
            "package main\n\nfunc greet() string { return \"hi\" }\n",
        );

        let targets = detect_targets(&root);
        assert_eq!(targets.len(), 1, "one package, one target: {targets:?}");
        assert_eq!(targets[0].language_id, "go");
        // Measured: pointing delve at main.go alone fails to compile the
        // package, so the directory is the only thing that can be launched.
        assert_eq!(targets[0].program, root.to_string_lossy());
        assert_eq!(targets[0].label, folder_name(&root));
    }

    #[test]
    fn a_go_repository_offers_every_command_it_builds() {
        let root = project("go-cmds");
        write(&root, "go.mod", "module demo\n");
        write(&root, "cmd/api/main.go", GO_MAIN);
        write(&root, "cmd/worker/main.go", GO_MAIN);
        // A library package is not a program and must not be offered.
        write(&root, "internal/store/store.go", "package store\n");

        assert_eq!(labels(&detect_targets(&root)), ["cmd/api", "cmd/worker"]);
    }

    #[test]
    fn a_node_package_follows_its_manifest_and_then_convention() {
        let declared = project("node-main");
        write(
            &declared,
            "package.json",
            r#"{"name":"demo","main":"lib/server.js"}"#,
        );
        write(&declared, "lib/server.js", "console.log(1);\n");
        write(&declared, "index.js", "console.log(2);\n");
        assert_eq!(labels(&detect_targets(&declared)), ["lib/server.js"]);

        let conventional = project("node-index");
        write(&conventional, "package.json", r#"{"name":"demo"}"#);
        write(&conventional, "src/index.js", "console.log(1);\n");
        assert_eq!(labels(&detect_targets(&conventional)), ["src/index.js"]);
    }

    /// js-debug launches JavaScript; a `.ts` entry needs a build or a loader,
    /// and guessing which would start a session that dies on the first line.
    #[test]
    fn a_typescript_entry_is_not_offered_as_if_node_could_run_it() {
        let root = project("node-ts");
        write(&root, "package.json", r#"{"name":"demo","main":"src/index.ts"}"#);
        write(&root, "src/index.ts", "export const x = 1;\n");

        assert!(
            detect_targets(&root).is_empty(),
            "TypeScript is left to the open file"
        );
    }

    #[test]
    fn a_python_program_runs_from_the_folder_its_imports_resolve_against() {
        let root = project("python-mono");
        write(
            &root,
            "services/api/pyproject.toml",
            "[project]\nname = \"api\"\n",
        );
        write(&root, "services/api/main.py", "print(1)\n");

        let targets = detect_targets(&root);
        assert_eq!(labels(&targets), ["services/api/main.py"]);
        // Not the repository root: `import api` only resolves from the project.
        assert_eq!(
            targets[0].cwd,
            root.join("services").join("api").to_string_lossy()
        );
    }

    #[test]
    fn a_class_library_is_not_offered_but_the_app_next_to_it_is() {
        let root = project("dotnet-sln");
        write(&root, "Demo.sln", "Microsoft Visual Studio Solution File\n");
        write(
            &root,
            "src/Api/Api.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>",
        );
        write(
            &root,
            "src/Core/Core.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>",
        );

        assert_eq!(labels(&detect_targets(&root)), ["src/Api/Api.csproj"]);
    }

    #[test]
    fn a_repository_of_two_languages_offers_both_rather_than_choosing() {
        let root = project("mixed");
        write(&root, "go.mod", "module demo\n");
        write(&root, "cmd/api/main.go", GO_MAIN);
        write(&root, "web/package.json", r#"{"name":"web","main":"index.js"}"#);
        write(&root, "web/index.js", "console.log(1);\n");

        // Shallowest first (`web` sits one level below the root, `cmd/api` two),
        // and every candidate present: this is exactly the case where the editor
        // must ask - or have an agent decide - instead of guessing silently.
        assert_eq!(labels(&detect_targets(&root)), ["web/index.js", "cmd/api"]);
    }

    #[test]
    fn vendored_and_installed_code_is_not_this_project_s_program() {
        let root = project("noise");
        write(&root, "go.mod", "module demo\n");
        write(&root, "main.go", GO_MAIN);
        write(&root, "vendor/other/main.go", GO_MAIN);
        write(&root, "node_modules/dep/package.json", r#"{"main":"index.js"}"#);
        write(&root, "node_modules/dep/index.js", "1;\n");
        write(&root, ".venv/Scripts/main.py", "print(1)\n");

        assert_eq!(labels(&detect_targets(&root)), [folder_name(&root)]);
    }

    #[test]
    fn the_entry_package_is_recognized_by_its_declaration_not_by_a_file_name() {
        assert!(declares_main_package("package main\n"));
        assert!(declares_main_package("// a comment\n\npackage main // entry\n"));
        assert!(!declares_main_package("package mainly\n"));
        assert!(!declares_main_package("package store\n"));
    }

    #[test]
    fn a_dotnet_project_is_an_app_when_it_says_so_or_when_its_sdk_says_so() {
        assert!(is_dotnet_executable("<OutputType>Exe</OutputType>"));
        assert!(is_dotnet_executable("<Project Sdk=\"Microsoft.NET.Sdk.Worker\">"));
        assert!(!is_dotnet_executable("<Project Sdk=\"Microsoft.NET.Sdk\">"));
    }
}
