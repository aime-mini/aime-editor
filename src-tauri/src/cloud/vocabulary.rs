//! A cloud CLI's own list of its commands, for the AI to write commands from.
//!
//! Why this exists. A model asked for a command answers from what it remembers
//! of a CLI, and what it remembers can be a command that was never there:
//! measured in the app on a Supabase database, three operations under a
//! `postgres` group that CLI does not have. The checker refuses such a command,
//! but only after a whole AI turn was spent writing it.
//!
//! Where it comes from. Every CLI ships the list in a form of its own
//! (`Vocabulary`), and each is read the cheapest way it offers:
//! - Supabase writes its whole tree for a shell to complete against,
//!   `--completions bash` (`completions.rs`).
//! - gcloud ships it as a static completion tree inside the SDK,
//!   `data/cli/gcloud_completions.py`: one assignment of a JSON object, 17,155
//!   commands under 142 groups on Cloud SDK 583.0.0.
//! - aws ships `aws_completer` beside its binary, answering one level per call
//!   from the CLI's own index: 391 services, then one service's operations in
//!   0.35 s on aws-cli 2.17.31 - customisations such as `cloudformation
//!   deploy` included, which the botocore models do not have.
//! - az ships no such file, and its help answers one level per call at about
//!   2 s each. Its own Python loads the whole command table in one call -
//!   6,269 commands in 11.5 s on 2.90.0 - so that answer is kept on disk per
//!   az version. Where the interpreter cannot be found, the top level still
//!   comes from `commandIndex.json`, which az writes into its config folder on
//!   every platform.
//!
//! How much of it. 17,155 commands do not belong in a prompt, so the caller
//! names the groups it needs: the answer is every top-level group plus every
//! command under the named ones. Supabase's tree is small enough to go whole.
//! What Aime already refuses is left out rather than offered and then thrown
//! away - the same rules the prompt states in words, applied to the list.

use super::dialect::{Dialect, Vocabulary};
use crate::program::Program;
use crate::providers::cli_command;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long `aws_completer` may take over one level; it answers in a third of a second.
const COMPLETER_LIMIT: Duration = Duration::from_secs(20);
/// How long az's Python may take to load its command table; it took 11.5 s.
const COMMAND_TABLE_LIMIT: Duration = Duration::from_secs(180);
/// Deeper than any of these CLIs goes - `gcloud alpha compute instances ...` is five.
const MAX_DEPTH: usize = 8;
/// Where the command tables read from a CLI's own Python are kept, per version.
const CACHE_DIR: &str = "cloud-cli-vocabulary";

/// Loads az's command table with az's own Python and prints every command, as
/// JSON. The invocation is set up first because some command modules (storage,
/// measured on 2.90.0) read it while their commands are loaded, and fail
/// without it.
const AZ_COMMAND_TABLE: &str = "\
import json
from azure.cli.core import get_default_cli
cli = get_default_cli()
cli.invocation = cli.invocation_cls(cli_ctx=cli, parser_cls=cli.parser_cls, \
commands_loader_cls=cli.commands_loader_cls, help_cls=cli.help_cls)
loader = cli.invocation.commands_loader
loader.load_command_table(None)
print(json.dumps(sorted(loader.command_table)))
";

/// Every top-level command group the CLI has, plus every command under the
/// `groups` asked for - each spelled as it is typed (`run deploy`,
/// `cloudformation deploy`). `None` when the CLI publishes no list this machine
/// can read, and the prompt then says nothing about one.
#[tauri::command]
pub async fn cloud_cli_commands(
    app: AppHandle,
    cloud_id: String,
    groups: Vec<String>,
) -> Option<Vec<String>> {
    let dialect = Dialect::of(&cloud_id)?;
    let program = super::program_for(&app, &cloud_id);
    let commands = match dialect.vocabulary {
        Vocabulary::Completions => completions_tree(dialect, &program).await,
        Vocabulary::StaticTree => static_tree(&program, &groups).await,
        Vocabulary::Completer => completer_tree(dialect, &program, &groups).await,
        Vocabulary::CommandTable => command_table_tree(&app, &program, &groups).await,
    }?;
    let offered = distinct(
        commands
            .into_iter()
            .filter(|command| !refused_by(dialect, command)),
    );
    (!offered.is_empty()).then_some(offered)
}

/// The whole tree a CLI writes for a shell; its top level from `--help` where
/// it stops offering completions.
async fn completions_tree(dialect: &Dialect, program: &str) -> Option<Vec<String>> {
    let root = format!("_{}", dialect.program);
    let commands = match super::read_cli_checked(program, &["--completions", "bash"]).await {
        Ok(script) => super::completions::commands_in(&script, &root),
        Err(_) => Vec::new(),
    };
    if !commands.is_empty() {
        return Some(commands);
    }
    let help = super::read_cli_checked(program, &["--help"]).await.ok()?;
    Some(super::reads::subcommands_in(&help))
}

/// The static completion tree a Cloud SDK ships, scoped to `groups`.
async fn static_tree(program: &str, groups: &[String]) -> Option<Vec<String>> {
    let file = installed_at(program)?
        .parent()?
        .parent()?
        .join("data")
        .join("cli")
        .join("gcloud_completions.py");
    let groups = groups.to_vec();
    tokio::task::spawn_blocking(move || {
        let text = std::fs::read_to_string(&file).ok()?;
        // One assignment, `STATIC_COMPLETION_CLI_TREE = {...}`, whose value is JSON.
        let tree: Value = serde_json::from_str(&text[text.find('{')?..]).ok()?;
        Some(scoped_tree(&tree, &groups))
    })
    .await
    .ok()?
}

/// Every top-level group of a completion tree, and every command under the
/// named ones. A tree is `{"commands": {word: tree}}` all the way down.
fn scoped_tree(tree: &Value, groups: &[String]) -> Vec<String> {
    let Some(top) = tree.get("commands").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut commands: Vec<String> = top.keys().cloned().collect();
    for group in groups {
        if let Some(node) = top.get(group) {
            leaves(node, group, 1, &mut commands);
        }
    }
    commands
}

/// The commands that run under one node: its leaves, each by its full path.
fn leaves(node: &Value, path: &str, depth: usize, commands: &mut Vec<String>) {
    let children = node.get("commands").and_then(Value::as_object);
    match children {
        // A tree read off disk is input: the depth bound keeps a malformed one
        // from recursing until the stack runs out.
        Some(children) if !children.is_empty() && depth < MAX_DEPTH => {
            for (word, child) in children {
                leaves(child, &format!("{path} {word}"), depth + 1, commands);
            }
        }
        _ => commands.push(path.to_string()),
    }
}

/// The services `aws_completer` lists, and the operations of each named one.
async fn completer_tree(dialect: &Dialect, program: &str, groups: &[String]) -> Option<Vec<String>> {
    let completer = completer_beside(program)?;
    let services = completions_after(&completer, dialect.program).await?;
    let mut commands = services.clone();
    for group in groups.iter().filter(|group| services.contains(group)) {
        let typed = format!("{} {group}", dialect.program);
        match completions_after(&completer, &typed).await {
            Some(operations) => commands.extend(operations.iter().map(|op| format!("{group} {op}"))),
            None => eprintln!("[cloud] aws_completer did not list the operations of `{group}`"),
        }
    }
    Some(commands)
}

/// `aws_completer`, which every AWS CLI v2 installer puts beside `aws`.
fn completer_beside(program: &str) -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "aws_completer.exe"
    } else {
        "aws_completer"
    };
    let completer = installed_at(program)?.with_file_name(name);
    completer.is_file().then_some(completer)
}

/// What a completer offers after `line` and a space, the way a shell asks it:
/// the words of the next level, flags left out.
async fn completions_after(completer: &Path, line: &str) -> Option<Vec<String>> {
    let typed = format!("{line} ");
    let mut cmd = cli_command(&completer.to_string_lossy(), std::iter::empty::<&str>());
    cmd.env("COMP_LINE", &typed)
        .env("COMP_POINT", typed.len().to_string());
    let answer = super::output_checked_within("aws_completer", cmd, COMPLETER_LIMIT)
        .await
        .ok()?;
    Some(
        answer
            .lines()
            .map(str::trim)
            .filter(|word| !word.is_empty() && !word.starts_with('-'))
            .map(str::to_string)
            .collect(),
    )
}

/// az's command table, scoped to `groups`: from the copy kept for this az
/// version, else from az's own Python, else - top level only - from the
/// command index az keeps in its config folder.
async fn command_table_tree(app: &AppHandle, program: &str, groups: &[String]) -> Option<Vec<String>> {
    let config = az_config_dir();
    // The top level alone is in the index: no reason to load the whole table for it.
    if groups.is_empty() {
        if let Some(top) = config.as_deref().and_then(az_index_groups) {
            return Some(top);
        }
    }
    let version = config.as_deref().and_then(az_version);
    let cache = match (app.path().app_data_dir(), &version) {
        (Ok(data), Some(version)) => Some(data.join(CACHE_DIR).join(format!("az-{version}.json"))),
        _ => None,
    };
    if let Some(table) = cache.as_deref().and_then(read_table) {
        return Some(scoped_list(&table, groups));
    }
    if let Some(table) = load_command_table(program).await {
        if let Some(cache) = &cache {
            keep_table(cache, &table);
        }
        return Some(scoped_list(&table, groups));
    }
    config.as_deref().and_then(az_index_groups)
}

/// Every command az has, as its own Python loads them.
async fn load_command_table(program: &str) -> Option<Vec<String>> {
    let Some(python) = az_interpreter(program) else {
        eprintln!("[cloud] az's Python could not be found beside `{program}`; only its top level is offered");
        return None;
    };
    let mut cmd = cli_command(&python.to_string_lossy(), ["-IB", "-c", AZ_COMMAND_TABLE]);
    super::quiet(&mut cmd);
    match super::output_checked_within("az command table", cmd, COMMAND_TABLE_LIMIT).await {
        Ok(answer) => answer
            .lines()
            .find(|line| line.starts_with('['))
            .and_then(|line| serde_json::from_str(line).ok()),
        Err(failure) => {
            eprintln!(
                "[cloud] az's command table could not be loaded: {}",
                failure.message
            );
            None
        }
    }
}

/// The interpreter az's launcher starts `azure.cli` with.
fn az_interpreter(program: &str) -> Option<PathBuf> {
    let launcher = installed_at(program)?;
    let text = std::fs::read_to_string(&launcher).ok()?;
    let line = text.lines().find(|line| line.contains("m azure.cli"))?;
    let python = interpreter_in(line, launcher.parent()?)?;
    python.is_file().then_some(python)
}

/// The interpreter on a launcher line: the word before the `-…m azure.cli`
/// flag, with the launcher's own folder put in for the variable that names it.
/// The two installers' lines, as they ship:
/// - Windows MSI, `wbin\az.cmd`: `"%~dp0\..\python.exe" -IBm azure.cli %*`
/// - Debian package, `/usr/bin/az`:
///   `AZ_INSTALLER=DEB "$bin_dir"/../../opt/az/bin/python3 -Im azure.cli "$@"`
fn interpreter_in(line: &str, folder: &Path) -> Option<PathBuf> {
    let head = &line[..line.find("m azure.cli")?];
    let before_flag = &head[..head.rfind(" -")?];
    let word = last_word(before_flag)?;
    let folder = folder.to_string_lossy();
    // `%~dp0` is cmd.exe's own spelling, and it ends in a backslash.
    let spelled = word
        .replace("%~dp0", &format!("{folder}\\"))
        .replace("${bin_dir}", &folder)
        .replace("$bin_dir", &folder);
    let path = PathBuf::from(spelled);
    Some(if path.is_absolute() {
        path
    } else {
        Path::new(folder.as_ref()).join(path)
    })
}

/// The last shell word of a line, quotes taken off: `"$bin_dir"/../x` is one word.
fn last_word(line: &str) -> Option<String> {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in line.chars() {
        match ch {
            '"' => quoted = !quoted,
            ch if ch.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            ch => current.push(ch),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words.pop()
}

/// Where az keeps its configuration: `AZURE_CONFIG_DIR`, else `.azure` at home.
fn az_config_dir() -> Option<PathBuf> {
    std::env::var_os("AZURE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::home::home_dir().map(|home| home.join(".azure")))
}

/// The command index az writes for itself, as JSON.
fn az_index(config: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(config.join("commandIndex.json")).ok()?;
    // Written by Python with a byte-order mark (measured on 2.90.0).
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// The az version the command index was written by.
fn az_version(config: &Path) -> Option<String> {
    let version = az_index(config)?.get("version")?.as_str()?.to_string();
    // It names a file: nothing but a plain version gets through.
    version
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.')
        .then_some(version)
}

/// az's top-level groups, from its command index.
fn az_index_groups(config: &Path) -> Option<Vec<String>> {
    let index = az_index(config)?;
    let groups: Vec<String> = index.get("commandIndex")?.as_object()?.keys().cloned().collect();
    (!groups.is_empty()).then_some(groups)
}

fn read_table(path: &Path) -> Option<Vec<String>> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Keeps a command table for the next deploy. Failing to keep it costs the next
/// deploy eleven seconds and nothing else, so it is said and not raised.
fn keep_table(path: &Path, table: &[String]) {
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(path, serde_json::to_string(table).unwrap_or_default()));
    if let Err(error) = written {
        eprintln!(
            "[cloud] az's command table could not be kept at {}: {error}",
            path.display()
        );
    }
}

/// Every top-level group of a flat list of commands, and every command under
/// the named ones.
fn scoped_list(table: &[String], groups: &[String]) -> Vec<String> {
    let top = table
        .iter()
        .filter_map(|command| command.split(' ').next())
        .map(str::to_string);
    let under = table.iter().filter(|command| {
        command
            .split_once(' ')
            .is_some_and(|(group, _)| groups.iter().any(|named| named == group))
    });
    top.chain(under.cloned()).collect()
}

/// Where a program really is, links followed: a Cloud SDK, an AWS CLI and az
/// are all reached through links on macOS and Linux, and what sits beside them
/// is found from where they point.
fn installed_at(program: &str) -> Option<PathBuf> {
    let resolved = Program::resolve(program);
    if !resolved.exists() {
        return None;
    }
    dunce::canonicalize(resolved.path()).ok()
}

/// The commands in the order first seen, each once.
fn distinct(commands: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    commands.filter(|command| seen.insert(command.clone())).collect()
}

/// Whether Aime's own rules would throw this command away on sight.
fn refused_by(dialect: &Dialect, command: &str) -> bool {
    let mut words = command.split(' ');
    let Some(group) = words.next() else {
        return true;
    };
    if dialect.refused_groups.contains(&group) {
        return true;
    }
    let rest = words.next().unwrap_or_default();
    dialect
        .refused_commands
        .iter()
        .any(|refused| refused.group == group && refused.command == rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `functions` group of `gcloud_completions.py`, Cloud SDK 583.0.0,
    /// with its flags left out.
    const FUNCTIONS: &str = r#"{"commands":{"add-iam-policy-binding":{"commands":{}},"add-invoker-policy-binding":{"commands":{}},"call":{"commands":{}},"delete":{"commands":{}},"deploy":{"commands":{}},"describe":{"commands":{}},"detach":{"commands":{}},"event-types":{"commands":{"list":{"commands":{}}}},"get-iam-policy":{"commands":{}},"list":{"commands":{}},"logs":{"commands":{"read":{"commands":{}}}},"regions":{"commands":{"list":{"commands":{}}}},"remove-iam-policy-binding":{"commands":{}},"remove-invoker-policy-binding":{"commands":{}},"runtimes":{"commands":{"list":{"commands":{}}}},"set-iam-policy":{"commands":{}},"upgrade":{"commands":{}}}}"#;

    fn sdk_tree() -> Value {
        let functions: Value = serde_json::from_str(FUNCTIONS).expect("the fixture is JSON");
        serde_json::json!({"commands": {"functions": functions, "run": {"commands": {"deploy": {"commands": {}}}}}})
    }

    #[test]
    fn a_static_tree_gives_every_group_and_the_commands_under_the_named_ones() {
        let commands = scoped_tree(&sdk_tree(), &["functions".to_string()]);
        assert_eq!(&commands[..2], ["functions", "run"]);
        assert!(commands.contains(&"functions deploy".to_string()));
        assert!(commands.contains(&"functions logs read".to_string()));
        // A group is a path to its commands, not one of them.
        assert!(!commands.contains(&"functions logs".to_string()));
        // An unnamed group stays one word.
        assert!(!commands.iter().any(|command| command.starts_with("run ")));
        assert_eq!(commands.len(), 2 + 17);
    }

    #[test]
    fn a_flat_table_is_scoped_the_same_way() {
        let table: Vec<String> = [
            "containerapp up",
            "containerapp env create",
            "group create",
            "webapp up",
        ]
        .map(str::to_string)
        .to_vec();
        let commands = distinct(scoped_list(&table, &["containerapp".to_string()]).into_iter());
        assert_eq!(
            commands,
            [
                "containerapp",
                "group",
                "webapp",
                "containerapp up",
                "containerapp env create"
            ]
        );
    }

    /// Both launcher lines verbatim: `wbin\az.cmd` of the Windows MSI (2.90.0),
    /// and the `/usr/bin/az` the Debian package's rules write
    /// (`scripts/release/debian/prepare.sh` in Azure/azure-cli).
    #[test]
    fn the_interpreter_is_read_off_either_installers_launcher() {
        if cfg!(target_os = "windows") {
            let windows = interpreter_in(
                r#"  "%~dp0\..\python.exe" -IBm azure.cli %*"#,
                Path::new(r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin"),
            );
            assert_eq!(
                windows,
                Some(PathBuf::from(
                    r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\\..\python.exe"
                ))
            );
        } else {
            let debian = interpreter_in(
                r#"AZ_INSTALLER=DEB "$bin_dir"/../../opt/az/bin/python3 -Im azure.cli "$@""#,
                Path::new("/usr/bin"),
            );
            assert_eq!(debian, Some(PathBuf::from("/usr/bin/../../opt/az/bin/python3")));
        }
        assert_eq!(interpreter_in("exec az-real \"$@\"", Path::new("/usr/bin")), None);
    }

    #[test]
    fn a_version_that_is_not_plain_never_names_a_file() {
        let folder = std::env::temp_dir().join(format!("aime-az-index-{}", std::process::id()));
        std::fs::create_dir_all(&folder).expect("a temp folder");
        let index = folder.join("commandIndex.json");
        std::fs::write(
            &index,
            "\u{feff}{\"version\": \"2.90.0\", \"commandIndex\": {\"webapp\": []}}",
        )
        .expect("written");
        assert_eq!(az_version(&folder).as_deref(), Some("2.90.0"));
        assert_eq!(az_index_groups(&folder), Some(vec!["webapp".to_string()]));
        std::fs::write(&index, "{\"version\": \"../../x\"}").expect("written");
        assert_eq!(az_version(&folder), None);
        std::fs::remove_dir_all(&folder).expect("cleaned up");
    }

    #[test]
    fn each_cli_names_where_its_list_lives() {
        let of = |cloud| Dialect::of(cloud).expect("a dialect").vocabulary;
        assert_eq!(of("supabase"), Vocabulary::Completions);
        assert_eq!(of("gcp"), Vocabulary::StaticTree);
        assert_eq!(of("aws"), Vocabulary::Completer);
        assert_eq!(of("azure"), Vocabulary::CommandTable);
    }

    /// Against the Cloud SDK installed here, when there is one.
    #[tokio::test]
    async fn the_installed_cloud_sdk_lists_its_groups_and_a_named_groups_commands() {
        if !Program::resolve("gcloud").exists() {
            eprintln!("gcloud is not installed here; its tree was not read");
            return;
        }
        let commands = static_tree("gcloud", &["run".to_string()])
            .await
            .expect("the SDK's tree");
        assert!(commands.contains(&"compute".to_string()));
        assert!(commands.contains(&"run deploy".to_string()));
        assert!(!commands.iter().any(|command| command.starts_with("compute ")));
    }

    /// Against the AWS CLI installed here, when there is one.
    #[tokio::test]
    async fn the_installed_aws_completer_lists_services_and_a_named_services_operations() {
        if !Program::resolve("aws").exists() {
            eprintln!("aws is not installed here; its completer was not asked");
            return;
        }
        let dialect = Dialect::of("aws").expect("a dialect");
        let commands = completer_tree(dialect, "aws", &["cloudformation".to_string()])
            .await
            .expect("the completer's answer");
        assert!(commands.contains(&"ecs".to_string()));
        // A customisation, which the service model does not have.
        assert!(commands.contains(&"cloudformation deploy".to_string()));
        assert!(!commands.iter().any(|command| command.starts_with("ecs ")));
    }

    /// Against the az installed here, when there is one. Slow on purpose: it
    /// is the eleven-second load the cache exists for.
    #[tokio::test]
    async fn the_installed_azs_python_lists_its_command_table() {
        if !Program::resolve("az").exists() {
            eprintln!("az is not installed here; its command table was not loaded");
            return;
        }
        let table = load_command_table("az").await.expect("az's command table");
        assert!(table.contains(&"containerapp up".to_string()));
        assert!(table.iter().any(|command| command.starts_with("storage ")));
    }
}
