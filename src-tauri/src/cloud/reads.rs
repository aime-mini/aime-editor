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

use super::{bq, read_cli_checked, CliFailure, CloudResource};
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
    /// Which of the cloud's own CLIs runs this; empty for its main one.
    ///
    /// A cloud is not always one CLI. Google Cloud ships two that matter here -
    /// `gcloud`, and `bq`, which reads the BigQuery datasets `gcloud` has no
    /// command for at all - so the plan says which, and `program_of` is the
    /// gate: a second CLI is accepted for the one service it belongs to and
    /// refused everywhere else.
    #[serde(default)]
    pub program: String,
}

/// A read the AI proposed and Aime refused, with the reason said out loud.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RejectedRead {
    pub label: String,
    pub reason: String,
    /// The read that was refused, so the caller can ask the AI to write it
    /// again with the reason in hand - and ask for the same PURPOSE, since a
    /// `secret` rewritten as an overview is the credential read gone. None when
    /// what was refused is a connection fact, which is not a command.
    #[serde(default)]
    pub command: Option<PlannedRead>,
}

/// One thing a developer pastes into an app, written out of the resource's own
/// identity rather than fetched from the cloud.
///
/// Measured 2026-09-10 across a real Google account: for a large share of what
/// people actually have - Pub/Sub topics and subscriptions, buckets, BigQuery
/// datasets, App Engine apps - the "connection detail" IS the resource's name
/// in the shape an SDK takes it, and Aime already holds every part of it from
/// the listing. Asking the cloud for it would be a network call to be told
/// what was already on the screen.
///
/// `value` is a template over the same placeholders a command uses, so one
/// answer serves every resource of the kind. A credential is never a fact: it
/// cannot be derived from a name, so anything claiming to be one is a read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFact {
    /// What it is, in a developer's words: `Topic path`, `Bucket URI`.
    pub label: String,
    /// The value with placeholders where the resource goes.
    pub value: String,
}

/// What Aime kept for one kind, and what it would not keep.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadPlan {
    pub reads: Vec<PlannedRead>,
    pub facts: Vec<ConnectionFact>,
    pub rejected: Vec<RejectedRead>,
}

/// One kind's plan as it sits on disk.
///
/// A plan used to be a bare array of reads; a file written by an older build
/// still parses (see `load_plan`), because throwing away every plan on this
/// machine to add a field would cost an AI call per kind for nothing.
#[derive(Serialize, Deserialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredPlan {
    pub reads: Vec<PlannedRead>,
    #[serde(default)]
    pub facts: Vec<ConnectionFact>,
    /// Whether every read here has been run against a real resource and
    /// answered.
    ///
    /// False when the trial run hit something that is not the command's fault -
    /// a project with the API switched off, no billing, a sign-in that lapsed -
    /// because the CLI refuses the right command and the wrong one with the
    /// same sentence, and calling that proof would be the old bug wearing a new
    /// field. An unproved plan is used, and proved again the next time a
    /// resource of its kind is opened; a plan written by an older build is
    /// unproved by definition.
    #[serde(default)]
    pub proved: bool,
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
const OWN_FLAGS: [&str; 13] = [
    "--profile",
    "--subscription",
    "--project",
    // `bq`'s spelling of the same thing, which is not `--project`.
    "--project_id",
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

/// How many connection facts one kind may carry. A resource has a handful of
/// names an SDK takes; a longer list is the model padding.
const FACTS_PER_KIND: usize = 6;

/// How long a fact's label may be: a column heading, not a sentence.
const FACT_LABEL_LIMIT: usize = 60;

/// The one read every Azure type answers, seeded so an Azure resource shows
/// its configuration even when no AI is around to plan the rest.
fn azure_seed() -> PlannedRead {
    PlannedRead {
        purpose: ReadPurpose::Overview,
        label: "az resource show".into(),
        program: String::new(),
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

fn load_plan(app: &AppHandle, cloud_id: &str, kind: &str) -> Result<Option<StoredPlan>, String> {
    let path = plan_path(app, cloud_id, kind)?;
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    parse_stored_plan(&text)
}

/// A plan file as an answer, or `None` when the file on disk cannot be one.
///
/// Two shapes have been written here. The object is an answer: the reads, the
/// facts a developer pastes, and whether it has been proved against a real
/// resource. The bare ARRAY an older build wrote is not - it was written before
/// facts existed, so it says nothing about them, and it is read as "nobody has
/// asked yet".
///
/// That is not tidiness. A plan file that exists is never asked about again,
/// and half of what a kind answers is its facts: measured on this machine
/// 2026-09-11, eight of the sixteen plans were in the old shape and so had no
/// facts at all - every AWS and Azure kind among them - and one of the eight
/// was `[]`, an empty array for `serviceusage.googleapis.com/Service`, which
/// could show nothing and could never be asked again. The cost of reading them
/// as unasked is one AI call per kind, once per machine.
fn parse_stored_plan(text: &str) -> Result<Option<StoredPlan>, String> {
    if let Ok(plan) = serde_json::from_str::<StoredPlan>(text) {
        return Ok(Some(plan));
    }
    serde_json::from_str::<Vec<PlannedRead>>(text)
        .map(|_| None)
        .map_err(|e| e.to_string())
}

fn store_plan(
    app: &AppHandle,
    cloud_id: &str,
    kind: &str,
    reads: &[PlannedRead],
    facts: &[ConnectionFact],
    proved: bool,
) -> Result<(), String> {
    let dir = plans_dir(app, cloud_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let plan = StoredPlan {
        reads: reads.to_vec(),
        facts: facts.to_vec(),
        proved,
    };
    let text = serde_json::to_string_pretty(&plan).map_err(|e| e.to_string())?;
    std::fs::write(plan_path(app, cloud_id, kind)?, text).map_err(|e| e.to_string())
}

/// The reads already checked for one kind, or `None` when nobody has asked yet.
///
/// Read from disk, so a kind planned in an earlier session costs nothing now -
/// and so the plan is per machine rather than per project: how to read a Lambda
/// function has nothing to do with which repository is open.
#[tauri::command]
pub fn cloud_read_plan(app: AppHandle, cloud_id: String, kind: String) -> Result<Option<StoredPlan>, String> {
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
///
/// Nothing is written to disk here. What this proves is that the CLI on this
/// machine HAS the command - which is not the same as the command working, and
/// the difference was costing a wrong answer per kind, for good (see
/// `cloud_prove_read`). The caller proves each read against the resource the
/// person opened and then calls `cloud_store_plan` with what survived.
#[tauri::command]
pub async fn cloud_check_reads(
    app: AppHandle,
    cloud_id: String,
    kind: String,
    proposed: Vec<PlannedRead>,
    facts: Vec<ConnectionFact>,
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
        match check_read(&program, &cloud_id, &kind, &read).await {
            Ok(checked) => reads.push(checked),
            Err(reason) => rejected.push(RejectedRead {
                label: read.label.clone(),
                reason,
                command: Some(read),
            }),
        }
    }
    let mut kept_facts: Vec<ConnectionFact> = Vec::new();
    for fact in facts {
        if kept_facts.len() >= FACTS_PER_KIND {
            break;
        }
        if kept_facts.iter().any(|kept| kept.value == fact.value) {
            continue;
        }
        match check_fact(&fact) {
            Ok(()) => kept_facts.push(fact),
            Err(reason) => rejected.push(RejectedRead {
                label: fact.label,
                reason,
                command: None,
            }),
        }
    }
    Ok(ReadPlan {
        reads,
        facts: kept_facts,
        rejected,
    })
}

/// Runs one candidate read against one real resource, to find out whether it
/// actually works - before it becomes this kind's answer on this machine.
///
/// Why this exists. Until 2026-09-11 a read was kept on the strength of
/// `gcloud <command> --help` exiting 0, and a plan is stored per KIND, so a
/// command that exists but cannot address the resource was the answer for every
/// resource of that kind until someone deleted the file. Measured over a real
/// Google account: `iam service-accounts describe <path>` exists, and answers
/// HTTP 404 for all 15 service accounts, because the command takes the
/// account's email and not its relative name; `logging buckets describe <path>
/// --location <region>` exists, and answers NOT_FOUND for all 26 log buckets.
/// Neither failure is visible to any check that does not run the command.
///
/// Two rules hold here. A `secret` read is never run - a credential is read
/// when a person asks for that one read by name, and proving a plan is not
/// asking - so it is kept on the grammar check alone. And the read is checked
/// again from scratch: a command line is built from what the frontend sent, so
/// it passes the same gate as a stored one rather than being trusted for having
/// been checked a moment ago.
#[tauri::command]
pub async fn cloud_prove_read(
    app: AppHandle,
    cloud_id: String,
    account: String,
    resource: CloudResource,
    read: PlannedRead,
) -> Result<Option<String>, String> {
    let program = super::program_for(&app, &cloud_id);
    // `check_planned`, not `check_read`: a plan read back from disk carries
    // Aime's own overview too, and a second trial run of it must not be refused
    // for the `--query` no model is allowed to write.
    let checked = check_planned(&program, &cloud_id, &resource.kind, &read).await?;
    if checked.purpose == ReadPurpose::Secret {
        return Ok(None);
    }
    run_read(&app, &cloud_id, &account, &resource, &checked)
        .await
        .map(Some)
}

/// Writes the plan the caller settled on, after proving it, and hands back what
/// was written.
///
/// Checked again rather than taken as given, for the reason `cloud_prove_read`
/// gives: this is the file every later session reads, and what reaches it comes
/// from the frontend. The answer is the stored plan rather than nothing,
/// because a kind with no overview left gains Aime's own read here and the
/// panel has to show what the file now holds.
#[tauri::command]
pub async fn cloud_store_plan(
    app: AppHandle,
    cloud_id: String,
    kind: String,
    reads: Vec<PlannedRead>,
    facts: Vec<ConnectionFact>,
    proved: bool,
) -> Result<Vec<PlannedRead>, String> {
    let program = super::program_for(&app, &cloud_id);
    let mut checked = Vec::with_capacity(reads.len());
    for read in reads {
        checked.push(check_planned(&program, &cloud_id, &kind, &read).await?);
    }
    // Aime's own read arrives here having never run, so the plan it joins is
    // not a proved one however the caller found the rest: the next resource of
    // this kind tries it for real, and a plan whose own read then fails is one
    // the panel can still put right. Measured in the app 2026-09-12 - stored
    // proved, a read broken by this machine's shell was that kind's answer for
    // good.
    let own = own_overview(&cloud_id, &checked);
    let proved = proved && own.is_none();
    checked.extend(own);
    for fact in &facts {
        check_fact(fact)?;
    }
    store_plan(&app, &cloud_id, &kind, &checked, &facts, proved)?;
    Ok(checked)
}

/// Aime's own overview read for a kind the AI could not give one for, or
/// `None` when the plan already has one or the cloud has no such read.
///
/// Written here, at the one place a plan is put on disk, so that it covers both
/// ways a kind ends up without an overview: a model that answered none because
/// the CLI genuinely has no command, and a model whose command was thrown out
/// after failing on a real resource. `cloud_run_read` will only run a read the
/// stored plan holds, so an overview that is not written down is not one the
/// panel can use.
fn own_overview(cloud_id: &str, reads: &[PlannedRead]) -> Option<PlannedRead> {
    if cloud_id != "gcp" || reads.iter().any(|read| read.purpose == ReadPurpose::Overview) {
        return None;
    }
    Some(super::gcp::asset_read())
}

/// One read held to what the CLI on this machine can run - unless it is Aime's
/// own, which is a constant in this binary and not something a model proposed.
async fn check_planned(
    program: &str,
    cloud_id: &str,
    kind: &str,
    read: &PlannedRead,
) -> Result<PlannedRead, String> {
    if super::gcp::is_asset_read(read) {
        return Ok(read.clone());
    }
    check_read(program, cloud_id, kind, read).await
}

/// Whether a connection fact is one Aime will show.
///
/// Three rules, and each of them is about honesty rather than safety, since a
/// fact runs nothing: it must be ABOUT this resource (so it has to carry at
/// least one placeholder - a constant string is a note, not a connection
/// detail), it must be something a person can paste (`is_safe_value`, the same
/// grammar a command's value has), and it must not claim to be a credential,
/// because a credential cannot be derived from a name. A model that answers
/// "API key: <name>" is guessing, and the panel would be showing a wrong
/// secret with a copy button next to it.
fn check_fact(fact: &ConnectionFact) -> Result<(), String> {
    let label = fact.label.trim();
    if label.is_empty() || label.len() > FACT_LABEL_LIMIT {
        return Err("a fact needs a short label".into());
    }
    if !PLACEHOLDERS.iter().any(|slot| fact.value.contains(slot)) {
        return Err(format!(
            "`{}` says the same thing for every resource of this kind, so it is not this one's \
             connection detail",
            fact.value
        ));
    }
    if !is_safe_value(&fact.value) {
        return Err(refuse_value(&fact.value));
    }
    if looks_sensitive(&[&label.to_lowercase()]) {
        return Err(format!(
            "`{label}` names a credential, and a credential cannot be worked out from a resource's \
             name - it takes a read"
        ));
    }
    Ok(())
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
    let planned = load_plan(&app, &cloud_id, &resource.kind)?
        .unwrap_or_default()
        .reads;
    if !planned.contains(&read) {
        return Err(format!(
            "`{}` is not a read Aime has checked for {}",
            read.label, resource.kind
        ));
    }
    run_read(&app, &cloud_id, &account, &resource, &read).await
}

/// One read as a command line, run against one resource.
///
/// Shared by the read a person asked for and the trial run that proves a plan,
/// so what is proved is the very command that will later run.
async fn run_read(
    app: &AppHandle,
    cloud_id: &str,
    account: &str,
    resource: &CloudResource,
    read: &PlannedRead,
) -> Result<String, String> {
    let account = account.to_string();
    let mut args: Vec<String> = read.args.iter().map(|arg| fill(arg, resource)).collect();
    let program = match program_of(cloud_id, &resource.kind, &read.program)? {
        // `bq` refuses a flag that stands after the command's own arguments -
        // *FATAL Flags positioning error*, measured - so its scope goes in
        // front, as the global flags its own usage line calls for.
        ReadProgram::Bq => {
            args.splice(0..0, bq::scope(&account));
            bq::PROGRAM.to_string()
        }
        ReadProgram::Main => match cloud_id {
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
                let cli = super::supabase::cli(app)?;
                args.extend(["--project-ref".into(), account, "-o".into(), "json".into()]);
                args.extend(cli.flags());
                cli.program().to_string()
            }
            other => return Err(format!("Aime has no checked reads for {other}")),
        },
    };
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    match read_cli_checked(&program, &borrowed).await {
        // Aime's own read searches, so it answers a list with the resource
        // inside it; every other read here answers the resource. The panel is
        // given the same thing either way.
        Ok(text) if super::gcp::is_asset_read(read) => super::gcp::resource_body(&text),
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
///
/// `<name>` is the name the CLI takes, not the label the panel shows: measured
/// 2026-09-11, a quarter of one real Google account's resources answer a
/// display name where the command wants an identifier, and filling from the
/// label produced `iam service-accounts describe Default compute service
/// account`. A resource that reached Aime before that field existed falls back
/// to its label, which is what it used to get.
fn fill(arg: &str, resource: &CloudResource) -> String {
    let name = if resource.cli_name.is_empty() {
        &resource.name
    } else {
        &resource.cli_name
    };
    arg.replace("<id>", &resource.id)
        .replace("<path>", path_of(&resource.id))
        .replace("<name>", name)
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
pub(super) async fn check_read(
    program: &str,
    cloud_id: &str,
    kind: &str,
    read: &PlannedRead,
) -> Result<PlannedRead, String> {
    check_read_allowing(program, cloud_id, kind, read, &[]).await
}

/// `check_read` for a caller that fills none of the placeholders and so lets
/// the plan carry some of the flags Aime otherwise adds - the deploy, whose
/// reads name their own `--region` because no resource is there to fill one.
///
/// `kind` is the resource kind the read is for, and empty for a caller that has
/// none: it decides nothing but which CLIs the read may run under, and no kind
/// means the cloud's own.
pub(super) async fn check_read_allowing(
    program: &str,
    cloud_id: &str,
    kind: &str,
    read: &PlannedRead,
    allowed: &[&str],
) -> Result<PlannedRead, String> {
    let runs_under = program_of(cloud_id, kind, &read.program)?;
    let args = split_joined_flags(&read.args);
    let line = match runs_under {
        ReadProgram::Bq => CommandLine::parse_single_word(&args)?,
        ReadProgram::Main => {
            let verbs =
                read_verbs_of(cloud_id).ok_or_else(|| format!("Aime does not check reads for {cloud_id}"))?;
            CommandLine::parse_allowing(&args, verbs, allowed)?
        }
    };
    match runs_under {
        ReadProgram::Bq => bq::check(&line.words).await?,
        ReadProgram::Main => match cloud_id {
            "aws" => check_aws(&line)?,
            "azure" => check_azure(&line).await?,
            "gcp" => check_gcloud(&line).await?,
            _ => check_supabase(program, &line).await?,
        },
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
        // The split form is what is kept, so the command shown, the command
        // stored and the command checked are one and the same.
        args,
        program: read.program.clone(),
    })
}

/// Which CLI a read runs under.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ReadProgram {
    /// The cloud's own: `az`, `aws`, `gcloud`, `supabase`.
    Main,
    /// `bq`, for the BigQuery kinds `gcloud` has no command for.
    Bq,
}

/// The CLI a read may run under, or why it may not.
///
/// The AI names it, so this is a gate and not a lookup: a second CLI is
/// accepted for the one service it belongs to, and refused for every other kind
/// and every other name. That is what keeps "the AI plans, Aime runs" true -
/// an answer naming a program cannot widen what Aime will run.
fn program_of(cloud_id: &str, kind: &str, named: &str) -> Result<ReadProgram, String> {
    if named.is_empty() {
        return Ok(ReadProgram::Main);
    }
    if named != bq::PROGRAM {
        return Err(format!(
            "Aime does not run `{named}`: a read runs under the cloud's own CLI, or under `bq` for a \
             BigQuery resource"
        ));
    }
    if cloud_id == "gcp" && bq::reads_kind(kind) {
        Ok(ReadProgram::Bq)
    } else {
        Err(format!(
            "`bq` reads BigQuery, and `{kind}` is not a BigQuery resource - its reads are `gcloud` commands"
        ))
    }
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

/// `--flag=value` as the two tokens the rest of this module reads.
///
/// Every CLI here takes both spellings, and a plan that used the joined one was
/// refused and sent back to the AI to be written again - measured 2026-09-11,
/// that is exactly what the repair round answered for a Firestore database
/// (`--database=<name>`), so the round after it was spent on punctuation. What
/// the checks need is the flag and its value apart, which is what this does;
/// the first `=` separates them, so `--filter=a=b` keeps its own `=`.
fn split_joined_flags(args: &[String]) -> Vec<String> {
    args.iter()
        .flat_map(|token| match token.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") && !value.is_empty() => {
                vec![flag.to_string(), value.to_string()]
            }
            _ => vec![token.clone()],
        })
        .collect()
}

/// Where a CLI takes the command's own arguments.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ArgumentOrder {
    /// `gcloud pubsub topics describe <name> --format json`: the argument
    /// belongs to the verb, and the flags follow it. A bare token after a
    /// flag that already has its value is then a mistake.
    PositionalsFirst,
    /// `bq show --schema <name>`: `bq` refuses any flag standing after the
    /// last argument - *FATAL Flags positioning error: Flag '--project_id'
    /// appears after final command line argument*, measured 2026-09-11 - so
    /// its arguments come last and a bare token after a flag is one of them.
    FlagsFirst,
}

impl<'a> CommandLine<'a> {
    /// Splits and vets the tokens of a CLI that takes its arguments before its
    /// flags; see `parse_ordered`.
    fn parse_allowing(args: &'a [String], read_verbs: &[&str], allowed: &[&str]) -> Result<Self, String> {
        Self::parse_ordered(args, read_verbs, allowed, ArgumentOrder::PositionalsFirst)
    }

    /// The line of a CLI whose command is a SINGLE word and whose flags come
    /// first: `bq show <name>`, `bq ls --max_results 50 <name>`.
    ///
    /// Everything after that word is an argument, so a word that is not a read
    /// comes back as the command it is and can be refused by name - where a
    /// tree-shaped parse would swallow `rm <name>` as a two-word command and
    /// complain about the wrong token. The verb that marks the boundary is
    /// therefore the first word itself.
    fn parse_single_word(args: &'a [String]) -> Result<Self, String> {
        let first = args.first().map_or("", String::as_str);
        Self::parse_ordered(args, &[first], &[], ArgumentOrder::FlagsFirst)
    }

    /// Splits and vets the tokens: the shape is fixed, the character sets are
    /// narrow, and anything else is refused with the token named. `read_verbs`
    /// are the CLI's own, so the parser knows where the command ends and its
    /// arguments begin, and `allowed` names the flags in `OWN_FLAGS` this
    /// caller does not add itself and therefore lets the plan carry (none, for
    /// a resource read).
    fn parse_ordered(
        args: &'a [String],
        read_verbs: &[&str],
        allowed: &[&str],
        order: ArgumentOrder,
    ) -> Result<Self, String> {
        if args.is_empty() {
            return Err("an empty command".into());
        }
        let mut words: Vec<&str> = Vec::new();
        let mut positionals = Vec::new();
        let mut flags: Vec<(&str, Option<&str>)> = Vec::new();
        for token in args {
            if let Some(flag) = token.strip_prefix("--") {
                if !is_flag_name(flag) {
                    return Err(format!("`{token}` is not a flag"));
                }
                if OWN_FLAGS.contains(&token.as_str()) && !allowed.contains(&token.as_str()) {
                    return Err(format!("`{token}` is Aime's to add"));
                }
                if REFUSED_FLAGS.contains(&token.as_str()) {
                    return Err(format!("`{token}` is not part of a read"));
                }
                flags.push((token.as_str(), None));
            } else if let Some((_, value @ None)) = flags.last_mut() {
                if !is_safe_value(token) {
                    return Err(refuse_value(token));
                }
                *value = Some(token.as_str());
            } else if !flags.is_empty() {
                if order == ArgumentOrder::PositionalsFirst {
                    return Err(format!("`{token}` follows a flag that already has a value"));
                }
                if !is_safe_value(token) {
                    return Err(refuse_value(token));
                }
                positionals.push(token.as_str());
            } else if words
                .last()
                .is_some_and(|last| starts_with_a_verb(last, read_verbs))
            {
                if !is_safe_value(token) {
                    return Err(refuse_value(token));
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
pub(super) fn is_command_word(word: &str) -> bool {
    let mut chars = word.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && word
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

/// A flag's name: a command word, and an underscore as well.
///
/// `bq` spells its flags the way Python's flag library does - `--project_id`,
/// `--max_results` - and no command word here holds an underscore, so the two
/// stay separate rules rather than one loose one.
fn is_flag_name(name: &str) -> bool {
    is_command_word(&name.replace('_', "-"))
}

/// A value the CLI can be handed on any platform.
///
/// Placeholders are cut out first, so `https://sqs.<region>.amazonaws.com/<group>/<name>`
/// passes as the URL it becomes. What remains may hold letters, digits and the
/// punctuation identifiers and URLs are made of - nothing a shell reads as
/// structure, because on Windows `az` is a batch shim and every argument goes
/// through cmd.exe's parser.
/// Why a value cannot be used, in the words that say how to fix it.
///
/// A model that invents its own placeholder is the common case and was worth
/// telling apart: measured 2026-09-11, a key read came back as `iam
/// service-accounts keys describe <name> --iam-account <account-id>`, and
/// "holds something a shell could misread" is a true sentence that explains
/// nothing - the fix is to use one of the five slots Aime fills.
fn refuse_value(value: &str) -> String {
    if value.contains('<') {
        return format!(
            "`{value}` uses a placeholder Aime does not fill. The placeholders are {}",
            PLACEHOLDERS.join(", ")
        );
    }
    format!("`{value}` holds something a shell could misread")
}

pub(super) fn is_safe_value(value: &str) -> bool {
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
    let help = read_cli_checked("gcloud", &args).await.map_err(|_| {
        format!(
            "`gcloud {}` is not a command the Google Cloud CLI here knows",
            line.words.join(" ")
        )
    })?;
    refuse_missing_required(&help, line)?;
    refuse_unwanted_positional(&help, line)
}

/// Refuses a command that leaves out a flag the CLI itself says is required.
///
/// Reported 2026-09-10: `gcloud logging buckets describe <path>` was kept as a
/// LogBucket's overview read and every run of it answered *argument
/// --location: Must be specified*. The command existed, which is all the
/// `--help` exit code proves - and the plan is stored per kind, so one missing
/// flag is every resource of that kind, for good.
///
/// The CLI says which flags are required in its own SYNOPSIS: what is optional
/// stands inside `[...]`, what is a choice stands inside `(...)`, and what is
/// required stands bare - measured on this machine, `gcloud logging buckets
/// describe BUCKET_ID --location=LOCATION [--billing-account=… | …]`. So a flag
/// named at bracket depth zero has to be on the line.
fn refuse_missing_required(help: &str, line: &CommandLine<'_>) -> Result<(), String> {
    for flag in required_flags(help) {
        if !line.flags.iter().any(|(named, _)| *named == flag) {
            return Err(format!(
                "`gcloud {}` needs `{flag}`, which this command does not pass. Its synopsis: {}",
                line.words.join(" "),
                synopsis(help)
            ));
        }
    }
    Ok(())
}

/// Refuses a command handed a positional it does not take.
///
/// The mirror of the rule above, and found the same way - by running the plans
/// against real resources on 2026-09-11: `gcloud firestore databases describe
/// <name>` answered *unrecognized arguments: (default)* for every database,
/// because that command takes its database in `--database` and no positional at
/// all. The synopsis says so plainly, and an argument the command cannot take
/// is as provable as a flag it must have.
///
/// A synopsis names its positionals in capitals, and the value of a flag is
/// written after `=`, so what is left standing alone is a positional -
/// `pubsub topics describe TOPIC`, `run services describe (SERVICE :
/// --namespace=NAMESPACE)` - while `firestore databases describe
/// [--database=DATABASE]` has none. `GCLOUD_WIDE_FLAG` is every command's
/// footer, not an argument.
fn refuse_unwanted_positional(help: &str, line: &CommandLine<'_>) -> Result<(), String> {
    if line.positionals.is_empty() || takes_a_positional(help) {
        return Ok(());
    }
    Err(format!(
        "`gcloud {}` takes no positional argument, and this command passes `{}`. Its synopsis: {}",
        line.words.join(" "),
        line.positionals.join(" "),
        synopsis(help)
    ))
}

/// Whether the synopsis names an argument that is not a flag's value.
fn takes_a_positional(help: &str) -> bool {
    let block = synopsis_block(help);
    let mut previous_was_equals = false;
    for word in block.split_whitespace() {
        let bare = word.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_');
        let is_placeholder = !bare.is_empty()
            && bare != "GCLOUD_WIDE_FLAG"
            && bare
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch == '_' || ch.is_ascii_digit());
        if is_placeholder && !previous_was_equals && !word.contains('=') {
            return true;
        }
        previous_was_equals = word.ends_with('=');
    }
    false
}

/// The synopsis on one line, short enough to put in a refusal a person reads -
/// and in the prompt that asks the AI to write the command again.
fn synopsis(help: &str) -> String {
    let text = synopsis_block(help)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.len() <= SYNOPSIS_SHOWN {
        text
    } else {
        format!("{}…", &text[..SYNOPSIS_SHOWN])
    }
}

/// How much of a synopsis a refusal carries.
const SYNOPSIS_SHOWN: usize = 220;

/// The SYNOPSIS section of a `--help`, whole: the one indented block after the
/// heading, since the blank line that follows it starts DESCRIPTION.
fn synopsis_block(help: &str) -> String {
    help.replace('\r', "")
        .split("SYNOPSIS")
        .nth(1)
        .map(|after| {
            after
                .trim_start_matches('\n')
                .split("\n\n")
                .next()
                .unwrap_or_default()
                .to_string()
        })
        .unwrap_or_default()
}

/// The flags the SYNOPSIS names outside any bracket, i.e. the required ones.
fn required_flags(help: &str) -> Vec<String> {
    let block: Vec<char> = synopsis_block(help).chars().collect();

    let mut flags: Vec<String> = Vec::new();
    let mut depth = 0_i32;
    let mut at = 0;
    while at < block.len() {
        match block[at] {
            '[' | '(' => depth += 1,
            ']' | ')' => depth -= 1,
            '-' if depth <= 0 && block.get(at + 1) == Some(&'-') => {
                let name: String = block[at..]
                    .iter()
                    .take_while(|ch| ch.is_ascii_alphanumeric() || **ch == '-')
                    .collect();
                at += name.chars().count();
                if name.len() > 2 && !flags.contains(&name) {
                    flags.push(name);
                }
                continue;
            }
            _ => {}
        }
        at += 1;
    }
    flags
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
        let parsed = CommandLine::parse_allowing(&tokens, &AWS_READ_VERBS, &[]).expect("parsed");
        assert_eq!(parsed.words, ["lambda", "get-function"]);
        assert_eq!(parsed.flags, [("--function-name", Some("<name>"))]);
        assert!(parsed.positionals.is_empty());

        // A flag with no value is a switch, and the next flag starts fresh.
        let tokens = args("ssm get-parameter --with-decryption --name <name>");
        let parsed = CommandLine::parse_allowing(&tokens, &AWS_READ_VERBS, &[]).expect("parsed");
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
        let parsed = CommandLine::parse_allowing(&tokens, &GCLOUD_READ_VERBS, &[]).expect("parsed");
        assert_eq!(parsed.words, ["compute", "instances", "describe"]);
        assert_eq!(parsed.positionals, ["<path>"]);

        let tokens = args("secrets versions access latest --secret <name>");
        let parsed = CommandLine::parse_allowing(&tokens, &GCLOUD_READ_VERBS, &[]).expect("parsed");
        assert_eq!(parsed.words, ["secrets", "versions", "access"]);
        assert_eq!(parsed.positionals, ["latest"]);
        assert_eq!(parsed.flags, [("--secret", Some("<name>"))]);

        let tokens = args("storage buckets describe gs://<name>");
        let parsed = CommandLine::parse_allowing(&tokens, &GCLOUD_READ_VERBS, &[]).expect("parsed");
        assert_eq!(parsed.positionals, ["gs://<name>"]);

        for refused in [
            "compute <path> describe",
            "compute instances describe <path>;",
            "compute instances describe --zone <region> <path>",
        ] {
            assert!(
                CommandLine::parse_allowing(&args(refused), &GCLOUD_READ_VERBS, &[]).is_err(),
                "{refused}"
            );
        }
        // The AWS CLI takes every argument as a flag, so a positional there is
        // a command the CLI will refuse with a usage block - refused earlier.
        let tokens = args("lambda get-function <name>");
        let parsed = CommandLine::parse_allowing(&tokens, &AWS_READ_VERBS, &[]).expect("parsed");
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
                CommandLine::parse_allowing(&args(line), &AZURE_READ_VERBS, &[]).is_err(),
                "{line} should be refused"
            );
        }
        // Placeholders inside a URL are what SQS needs, and that is fine.
        assert!(is_safe_value("https://sqs.<region>.amazonaws.com/<group>/<name>"));
        // A slot Aime does not fill would be passed to the CLI as those very
        // characters, and the refusal says which slots there are.
        assert!(!is_safe_value("<account-id>"));
        let refused = refuse_value("<account-id>");
        assert!(refused.contains("placeholder Aime does not fill"), "{refused}");
        assert!(refused.contains("<name>"), "{refused}");
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
            assert!(
                CommandLine::parse_allowing(&args(line), verbs, &[]).is_err(),
                "{line}"
            );
        }
        // A flag Aime adds itself is refused in the joined spelling too, since
        // that is the same flag.
        assert!(CommandLine::parse_allowing(
            &split_joined_flags(&args("compute instances describe <path> --project=shop-prod")),
            &GCLOUD_READ_VERBS,
            &[]
        )
        .is_err());
    }

    /// Every CLI here takes `--flag=value`, and the checks need the flag and
    /// its value apart. Refusing the joined spelling cost a repair round for
    /// punctuation alone: measured 2026-09-11, the AI's own fix for a Firestore
    /// database came back as `--database=<name>`.
    #[test]
    fn a_flag_joined_to_its_value_is_read_as_the_two_it_means() {
        assert_eq!(
            split_joined_flags(&args("firestore databases describe --database=<name>")),
            args("firestore databases describe --database <name>")
        );
        // The first `=` separates; a value with its own `=` keeps it.
        assert_eq!(
            split_joined_flags(&args("logging read --filter=severity=ERROR")),
            args("logging read --filter severity=ERROR")
        );
        // Not a flag, not touched.
        assert_eq!(
            split_joined_flags(&args("pubsub topics describe a=b")),
            args("pubsub topics describe a=b")
        );

        let tokens = split_joined_flags(&args("logging buckets describe <name> --location=<region>"));
        let parsed = CommandLine::parse_allowing(&tokens, &GCLOUD_READ_VERBS, &[]).expect("parsed");
        assert_eq!(parsed.positionals, ["<name>"]);
        assert_eq!(parsed.flags, [("--location", Some("<region>"))]);
    }

    /// Only the ending decides, and only these endings read: `gcloud compute
    /// instances delete` and `gcloud run deploy` are refused before the CLI is
    /// ever asked, and so is `export`, which writes a file.
    #[test]
    fn a_caller_that_fills_no_placeholder_may_let_the_plan_name_the_region() {
        let tokens = args("run services describe web --region asia-southeast1");
        assert!(
            CommandLine::parse_allowing(&tokens, &GCLOUD_READ_VERBS, &[]).is_err(),
            "a resource read gets its region from the resource"
        );
        let parsed = CommandLine::parse_allowing(&tokens, &GCLOUD_READ_VERBS, &["--region"]).expect("parsed");
        assert_eq!(parsed.flags, vec![("--region", Some("asia-southeast1"))]);
        assert!(
            CommandLine::parse_allowing(
                &args("run services describe web --project p"),
                &GCLOUD_READ_VERBS,
                &["--region"]
            )
            .is_err(),
            "the allowance is per flag"
        );
    }

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
        assert!(CommandLine::parse_allowing(
            &args("functions list --project-ref abc"),
            &SUPABASE_READ_VERBS,
            &[]
        )
        .is_err());
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
            cli_name: "web-1".into(),
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
    /// Measured 2026-09-11 on a real Google account: a service account's
    /// display name is `Default compute service account` and `gcloud` addresses
    /// it by its email, so a command line built from the label cannot run - and
    /// 15 of them did not. A resource from before that field existed falls back
    /// to the label, which is exactly what it used to get.
    #[test]
    fn a_command_gets_the_name_the_cli_takes_and_never_the_label() {
        let mut account = CloudResource {
            id: "//iam.googleapis.com/projects/p/serviceAccounts/svc@p.iam.gserviceaccount.com".into(),
            name: "Default compute service account".into(),
            cli_name: "svc@p.iam.gserviceaccount.com".into(),
            kind: "iam.googleapis.com/ServiceAccount".into(),
            location: "global".into(),
            group: "p".into(),
            tags: Default::default(),
        };
        assert_eq!(fill("<name>", &account), "svc@p.iam.gserviceaccount.com");
        assert_eq!(
            fill("<path>", &account),
            "projects/p/serviceAccounts/svc@p.iam.gserviceaccount.com"
        );

        account.cli_name = String::new();
        assert_eq!(fill("<name>", &account), "Default compute service account");
    }

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
            let parsed = CommandLine::parse_allowing(&tokens, &AWS_READ_VERBS, &[]).expect("parsed");
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
            cli_name: "orders".into(),
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

    /// Three synopses captured from `gcloud … --help` on this machine
    /// 2026-09-10. The first is the one that caused the bug: the command
    /// existed, so the `--help` exit code passed it, and every run of the
    /// stored plan answered *argument --location: Must be specified*.
    #[test]
    fn a_flag_the_cli_calls_required_is_read_out_of_its_own_synopsis() {
        let bucket = "NAME\n    gcloud logging buckets describe - display information about a bucket\n\nSYNOPSIS\n    gcloud logging buckets describe BUCKET_ID --location=LOCATION\n        [--billing-account=BILLING_ACCOUNT_ID | --folder=FOLDER_ID\n          | --organization=ORGANIZATION_ID | --project=PROJECT_ID]\n        [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n    Display information about a bucket.\n";
        assert_eq!(required_flags(bucket), ["--location"]);

        // Nothing required: a topic takes only its name.
        let topic =
            "SYNOPSIS\n    gcloud pubsub topics describe TOPIC [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n";
        assert!(required_flags(topic).is_empty());

        // A flag inside `( … )` is one side of a choice, not a requirement,
        // and `[--region]` is plainly optional.
        let service = "SYNOPSIS\n    gcloud run services describe (SERVICE : --namespace=NAMESPACE)\n        [--region=REGION] [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n";
        assert!(required_flags(service).is_empty());

        assert!(required_flags("no synopsis here").is_empty());
    }

    /// The other half of the same reading, found the same way: running the
    /// plans against real resources on 2026-09-11 caught `gcloud firestore
    /// databases describe <name>` answering *unrecognized arguments:
    /// (default)* for every database. Every synopsis here was captured from
    /// this machine's own `gcloud`.
    #[test]
    fn a_positional_the_cli_does_not_take_is_read_out_of_its_own_synopsis() {
        let firestore = "SYNOPSIS\n    gcloud firestore databases describe\n        [--database=DATABASE; default=\"(default)\"] [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n";
        assert!(!takes_a_positional(firestore));

        // Every flag's value is written after `=`, so none of these is one.
        let keys = "SYNOPSIS\n    gcloud iam service-accounts keys list --iam-account=IAM_ACCOUNT\n        [--created-before=CREATED_BEFORE]\n        [--managed-by=MANAGED_BY; default=\"any\"] [--filter=EXPRESSION]\n        [--limit=LIMIT] [--page-size=PAGE_SIZE] [--sort-by=[FIELD,...]]\n        [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n";
        assert!(!takes_a_positional(keys));

        // `GCLOUD_WIDE_FLAG` is every command's footer, not an argument.
        let app = "SYNOPSIS\n    gcloud app describe [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n";
        assert!(!takes_a_positional(app));

        let topic =
            "SYNOPSIS\n    gcloud pubsub topics describe TOPIC [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n";
        assert!(takes_a_positional(topic));

        // One inside a choice group still is one, which is how Cloud Run
        // spells a service that can be named or scoped.
        let service = "SYNOPSIS\n    gcloud run services describe (SERVICE : --namespace=NAMESPACE)\n        [--region=REGION] [GCLOUD_WIDE_FLAG ...]\n\nDESCRIPTION\n";
        assert!(takes_a_positional(service));

        let refused = refuse_unwanted_positional(
            firestore,
            &CommandLine::parse_allowing(
                &args("firestore databases describe <name>"),
                &GCLOUD_READ_VERBS,
                &[],
            )
            .expect("a read"),
        )
        .expect_err("a positional this command cannot take");
        assert!(refused.contains("takes no positional"), "{refused}");
        // The synopsis travels with the refusal, because it is what the AI
        // needs to write the command again.
        assert!(refused.contains("[--database=DATABASE"), "{refused}");

        assert!(refuse_unwanted_positional(
            topic,
            &CommandLine::parse_allowing(&args("pubsub topics describe <name>"), &GCLOUD_READ_VERBS, &[])
                .expect("a read"),
        )
        .is_ok());
    }

    /// A fact is the resource's own identity written the way an SDK takes it.
    /// Every case here is a shape that came out of a real Google account
    /// (2026-09-10), or a way a model can get one wrong.
    #[test]
    fn a_connection_fact_has_to_be_about_this_resource_and_cannot_be_a_credential() {
        let fact = |label: &str, value: &str| {
            check_fact(&ConnectionFact {
                label: label.to_string(),
                value: value.to_string(),
            })
        };
        assert!(fact("Topic path", "projects/<group>/topics/<name>").is_ok());
        assert!(fact("Bucket URI", "gs://<name>").is_ok());
        assert!(fact("Dataset id", "<group>.<name>").is_ok());
        assert!(fact("Endpoint", "https://<name>-<region>.run.app").is_ok());

        let constant = fact("Docs", "https://cloud.google.com/pubsub").expect_err("no placeholder");
        assert!(
            constant.contains("every resource of this kind"),
            "the refusal says why: {constant}"
        );

        // A credential cannot be worked out from a name; offering one with a
        // copy button beside it would be offering a wrong secret.
        for label in ["API key", "Password", "Access token", "Connection credential"] {
            let refused = fact(label, "<name>").expect_err("a credential is not a fact");
            assert!(refused.contains("it takes a read"), "{label}: {refused}");
        }

        assert!(fact("", "<name>").is_err(), "a fact needs a label");
        assert!(fact(&"x".repeat(FACT_LABEL_LIMIT + 1), "<name>").is_err());
        assert!(
            fact("Shell trouble", "gs://<name>;rm -rf /").is_err(),
            "a value is pasted by a person and must not read as shell"
        );
    }

    /// A plan file written before facts existed is read as a kind nobody has
    /// asked about - the only reading that lets its facts ever arrive.
    #[test]
    fn a_plan_file_from_an_older_build_is_asked_again() {
        let old = r#"[{"purpose":"overview","label":"gcloud pubsub topics describe","args":["pubsub","topics","describe","<name>"]}]"#;
        assert_eq!(
            parse_stored_plan(old).expect("the old array shape is still valid json"),
            None,
            "a file that predates facts says nothing about them"
        );

        // The file this found: an empty array, which shows nothing at all and
        // which no later open could ever have replaced.
        assert_eq!(parse_stored_plan("[]").expect("valid json"), None);

        let now = r#"{"reads":[],"facts":[{"label":"Topic path","value":"projects/<group>/topics/<name>"}]}"#;
        let parsed = parse_stored_plan(now)
            .expect("the object shape")
            .expect("an answer");
        assert_eq!(parsed.facts[0].label, "Topic path");
        assert!(
            !parsed.proved,
            "a file without the field is unproved, and proved again on the next open"
        );

        // An answer with nothing in it is still an answer once this build has
        // asked - a kind `gcloud` has no read and no fact for is written as
        // empty lists, and re-asking that on every open would buy nothing.
        assert_eq!(
            parse_stored_plan(r#"{"reads":[],"facts":[],"proved":true}"#).expect("the object shape"),
            Some(StoredPlan {
                reads: Vec::new(),
                facts: Vec::new(),
                proved: true,
            })
        );

        assert!(parse_stored_plan("not json").is_err());
    }

    /// The gate on the second CLI: `bq` for BigQuery, and nothing else
    /// anywhere. The AI names the program, so this is the whole of what keeps
    /// its answer from widening what Aime will run.
    #[test]
    fn a_second_cli_is_allowed_for_the_one_service_it_reads() {
        assert_eq!(
            program_of("gcp", "bigquery.googleapis.com/Dataset", "bq"),
            Ok(ReadProgram::Bq)
        );
        assert_eq!(
            program_of("gcp", "pubsub.googleapis.com/Topic", ""),
            Ok(ReadProgram::Main)
        );
        assert_eq!(program_of("aws", "lambda/function", ""), Ok(ReadProgram::Main));

        let wrong_kind = program_of("gcp", "pubsub.googleapis.com/Topic", "bq").expect_err("not BigQuery");
        assert!(wrong_kind.contains("is not a BigQuery resource"), "{wrong_kind}");

        let wrong_cloud =
            program_of("aws", "bigquery.googleapis.com/Dataset", "bq").expect_err("not Google Cloud");
        assert!(
            wrong_cloud.contains("is not a BigQuery resource"),
            "{wrong_cloud}"
        );

        for named in ["gsutil", "firebase", "sh", "python"] {
            let refused = program_of("gcp", "bigquery.googleapis.com/Dataset", named)
                .expect_err("only the CLIs Aime knows");
            assert!(refused.contains(named), "the refusal names it: {refused}");
        }
    }

    /// `bq` is one command word and then its arguments, and its flags carry
    /// underscores - which no `gcloud`, `az` or `aws` flag does, and which the
    /// parser refused as "not a flag" until it was measured.
    #[test]
    fn a_kind_left_without_an_overview_gains_aimes_own_and_one_that_has_it_does_not() {
        let overview = PlannedRead {
            purpose: ReadPurpose::Overview,
            label: "gcloud run services describe".to_string(),
            args: args("run services describe <name>"),
            program: String::new(),
        };
        let secret = PlannedRead {
            purpose: ReadPurpose::Secret,
            label: "gcloud iam service-accounts keys list".to_string(),
            args: args("iam service-accounts keys list --iam-account <name>"),
            program: String::new(),
        };
        assert_eq!(own_overview("gcp", &[overview]), None, "it already reads");
        assert_eq!(
            own_overview("gcp", &[secret]),
            Some(super::super::gcp::asset_read()),
            "a plan of secrets alone still owes an overview"
        );
        assert_eq!(own_overview("gcp", &[]), Some(super::super::gcp::asset_read()));
        // And what it adds is not an overview twice over: asked again about the
        // plan it joined, it adds nothing, which is what lets a plan settle.
        let own = super::super::gcp::asset_read();
        assert_eq!(own_overview("gcp", &[own]), None);
        // Cloud Asset Inventory is Google Cloud's; the other three clouds say
        // so themselves when they have no read.
        for elsewhere in ["aws", "azure", "supabase"] {
            assert_eq!(own_overview(elsewhere, &[]), None, "{elsewhere} has no such API");
        }
    }

    #[test]
    fn aimes_own_read_names_the_resource_the_search_syntax_wants() {
        let ruleset = CloudResource {
            name: "5a083fea-74e8-4d9f-98b8-3d6e994fe606".to_string(),
            cli_name: "5a083fea-74e8-4d9f-98b8-3d6e994fe606".to_string(),
            kind: "firebaserules.googleapis.com/Ruleset".to_string(),
            location: String::new(),
            group: "intense-hour-239401".to_string(),
            tags: Default::default(),
            id: "//firebaserules.googleapis.com/projects/intense-hour-239401/rulesets/                 5a083fea-74e8-4d9f-98b8-3d6e994fe606"
                .replace(' ', ""),
        };
        let filled: Vec<String> = super::super::gcp::asset_read()
            .args
            .iter()
            .map(|arg| fill(arg, &ruleset))
            .collect();
        assert!(filled.contains(&"projects/intense-hour-239401".to_string()));
        // `<id>` and not `<path>`: the search matches the whole resource name,
        // `//service/…` and all, which is the one form `<path>` strips.
        assert!(
            filled.contains(&format!("name={}", ruleset.id)),
            "filled as {filled:?}"
        );
    }

    #[test]
    fn a_bigquery_command_line_is_one_word_and_may_carry_underscored_flags() {
        let tokens = args("show <name>");
        let parsed = CommandLine::parse_single_word(&tokens).expect("parsed");
        assert_eq!(parsed.words, ["show"]);
        assert_eq!(parsed.positionals, ["<name>"]);

        let tokens = args("ls --max_results 50 <name>");
        let parsed = CommandLine::parse_single_word(&tokens).expect("parsed");
        assert_eq!(parsed.flags, [("--max_results", Some("50"))]);

        // `--project_id` is `bq`'s spelling of the scope Aime adds, so a plan
        // may not carry it any more than it may carry `--project`.
        let tokens = args("show --project_id <group> <name>");
        let refused = CommandLine::parse_single_word(&tokens)
            .err()
            .expect("`--project_id` is Aime's to add");
        assert!(refused.contains("`--project_id` is Aime's to add"), "{refused}");

        assert!(is_flag_name("max_results"));
        assert!(
            !is_flag_name("_leading"),
            "a flag name still starts with a letter"
        );
        assert!(
            !is_command_word("max_results"),
            "a command word holds no underscore, and the two rules stay apart"
        );
    }

    #[test]
    fn a_kind_becomes_one_file_name_per_kind() {
        assert_eq!(file_of_kind("Microsoft.Web/sites"), "microsoft.web_sites.json");
        assert_eq!(file_of_kind("lambda/function"), "lambda_function.json");
        assert_eq!(file_of_kind("sqs"), "sqs.json");
        assert_eq!(file_of_kind("ecs/task-definition"), "ecs_task-definition.json");
    }
}
