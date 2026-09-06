//! Reading one resource's own settings: the AI plans, Aime checks, Aime runs.
//!
//! Why the AI plans it. Azure has one generic read - `az resource show --ids`
//! returns every type's `properties` - but AWS has none: 385 services ship
//! their own `describe-*`/`get-*` commands, and the first version of this
//! module tried to pick them mechanically out of the CLI's service models. It
//! offered `get-password-data` for a security group and `describe-tasks --tasks
//! 12` for a task definition called `web:12` - twelve commands per resource,
//! most of which could not run. Choosing the right read for a kind of resource
//! takes judgement about what that resource IS, and that is what the AI is for.
//!
//! Why Aime still checks and runs it. The AI answers ONCE per kind -
//! `lambda/function`, `Microsoft.Web/sites`, `run.googleapis.com/Service` -
//! with commands written against placeholders (`<id>`, `<path>`, `<name>`,
//! `<group>`, `<region>`), never against a real resource, so it sees no
//! identifiers and no values. Before any of those commands is kept, Aime proves
//! it against facts on this machine: for AWS the CLI's own service model must
//! contain the operation and every flag; for Azure and Google Cloud the CLI's
//! own `--help` must accept the command (exit 0 for a real one, 2 for a
//! misspelled one - measured for both). Every command has to be a read, the
//! flags Aime supplies itself (`--profile`, `--subscription`, `--project`,
//! `--region`, `--output`, `--format`) are refused, and a value may hold
//! nothing a shell could misread. What survives is written to disk, so the AI
//! is asked about `lambda/function` once, not once per function.
//!
//! And the rule about secrets, which is not optional: a read whose answer can
//! carry a credential is marked so, is never run until a person asks for that
//! one by name, and its answer stays on the screen - never written to a file,
//! never handed to the AI, never put in a prompt.

use super::{read_cli_checked, CliFailure, CloudResource};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// What a read is for, which decides when it runs and where its answer shows.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReadPurpose {
    /// The resource's own configuration; runs as soon as the resource opens.
    Overview,
    /// How to reach it - endpoints, hosts, URLs; runs with the overview.
    Connection,
    /// Can carry a credential; waits for a person to ask for it by name.
    Secret,
}

/// One read, planned once for a kind of resource.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedRead {
    pub purpose: ReadPurpose,
    /// What a person sees on the button, in the CLI's own words.
    pub label: String,
    /// The arguments after the program name, with placeholders where the
    /// resource goes; see `PLACEHOLDERS`.
    pub args: Vec<String>,
}

/// A read the AI proposed and Aime refused, with the reason said out loud.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RejectedRead {
    pub label: String,
    pub reason: String,
}

/// What Aime kept for one kind, and what it would not keep.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadPlan {
    pub reads: Vec<PlannedRead>,
    pub rejected: Vec<RejectedRead>,
}

/// The parts of a resource a planned command may name, and what fills each.
///
/// `<path>` is the identifier without the `//<service>/` a Google Cloud full
/// resource name starts with - `projects/p/zones/z/instances/i`, which is what
/// every `gcloud … describe` accepts - and the same as `<id>` for a cloud whose
/// identifiers carry no such prefix.
const PLACEHOLDERS: [&str; 5] = ["<id>", "<path>", "<name>", "<group>", "<region>"];

/// Flags Aime adds itself, so a plan that carries one is refused: two
/// `--profile`s on one line is at best a CLI error and at worst the other one.
const OWN_FLAGS: [&str; 12] = [
    "--profile",
    "--subscription",
    "--project",
    "--project-ref",
    "--account",
    "--agent",
    "--experimental",
    "--region",
    "--output",
    "-o",
    "--format",
    "--query",
];

/// Flags that change what the CLI does with the command line itself rather
/// than what it asks the cloud; none of them belongs in a read.
const REFUSED_FLAGS: [&str; 6] = [
    "--cli-input-json",
    "--cli-input-yaml",
    "--generate-cli-skeleton",
    "--endpoint-url",
    "--debug",
    "--no-verify-ssl",
];

/// Words in a command that mean its answer can carry the credential itself.
///
/// A plan may call such a read `connection`; Aime raises it to `secret`
/// regardless, and never lowers one. `secret` is deliberately absent:
/// `describe-secret` returns when a secret rotates and which key encrypts it,
/// not the value, and hiding metadata behind a warning teaches people to click
/// past warnings. `key` is present because `list-keys`, `keyvault` and
/// `auth-key` all hand over credentials, and the one false positive it costs
/// - a key vault's own overview waiting for a click - is the cheap side.
///
/// `access` is Google's word for reading a secret's value (`gcloud secrets
/// versions access`), and costs the same cheap side elsewhere.
const SECRET_WORDS: [&str; 11] = [
    "value",
    "password",
    "credential",
    "token",
    "key",
    "connection-string",
    "publishing",
    "decrypt",
    "sas",
    "login",
    "access",
];

/// The verbs an Azure CLI command may end in and still be a read.
const AZURE_READ_VERBS: [&str; 4] = ["show", "list", "get", "check"];

/// The verbs a Google Cloud CLI command may end in and still be a read:
/// `describe`, `list`, `get-iam-policy`, `logging read`, `secrets versions
/// access`. Not `export` - it writes a file - and not `ssh`.
const GCLOUD_READ_VERBS: [&str; 5] = ["describe", "list", "get", "read", "access"];

/// The verbs a Supabase CLI command may end in and still be a read - `functions
/// list`, `postgres-config get`, `storage ls`, `sso show`, `projects api-keys`
/// - plus every `inspect db …` report, whose last word is the report's name.
const SUPABASE_READ_VERBS: [&str; 7] = ["list", "get", "ls", "show", "info", "inspect", "api-keys"];

/// The command group whose every subcommand is a read: `supabase inspect db
/// table-stats` ends in a noun, and refusing it would refuse the whole group.
const SUPABASE_INSPECT: &str = "inspect";

/// The prefixes an AWS operation may carry and still be a read.
const AWS_READ_PREFIXES: [&str; 3] = ["Describe", "Get", "List"];

/// The same three, as the command line spells them.
const AWS_READ_VERBS: [&str; 3] = ["describe", "get", "list"];

/// Commands the AWS CLI exposes under a name other than the API's own.
///
/// Measured 2026-09-03: `aws s3 get-bucket-acl` answers 252 with a usage block
/// while `aws s3api get-bucket-acl` reaches the service - the model on disk is
/// called `s3`, the command line says `s3api`, and that mapping lives in the
/// CLI's autocomplete database rather than in any model. One entry, because
/// one was measured.
const AWS_COMMAND_ALIASES: [(&str, &str); 1] = [("s3api", "s3")];

/// The longest value a plan may carry, placeholders expanded later.
const VALUE_LIMIT: usize = 200;

/// The most reads one kind is offered; a resource is not a catalogue.
const READS_PER_KIND: usize = 8;

/// The one read every Azure type answers, seeded so an Azure resource shows
/// its configuration even when no AI is around to plan the rest.
fn azure_seed() -> PlannedRead {
    PlannedRead {
        purpose: ReadPurpose::Overview,
        label: "az resource show".into(),
        args: ["resource", "show", "--ids", "<id>"]
            .into_iter()
            .map(String::from)
            .collect(),
    }
}

/// Where Aime keeps the plans it has checked, one file per kind per cloud.
fn plans_dir(app: &AppHandle, cloud_id: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cloud-reads")
        .join(cloud_id))
}

/// A kind as a file name: `Microsoft.Web/sites` becomes `microsoft.web_sites`.
fn file_of_kind(kind: &str) -> String {
    let mut name: String = kind
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    name.push_str(".json");
    name
}

fn plan_path(app: &AppHandle, cloud_id: &str, kind: &str) -> Result<PathBuf, String> {
    Ok(plans_dir(app, cloud_id)?.join(file_of_kind(kind)))
}

fn load_plan(app: &AppHandle, cloud_id: &str, kind: &str) -> Result<Option<Vec<PlannedRead>>, String> {
    let path = plan_path(app, cloud_id, kind)?;
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

fn store_plan(app: &AppHandle, cloud_id: &str, kind: &str, reads: &[PlannedRead]) -> Result<(), String> {
    let dir = plans_dir(app, cloud_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(reads).map_err(|e| e.to_string())?;
    std::fs::write(plan_path(app, cloud_id, kind)?, text).map_err(|e| e.to_string())
}

/// The reads already checked for one kind, or `None` when nobody has asked yet.
///
/// Read from disk, so a kind planned in an earlier session costs nothing now -
/// and so the plan is per machine rather than per project: how to read a Lambda
/// function has nothing to do with which repository is open.
#[tauri::command]
pub fn cloud_read_plan(
    app: AppHandle,
    cloud_id: String,
    kind: String,
) -> Result<Option<Vec<PlannedRead>>, String> {
    load_plan(&app, &cloud_id, &kind)
}

/// Forgets the stored plan for one kind, so the next resource of that kind asks
/// the AI again.
///
/// A plan is checked against the CLI's grammar, not against the cloud: the
/// first real Google Cloud project (2026-09-05) was planned as `projects
/// describe <path>`, a command the CLI accepts and the service answers with
/// INVALID_ARGUMENT - it wanted the bare id. Without this, that plan would have
/// been the answer for every project on this machine for good.
#[tauri::command]
pub fn cloud_forget_plan(app: AppHandle, cloud_id: String, kind: String) -> Result<(), String> {
    let path = plan_path(&app, &cloud_id, &kind)?;
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("could not forget {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Checks the reads the AI proposed for one kind, keeps the ones that hold up,
/// and says which did not and why.
///
/// Azure always gets its generic overview first; the AI is asked only for what
/// that generic read cannot answer - how to connect, and where the keys are.
#[tauri::command]
pub async fn cloud_check_reads(
    app: AppHandle,
    cloud_id: String,
    kind: String,
    proposed: Vec<PlannedRead>,
) -> Result<ReadPlan, String> {
    let mut reads: Vec<PlannedRead> = Vec::new();
    let mut rejected = Vec::new();
    if cloud_id == "azure" {
        reads.push(azure_seed());
    }
    let program = super::program_for(&app, &cloud_id);
    for read in proposed {
        if reads.len() >= READS_PER_KIND {
            break;
        }
        if reads.iter().any(|kept| kept.args == read.args) {
            continue;
        }
        match check_read(&program, &cloud_id, &read).await {
            Ok(checked) => reads.push(checked),
            Err(reason) => rejected.push(RejectedRead {
                label: read.label,
                reason,
            }),
        }
    }
    store_plan(&app, &cloud_id, &kind, &reads)?;
    Ok(ReadPlan { reads, rejected })
}

/// Runs one checked read against one resource.
///
/// The read has to be one on that kind's stored plan, compared whole: nothing
/// that arrives from the frontend becomes part of a command line unless Aime
/// already checked exactly that command. The account, the region and the
/// output format are Aime's to add, which is why the plan may not carry them.
#[tauri::command]
pub async fn cloud_run_read(
    app: AppHandle,
    cloud_id: String,
    account: String,
    resource: CloudResource,
    read: PlannedRead,
) -> Result<String, String> {
    let planned = load_plan(&app, &cloud_id, &resource.kind)?.unwrap_or_default();
    if !planned.contains(&read) {
        return Err(format!(
            "`{}` is not a read Aime has checked for {}",
            read.label, resource.kind
        ));
    }
    let mut args: Vec<String> = read.args.iter().map(|arg| fill(arg, &resource)).collect();
    let program = match cloud_id.as_str() {
        "azure" => {
            args.extend(["--subscription".into(), account, "--output".into(), "json".into()]);
            "az".to_string()
        }
        "aws" => {
            args.extend(["--profile".into(), account]);
            // The ARN says where the resource is, and the profile's default
            // region may be elsewhere: a Sydney function read through a
            // profile pointed at Virginia does not exist.
            if !resource.location.is_empty() {
                args.extend(["--region".into(), resource.location.clone()]);
            }
            args.extend(["--output".into(), "json".into()]);
            "aws".to_string()
        }
        "gcp" => {
            // The location is not added here: gcloud spells it `--zone` for
            // one kind and `--region` or `--location` for another, so the
            // plan names the flag and `<region>` fills it.
            args.extend(["--project".into(), account, "--format".into(), "json".into()]);
            "gcloud".to_string()
        }
        "supabase" => {
            // `--agent no`: see `supabase.rs` - the CLI's own guess about who is
            // driving it must not decide the shape of an answer Aime parses.
            let cli = super::supabase::cli(&app)?;
            args.extend(["--project-ref".into(), account, "-o".into(), "json".into()]);
            args.extend(cli.flags());
            cli.program().to_string()
        }
        other => return Err(format!("Aime has no checked reads for {other}")),
    };
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    match read_cli_checked(&program, &borrowed).await {
        Ok(text) => Ok(text),
        // 252 is the AWS CLI saying the command line itself is wrong - a read
        // the model accepted but the CLI spells differently. Named as Aime's
        // failure rather than shown as a usage block.
        Err(CliFailure { code: Some(252), .. }) if program == "aws" => {
            Err(format!("UNSUPPORTED_READ::{}", read.label))
        }
        Err(failure) => Err(failure.message),
    }
}

/// A planned argument with the resource put in.
fn fill(arg: &str, resource: &CloudResource) -> String {
    arg.replace("<id>", &resource.id)
        .replace("<path>", path_of(&resource.id))
        .replace("<name>", &resource.name)
        .replace("<group>", &resource.group)
        .replace("<region>", &resource.location)
}

/// The identifier without the `//<service>/` a Google Cloud full resource name
/// starts with; any other identifier, whole.
pub(crate) fn path_of(id: &str) -> &str {
    id.strip_prefix("//")
        .and_then(|rest| rest.split_once('/'))
        .map_or(id, |(_, path)| path)
}

/// One proposed read, proven against this machine or refused with a reason.
async fn check_read(program: &str, cloud_id: &str, read: &PlannedRead) -> Result<PlannedRead, String> {
    let verbs = read_verbs_of(cloud_id).ok_or_else(|| format!("Aime does not check reads for {cloud_id}"))?;
    let line = CommandLine::parse(&read.args, verbs)?;
    match cloud_id {
        "aws" => check_aws(&line)?,
        "azure" => check_azure(&line).await?,
        "gcp" => check_gcloud(&line).await?,
        _ => check_supabase(program, &line).await?,
    }
    let purpose = if looks_sensitive(&line.words) {
        ReadPurpose::Secret
    } else {
        read.purpose
    };
    Ok(PlannedRead {
        purpose,
        label: if read.label.trim().is_empty() {
            line.words.join(" ")
        } else {
            read.label.trim().to_string()
        },
        args: read.args.clone(),
    })
}

/// The shape every read has: command words, then the positionals the read
/// verb takes, then flags with their values.
///
/// Positionals exist because `gcloud` names the resource that way - `compute
/// instances describe <path>` - where `az` and `aws` take it as a flag. A
/// token after the read verb is a positional whatever it looks like (`latest`
/// in `secrets versions access latest` is not a command), and a token before
/// the verb that is not a command word is refused: there is no read whose
/// resource comes before its verb.
struct CommandLine<'a> {
    words: Vec<&'a str>,
    positionals: Vec<&'a str>,
    /// Each flag with the value that followed it, if one did.
    flags: Vec<(&'a str, Option<&'a str>)>,
}

impl<'a> CommandLine<'a> {
    /// Splits and vets the tokens: the shape is fixed, the character sets are
    /// narrow, and anything else is refused with the token named. `read_verbs`
    /// are the CLI's own, so the parser knows where the command ends and its
    /// arguments begin.
    fn parse(args: &'a [String], read_verbs: &[&str]) -> Result<Self, String> {
        if args.is_empty() {
            return Err("an empty command".into());
        }
        let mut words: Vec<&str> = Vec::new();
        let mut positionals = Vec::new();
        let mut flags: Vec<(&str, Option<&str>)> = Vec::new();
        for token in args {
            if let Some(flag) = token.strip_prefix("--") {
                if !is_command_word(flag) {
                    return Err(format!("`{token}` is not a flag"));
                }
                if OWN_FLAGS.contains(&token.as_str()) {
                    return Err(format!("`{token}` is Aime's to add"));
                }
                if REFUSED_FLAGS.contains(&token.as_str()) {
                    return Err(format!("`{token}` is not part of a read"));
                }
                flags.push((token.as_str(), None));
            } else if let Some((_, value @ None)) = flags.last_mut() {
                if !is_safe_value(token) {
                    return Err(format!("`{token}` holds something a shell could misread"));
                }
                *value = Some(token.as_str());
            } else if !flags.is_empty() {
                return Err(format!("`{token}` follows a flag that already has a value"));
            } else if words
                .last()
                .is_some_and(|last| starts_with_a_verb(last, read_verbs))
            {
                if !is_safe_value(token) {
                    return Err(format!("`{token}` holds something a shell could misread"));
                }
                positionals.push(token.as_str());
            } else if is_command_word(token) {
                words.push(token.as_str());
            } else {
                return Err(format!("`{token}` is not a command word"));
            }
        }
        if words.is_empty() {
            return Err("no command, only flags".into());
        }
        Ok(Self {
            words,
            positionals,
            flags,
        })
    }
}

/// The read verbs of one cloud's CLI, as its command lines spell them.
fn read_verbs_of(cloud_id: &str) -> Option<&'static [&'static str]> {
    match cloud_id {
        "aws" => Some(&AWS_READ_VERBS),
        "azure" => Some(&AZURE_READ_VERBS),
        "gcp" => Some(&GCLOUD_READ_VERBS),
        "supabase" => Some(&SUPABASE_READ_VERBS),
        _ => None,
    }
}

fn starts_with_a_verb(word: &str, verbs: &[&str]) -> bool {
    verbs.iter().any(|verb| word.starts_with(verb))
}

/// `describe-secret`, `s3api`, `show-connection-string`: lower-case, digits, dashes.
fn is_command_word(word: &str) -> bool {
    let mut chars = word.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && word
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

/// A value the CLI can be handed on any platform.
///
/// Placeholders are cut out first, so `https://sqs.<region>.amazonaws.com/<group>/<name>`
/// passes as the URL it becomes. What remains may hold letters, digits and the
/// punctuation identifiers and URLs are made of - nothing a shell reads as
/// structure, because on Windows `az` is a batch shim and every argument goes
/// through cmd.exe's parser.
fn is_safe_value(value: &str) -> bool {
    let mut stripped = value.to_string();
    for placeholder in PLACEHOLDERS {
        stripped = stripped.replace(placeholder, "");
    }
    !value.is_empty()
        && value.len() <= VALUE_LIMIT
        && stripped
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_.:/=,*@+-".contains(ch))
}

/// Whether any command word says the answer carries a credential.
fn looks_sensitive(words: &[&str]) -> bool {
    words
        .iter()
        .any(|word| SECRET_WORDS.iter().any(|secret| word.contains(secret)))
}

/// An AWS read, proven against the CLI's own service model on this machine.
fn check_aws(line: &CommandLine<'_>) -> Result<(), String> {
    let [service, command] = line.words[..] else {
        return Err("an AWS read is `<service> <command>`".into());
    };
    if let Some(stray) = line.positionals.first() {
        return Err(format!(
            "`{stray}` is not a flag; the AWS CLI takes every argument as one"
        ));
    }
    let model_name = AWS_COMMAND_ALIASES
        .iter()
        .find(|(alias, _)| *alias == service)
        .map_or(service, |(_, api)| *api);
    let models = aws_models_dir().ok_or("the AWS CLI's service models are not beside its binary")?;
    let path = newest_model(&models.join(model_name))
        .ok_or_else(|| format!("the AWS CLI on this machine has no service called `{service}`"))?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let model: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    check_aws_against(&model, command, &line.flags)
}

/// The model check itself, apart from where the model came from.
fn check_aws_against(
    model: &serde_json::Value,
    command: &str,
    flags: &[(&str, Option<&str>)],
) -> Result<(), String> {
    let operations = model
        .get("operations")
        .and_then(serde_json::Value::as_object)
        .ok_or("the service model has no operations")?;
    let (name, operation) = operations
        .iter()
        .find(|(name, _)| kebab(name) == command)
        .ok_or_else(|| format!("`{command}` is not an operation of this service"))?;
    if !AWS_READ_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
        return Err(format!("`{command}` is not a read"));
    }
    let Some(shape_name) = operation
        .pointer("/input/shape")
        .and_then(serde_json::Value::as_str)
    else {
        return if flags.is_empty() {
            Ok(())
        } else {
            Err(format!("`{command}` takes no arguments"))
        };
    };
    let shape = model
        .pointer(&format!("/shapes/{shape_name}"))
        .ok_or_else(|| format!("the model has no shape `{shape_name}`"))?;
    let members: Vec<String> = shape
        .get("members")
        .and_then(serde_json::Value::as_object)
        .map(|members| {
            members
                .keys()
                .map(|member| format!("--{}", kebab(member)))
                .collect()
        })
        .unwrap_or_default();
    for (flag, _) in flags {
        if !members.iter().any(|member| member == flag) {
            return Err(format!("`{command}` has no `{flag}`"));
        }
    }
    let required: Vec<String> = shape
        .get("required")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(serde_json::Value::as_str)
                .map(|member| format!("--{}", kebab(member)))
                .collect()
        })
        .unwrap_or_default();
    for needed in required {
        if !flags.iter().any(|(flag, _)| *flag == needed) {
            return Err(format!("`{command}` needs `{needed}`"));
        }
    }
    Ok(())
}

/// An Azure read: a command that ends in a read verb, and that the CLI itself
/// recognises - `az <command> --help` exits 0 for a real command and 2 for a
/// misspelled one, measured 2026-09-03, and needs no sign-in to answer.
async fn check_azure(line: &CommandLine<'_>) -> Result<(), String> {
    check_azure_shape(&line.words)?;
    let mut args: Vec<&str> = line.words.clone();
    args.push("--help");
    read_cli_checked("az", &args).await.map(|_| ()).map_err(|_| {
        format!(
            "`az {}` is not a command the Azure CLI here knows",
            line.words.join(" ")
        )
    })
}

/// The part of the Azure check that needs no CLI: is this even a read.
fn check_azure_shape(words: &[&str]) -> Result<(), String> {
    ends_in_a_read_verb(words, &AZURE_READ_VERBS)
}

/// A Google Cloud read: a command that ends in a read verb, and that the CLI
/// itself recognises - `gcloud <command> --help` exits 0 for a real command and
/// 2 for a misspelled one, measured 2026-09-05, and needs no sign-in to answer.
async fn check_gcloud(line: &CommandLine<'_>) -> Result<(), String> {
    check_gcloud_shape(&line.words)?;
    let mut args: Vec<&str> = line.words.clone();
    args.push("--help");
    read_cli_checked("gcloud", &args).await.map(|_| ()).map_err(|_| {
        format!(
            "`gcloud {}` is not a command the Google Cloud CLI here knows",
            line.words.join(" ")
        )
    })
}

/// The part of the Google Cloud check that needs no CLI: is this even a read.
fn check_gcloud_shape(words: &[&str]) -> Result<(), String> {
    ends_in_a_read_verb(words, &GCLOUD_READ_VERBS)
}

/// A Supabase read: a command that ends in a read verb, and that exists in the
/// CLI's own command tree.
///
/// Not `--help`: measured 2026-09-05, `supabase functions lst --help` exits 0
/// and prints the help of `functions`, so a misspelled command passes that
/// check. What the CLI does give is a SUBCOMMANDS section at every level, so
/// the words are walked one level at a time and each has to be listed by the
/// level above it - `supabase --help` must list `functions`, `supabase
/// functions --help` must list `list`.
async fn check_supabase(program: &str, line: &CommandLine<'_>) -> Result<(), String> {
    check_supabase_shape(&line.words)?;
    for depth in 0..line.words.len() {
        let mut args: Vec<&str> = line.words[..depth].to_vec();
        args.push("--help");
        let help = read_cli_checked(program, &args)
            .await
            .map_err(|failure| failure.message)?;
        let word = line.words[depth];
        if !subcommands_in(&help).iter().any(|known| known == word) {
            return Err(format!(
                "`supabase {}` is not a command the Supabase CLI here knows",
                line.words[..=depth].join(" ")
            ));
        }
    }
    Ok(())
}

/// The part of the Supabase check that needs no CLI: is this even a read.
fn check_supabase_shape(words: &[&str]) -> Result<(), String> {
    if words.contains(&SUPABASE_INSPECT) {
        return Ok(());
    }
    ends_in_a_read_verb(words, &SUPABASE_READ_VERBS)
}

/// The subcommands one level of `supabase … --help` lists.
///
/// The section is `SUBCOMMANDS`, one per line, name then description. The CLI
/// pads names to a column and lets a long one run into its description
/// (`network-restrictionsManage network restrictions`, measured), and an alias
/// shares the line (`migration, migrationsManage …`) - so a name is what comes
/// before the first capital letter, split on the comma.
fn subcommands_in(help: &str) -> Vec<String> {
    help.lines()
        .skip_while(|line| line.trim() != "SUBCOMMANDS")
        .skip(1)
        .take_while(|line| line.starts_with("  "))
        .flat_map(|line| {
            let names: String = line
                .trim_start()
                .chars()
                .take_while(|ch| !ch.is_ascii_uppercase())
                .collect();
            names
                .split(',')
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Whether the last command word starts with one of a CLI's read verbs.
fn ends_in_a_read_verb(words: &[&str], verbs: &[&str]) -> Result<(), String> {
    let last = words.last().ok_or("an empty command")?;
    if !verbs.iter().any(|verb| last.starts_with(verb)) {
        return Err(format!("`{last}` is not a read verb"));
    }
    Ok(())
}

/// The AWS CLI's own catalogue of one service's reads, for the AI to choose from.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AwsCatalog {
    pub service: String,
    pub operations: Vec<AwsOperation>,
}

/// One read the CLI has, spelled the way the command line spells it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AwsOperation {
    pub command: String,
    pub flags: Vec<String>,
    pub required: Vec<String>,
}

/// Every read the AWS CLI on this machine has for the service an ARN names.
///
/// Handed to the AI so its plan is chosen from what exists rather than from
/// memory: the operation names and flags come out of the CLI's own model, which
/// ships beside its binary. `None` for a service the CLI does not know, or on a
/// machine where the models are not where the AWS CLI installs them.
#[tauri::command]
pub fn cloud_read_catalog(resource_id: String) -> Option<AwsCatalog> {
    let service = resource_id.split(':').nth(2).filter(|part| !part.is_empty())?;
    let path = newest_model(&aws_models_dir()?.join(service))?;
    let text = std::fs::read_to_string(&path).ok()?;
    let model: serde_json::Value = serde_json::from_str(&text).ok()?;
    let operations = model.get("operations")?.as_object()?;
    let mut reads: Vec<AwsOperation> = operations
        .iter()
        .filter(|(name, _)| AWS_READ_PREFIXES.iter().any(|prefix| name.starts_with(prefix)))
        .map(|(name, operation)| {
            let shape = operation
                .pointer("/input/shape")
                .and_then(serde_json::Value::as_str)
                .and_then(|shape_name| model.pointer(&format!("/shapes/{shape_name}")));
            let flags = shape
                .and_then(|shape| shape.get("members"))
                .and_then(serde_json::Value::as_object)
                .map(|members| {
                    members
                        .keys()
                        .map(|member| format!("--{}", kebab(member)))
                        .collect()
                })
                .unwrap_or_default();
            let required = shape
                .and_then(|shape| shape.get("required"))
                .and_then(serde_json::Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(|member| format!("--{}", kebab(member)))
                        .collect()
                })
                .unwrap_or_default();
            AwsOperation {
                command: kebab(name),
                flags,
                required,
            }
        })
        .collect();
    reads.sort_by(|left, right| left.command.cmp(&right.command));
    Some(AwsCatalog {
        service: service.to_string(),
        operations: reads,
    })
}

/// Where the AWS CLI keeps its service models, found from the binary itself.
///
/// Beside the executable rather than at a remembered path: the install location
/// differs per platform and per install, and the one thing always true is that
/// the models ship with the binary that reads them.
fn aws_models_dir() -> Option<PathBuf> {
    let binary = crate::program::Program::resolve("aws");
    if !binary.exists() {
        return None;
    }
    let data = binary
        .path()
        .parent()?
        .join("awscli")
        .join("botocore")
        .join("data");
    data.is_dir().then_some(data)
}

/// The model file for one service, newest API version first.
///
/// Botocore keeps a dated folder per API version; a service that has been
/// revised has several, and the current CLI uses the latest.
fn newest_model(service_dir: &Path) -> Option<PathBuf> {
    let mut versions: Vec<PathBuf> = std::fs::read_dir(service_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort();
    versions
        .into_iter()
        .rev()
        .map(|dir| dir.join("service-2.json"))
        .find(|model| model.is_file())
}

/// `DescribeSecret` becomes `describe-secret`, the way the CLI spells it.
///
/// Runs of capitals stay together, which is not a nicety: naively hyphenating
/// every capital turns `DescribeDBInstances` into `describe-d-b-instances`, a
/// command that does not exist. A break goes before a capital that follows a
/// lower-case letter, and before the LAST capital of a run when a lower-case
/// letter follows it - so `DBInstances` is `db-instances` and `DBCluster` is
/// `db-cluster`.
fn kebab(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len() + 4);
    for (index, ch) in chars.iter().enumerate() {
        let previous = index.checked_sub(1).and_then(|before| chars.get(before));
        let next = chars.get(index + 1);
        let starts_word = previous.is_some_and(|before| before.is_lowercase() || before.is_numeric());
        let ends_acronym = previous.is_some_and(|before| before.is_uppercase())
            && next.is_some_and(|after| after.is_lowercase());
        if ch.is_uppercase() && (starts_word || ends_acronym) {
            out.push('-');
        }
        out.extend(ch.to_lowercase());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(String::from).collect()
    }

    /// Every one of these was wrong in the first version, and each wrong answer
    /// is a command the CLI does not have.
    #[test]
    fn an_operation_name_becomes_the_command_the_cli_actually_has() {
        assert_eq!(kebab("DescribeSecret"), "describe-secret");
        assert_eq!(kebab("DescribeDBInstances"), "describe-db-instances");
        assert_eq!(
            kebab("DescribeDBClusterEndpoints"),
            "describe-db-cluster-endpoints"
        );
        assert_eq!(kebab("GetSecretValue"), "get-secret-value");
        assert_eq!(kebab("DBInstanceIdentifier"), "db-instance-identifier");
        assert_eq!(kebab("ListTagsForResource"), "list-tags-for-resource");
    }

    #[test]
    fn a_command_line_is_words_then_flags_with_values() {
        let tokens = args("lambda get-function --function-name <name>");
        let parsed = CommandLine::parse(&tokens, &AWS_READ_VERBS).expect("parsed");
        assert_eq!(parsed.words, ["lambda", "get-function"]);
        assert_eq!(parsed.flags, [("--function-name", Some("<name>"))]);
        assert!(parsed.positionals.is_empty());

        // A flag with no value is a switch, and the next flag starts fresh.
        let tokens = args("ssm get-parameter --with-decryption --name <name>");
        let parsed = CommandLine::parse(&tokens, &AWS_READ_VERBS).expect("parsed");
        assert_eq!(
            parsed.flags,
            [("--with-decryption", None), ("--name", Some("<name>"))]
        );
    }

    /// gcloud names the resource as a positional after the verb - the shape
    /// the first real plan came back in (`compute instances describe <path>`)
    /// and the parser refused as "not a command word". Whatever follows the
    /// verb is an argument, `latest` included; nothing before it may be.
    #[test]
    fn what_follows_the_read_verb_is_a_positional_and_nothing_before_it_may_be() {
        let tokens = args("compute instances describe <path>");
        let parsed = CommandLine::parse(&tokens, &GCLOUD_READ_VERBS).expect("parsed");
        assert_eq!(parsed.words, ["compute", "instances", "describe"]);
        assert_eq!(parsed.positionals, ["<path>"]);

        let tokens = args("secrets versions access latest --secret <name>");
        let parsed = CommandLine::parse(&tokens, &GCLOUD_READ_VERBS).expect("parsed");
        assert_eq!(parsed.words, ["secrets", "versions", "access"]);
        assert_eq!(parsed.positionals, ["latest"]);
        assert_eq!(parsed.flags, [("--secret", Some("<name>"))]);

        let tokens = args("storage buckets describe gs://<name>");
        let parsed = CommandLine::parse(&tokens, &GCLOUD_READ_VERBS).expect("parsed");
        assert_eq!(parsed.positionals, ["gs://<name>"]);

        for refused in [
            "compute <path> describe",
            "compute instances describe <path>;",
            "compute instances describe --zone <region> <path>",
        ] {
            assert!(
                CommandLine::parse(&args(refused), &GCLOUD_READ_VERBS).is_err(),
                "{refused}"
            );
        }
        // The AWS CLI takes every argument as a flag, so a positional there is
        // a command the CLI will refuse with a usage block - refused earlier.
        let tokens = args("lambda get-function <name>");
        let parsed = CommandLine::parse(&tokens, &AWS_READ_VERBS).expect("parsed");
        assert!(check_aws(&parsed).is_err());
    }

    /// The whole point of the parser: on Windows `az` is a batch shim, so every
    /// argument goes through cmd.exe, and these are the tokens that would let
    /// a planned command do something other than read.
    #[test]
    fn anything_a_shell_could_misread_is_refused_by_name() {
        let refused = [
            "resource show --ids <id>;",
            "resource show --ids <id>&&whoami",
            "resource show --ids $(id)",
            "resource show --ids `id`",
            "resource show --ids a|b",
            "resource show --ids \"<id>\"",
            "resource show --ids 'x'",
            "resource show --ids <id> stray",
            "Resource show --ids <id>",
            "resource show ---ids <id>",
        ];
        for line in refused {
            assert!(
                CommandLine::parse(&args(line), &AZURE_READ_VERBS).is_err(),
                "{line} should be refused"
            );
        }
        // Placeholders inside a URL are what SQS needs, and that is fine.
        assert!(is_safe_value("https://sqs.<region>.amazonaws.com/<group>/<name>"));
        assert!(!is_safe_value(""));
        assert!(!is_safe_value(&"x".repeat(VALUE_LIMIT + 1)));
    }

    #[test]
    fn the_flags_aime_adds_itself_may_not_come_from_a_plan() {
        for line in [
            "lambda get-function --function-name <name> --profile prod",
            "resource show --ids <id> --subscription x",
            "lambda get-function --function-name <name> --region us-east-1",
            "lambda get-function --function-name <name> --output text",
            "lambda get-function --function-name <name> --query Configuration",
            "lambda get-function --function-name <name> --cli-input-json x",
            "compute instances describe <path> --project shop-prod",
            "compute instances describe <path> --format yaml",
            "compute instances describe <path> --account dev@example.com",
            "postgres-config get --experimental",
        ] {
            let verbs = if line.starts_with("compute") {
                &GCLOUD_READ_VERBS[..]
            } else if line.starts_with("postgres-config") {
                &SUPABASE_READ_VERBS[..]
            } else if line.starts_with("resource") {
                &AZURE_READ_VERBS[..]
            } else {
                &AWS_READ_VERBS[..]
            };
            assert!(CommandLine::parse(&args(line), verbs).is_err(), "{line}");
        }
        // gcloud also accepts `--flag=value`; a plan spelled that way is refused
        // as "not a flag" rather than passed through half-parsed.
        assert!(CommandLine::parse(
            &args("compute instances describe <path> --zone=<region>"),
            &GCLOUD_READ_VERBS
        )
        .is_err());
    }

    /// Only the ending decides, and only these endings read: `gcloud compute
    /// instances delete` and `gcloud run deploy` are refused before the CLI is
    /// ever asked, and so is `export`, which writes a file.
    #[test]
    fn a_gcloud_command_has_to_end_in_a_read_verb() {
        assert!(check_gcloud_shape(&["compute", "instances", "describe"]).is_ok());
        assert!(check_gcloud_shape(&["run", "services", "describe"]).is_ok());
        assert!(check_gcloud_shape(&["projects", "get-iam-policy"]).is_ok());
        assert!(check_gcloud_shape(&["logging", "read"]).is_ok());
        assert!(check_gcloud_shape(&["secrets", "versions", "access"]).is_ok());
        assert!(check_gcloud_shape(&["compute", "instances", "delete"]).is_err());
        assert!(check_gcloud_shape(&["run", "deploy"]).is_err());
        assert!(check_gcloud_shape(&["compute", "instances", "export"]).is_err());
        assert!(check_gcloud_shape(&["compute", "ssh"]).is_err());
        // Reading a secret's value is a read, and it is a secret.
        assert!(looks_sensitive(&["secrets", "versions", "access"]));
        assert!(!looks_sensitive(&["secrets", "describe"]));
    }

    /// The SUBCOMMANDS section as `supabase --help` printed it on this machine
    /// (2026-09-05), cut to the lines that show the two shapes a parser has to
    /// survive: a long name glued to its description, and an alias pair.
    const SUPABASE_HELP: &str = "GLOBAL FLAGS\n  --help, -h    Show help information\n\nSUBCOMMANDS\n  functions           Manage Supabase Edge functions\n  migration, migrationsManage database migration scripts\n  network-restrictionsManage network restrictions\n  projects            Manage projects\n";

    #[test]
    fn the_supabase_command_tree_is_read_off_its_own_help() {
        assert_eq!(
            subcommands_in(SUPABASE_HELP),
            [
                "functions",
                "migration",
                "migrations",
                "network-restrictions",
                "projects"
            ]
        );
        // A leaf's help has no SUBCOMMANDS section, so it lists nothing.
        assert!(
            subcommands_in("DESCRIPTION\n  List all Functions\n\nUSAGE\n  supabase functions list\n")
                .is_empty()
        );
    }

    /// `inspect db table-stats` ends in a noun and is a read; `functions deploy`
    /// and `db reset` are not, and `projects api-keys` is one that carries a key.
    #[test]
    fn a_supabase_command_has_to_end_in_a_read_verb_unless_it_inspects() {
        assert!(check_supabase_shape(&["functions", "list"]).is_ok());
        assert!(check_supabase_shape(&["postgres-config", "get"]).is_ok());
        assert!(check_supabase_shape(&["storage", "ls"]).is_ok());
        assert!(check_supabase_shape(&["projects", "api-keys"]).is_ok());
        assert!(check_supabase_shape(&["inspect", "db", "table-stats"]).is_ok());
        assert!(check_supabase_shape(&["functions", "deploy"]).is_err());
        assert!(check_supabase_shape(&["db", "reset"]).is_err());
        assert!(check_supabase_shape(&["secrets", "set"]).is_err());
        assert!(looks_sensitive(&["projects", "api-keys"]));
        // The flag Aime adds for Supabase may not come from a plan either.
        assert!(CommandLine::parse(&args("functions list --project-ref abc"), &SUPABASE_READ_VERBS).is_err());
    }

    /// `<path>` is what every `gcloud … describe` takes: the full resource name
    /// without its `//<service>/` head. For the other clouds it is the id.
    #[test]
    fn the_path_placeholder_is_the_full_name_without_its_service_head() {
        assert_eq!(
            path_of("//compute.googleapis.com/projects/p/zones/z/instances/i"),
            "projects/p/zones/z/instances/i"
        );
        assert_eq!(path_of("//storage.googleapis.com/my-bucket"), "my-bucket");
        assert_eq!(path_of("arn:aws:sqs:r:0:orders"), "arn:aws:sqs:r:0:orders");
        assert_eq!(
            path_of("/subscriptions/s/resourceGroups/g"),
            "/subscriptions/s/resourceGroups/g"
        );
        assert_eq!(path_of("//nothing-after"), "//nothing-after");
        let vm = CloudResource {
            id: "//compute.googleapis.com/projects/p/zones/asia-southeast1-b/instances/web-1".into(),
            name: "web-1".into(),
            kind: "compute.googleapis.com/Instance".into(),
            location: "asia-southeast1-b".into(),
            group: "p".into(),
            tags: Default::default(),
        };
        assert_eq!(
            fill("<path>", &vm),
            "projects/p/zones/asia-southeast1-b/instances/web-1"
        );
        assert_eq!(fill("<region>", &vm), "asia-southeast1-b");
        assert!(is_safe_value("<path>"));
    }

    /// The distinction that decides whether a read waits for a click.
    #[test]
    fn a_read_of_the_credential_itself_is_raised_to_secret_and_never_lowered() {
        assert!(looks_sensitive(&["secretsmanager", "get-secret-value"]));
        assert!(looks_sensitive(&["storage", "account", "show-connection-string"]));
        assert!(looks_sensitive(&["cosmosdb", "keys", "list"]));
        assert!(looks_sensitive(&[
            "webapp",
            "deployment",
            "list-publishing-credentials"
        ]));
        assert!(looks_sensitive(&["ssm", "get-parameter", "--with-decryption"]));
        // Metadata about a secret is not the secret.
        assert!(!looks_sensitive(&["secretsmanager", "describe-secret"]));
        assert!(!looks_sensitive(&["lambda", "get-function-configuration"]));
        assert!(!looks_sensitive(&["rds", "describe-db-clusters"]));
    }

    /// Only the ending decides, and only these endings read: `az webapp restart`
    /// and `az group delete` are refused before the CLI is ever asked.
    #[test]
    fn an_azure_command_has_to_end_in_a_read_verb() {
        assert!(check_azure_shape(&["resource", "show"]).is_ok());
        assert!(check_azure_shape(&["storage", "account", "show-connection-string"]).is_ok());
        assert!(check_azure_shape(&["cosmosdb", "keys", "list"]).is_ok());
        assert!(check_azure_shape(&["webapp", "deployment", "list-publishing-credentials"]).is_ok());
        assert!(check_azure_shape(&["webapp", "restart"]).is_err());
        assert!(check_azure_shape(&["group", "delete"]).is_err());
        assert!(check_azure_shape(&["webapp", "config", "appsettings", "set"]).is_err());
    }

    /// Cut from the real `secretsmanager/2017-10-17/service-2.json` beside the
    /// AWS CLI on this machine (2026-09-03): three operations and their input
    /// shapes, exactly as the model spells them. A fixture written from memory
    /// of "what a botocore model looks like" would prove nothing about the
    /// file the checker actually reads.
    fn secretsmanager_model() -> serde_json::Value {
        serde_json::json!({
          "operations": {
            "DescribeSecret": { "input": { "shape": "DescribeSecretRequest" } },
            "GetSecretValue": { "input": { "shape": "GetSecretValueRequest" } },
            "DeleteSecret": { "input": { "shape": "DeleteSecretRequest" } },
            "GetRandomPassword": {}
          },
          "shapes": {
            "DescribeSecretRequest": {
              "type": "structure",
              "required": ["SecretId"],
              "members": { "SecretId": { "shape": "SecretIdType" } }
            },
            "GetSecretValueRequest": {
              "type": "structure",
              "required": ["SecretId"],
              "members": {
                "SecretId": { "shape": "SecretIdType" },
                "VersionId": { "shape": "SecretVersionIdType" },
                "VersionStage": { "shape": "SecretVersionStageType" }
              }
            },
            "DeleteSecretRequest": {
              "type": "structure",
              "required": ["SecretId"],
              "members": {
                "SecretId": { "shape": "SecretIdType" },
                "RecoveryWindowInDays": { "shape": "RecoveryWindowInDaysType" },
                "ForceDeleteWithoutRecovery": { "shape": "BooleanType" }
              }
            }
          }
        })
    }

    #[test]
    fn an_aws_read_is_proven_against_the_service_model() {
        let model = secretsmanager_model();
        let ok = |line: &str| {
            let tokens = args(line);
            let parsed = CommandLine::parse(&tokens, &AWS_READ_VERBS).expect("parsed");
            check_aws_against(&model, parsed.words[1], &parsed.flags)
        };
        assert!(ok("secretsmanager describe-secret --secret-id <id>").is_ok());
        assert!(ok("secretsmanager get-secret-value --secret-id <id> --version-stage AWSCURRENT").is_ok());
        // A read that takes nothing is a read as long as it is given nothing.
        assert!(ok("secretsmanager get-random-password").is_ok());
        assert!(ok("secretsmanager get-random-password --length 12").is_err());

        // Not a read, however real the operation is.
        assert_eq!(
            ok("secretsmanager delete-secret --secret-id <id>").expect_err("refused"),
            "`delete-secret` is not a read"
        );
        // A flag the operation does not have, and a required one left out.
        assert_eq!(
            ok("secretsmanager describe-secret --secret-id <id> --verbose").expect_err("refused"),
            "`describe-secret` has no `--verbose`"
        );
        assert_eq!(
            ok("secretsmanager describe-secret").expect_err("refused"),
            "`describe-secret` needs `--secret-id`"
        );
        // An operation the service does not have at all.
        assert!(ok("secretsmanager describe-secrets --secret-id <id>").is_err());
    }

    #[test]
    fn the_resource_is_put_in_where_the_plan_left_room_for_it() {
        let resource = CloudResource {
            id: "arn:aws:sqs:ap-southeast-2:000000000000:orders".into(),
            name: "orders".into(),
            kind: "sqs".into(),
            location: "ap-southeast-2".into(),
            group: "000000000000".into(),
            tags: Default::default(),
        };
        assert_eq!(
            fill("https://sqs.<region>.amazonaws.com/<group>/<name>", &resource),
            "https://sqs.ap-southeast-2.amazonaws.com/000000000000/orders"
        );
        assert_eq!(fill("<id>", &resource), resource.id);
        assert_eq!(fill("plain", &resource), "plain");
    }

    #[test]
    fn a_kind_becomes_one_file_name_per_kind() {
        assert_eq!(file_of_kind("Microsoft.Web/sites"), "microsoft.web_sites.json");
        assert_eq!(file_of_kind("lambda/function"), "lambda_function.json");
        assert_eq!(file_of_kind("sqs"), "sqs.json");
        assert_eq!(file_of_kind("ecs/task-definition"), "ecs_task-definition.json");
    }
}
