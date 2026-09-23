//! Deploying the open project to a cloud: the AI plans, Aime checks, a person
//! confirms, Aime runs and proves.
//!
//! Why the AI never holds the CLI here. Measured 2026-09-06: Claude Code's plan
//! mode - the "read-only" level every analysing turn runs at - still executed a
//! command through its Bash tool. Plan mode forbids edits, not commands, and a
//! command can be `gcloud run services delete`. So a deploy is the reads of
//! `reads.rs` one layer up: the AI writes argument lists, this module proves
//! each one against the CLI's own help and against rules of its own, the
//! person sees every line exactly as it will run, and Aime spawns them itself
//! with the scope pinned (`--project`, `--account`) and no shell in between.
//!
//! The rule that keeps a running service's settings. In gcloud's own
//! convention `--set-env-vars` replaces every variable the service has,
//! `--update-env-vars` merges, `--clear-*` wipes and `--remove-*` deletes. When
//! the target already exists, every `--set-*`, `--clear-*` and `--remove-*` flag
//! is refused with its `--update-*` counterpart named - so "do not override the
//! settings already on the cloud" is a refusal, not a sentence in a prompt. And
//! after the last step Aime reads the settings the plan promised to keep and
//! compares them with what it read before (`lib/deploy.ts` does the comparing;
//! this module runs the reads).
//!
//! One arm per CLI that has been measured. What differs between them - the
//! scope flags, the groups a deployment may not enter, the flag family that
//! overwrites a running service, the grant that is fenced rather than refused,
//! and even the token that asks the CLI whether it knows a command - is a table
//! in `dialect.rs`, and this module reads the table. A cloud with no table gets
//! no button anywhere, because a button offering a command Aime cannot check is
//! worse than no button.
//!
//! Having a table is not the same as having a Deploy button. This checker is
//! also what stands behind the operations on one resource
//! (`components/CloudOps.tsx`), and proving a single command is a far smaller
//! claim than planning a whole deployment: the second needs a cloud's own idea
//! of a plan in the prompt and a deployment that has actually run. All four
//! clouds have both since 2026-09-22 (`lib/deployDialect.ts` holds that split).

use super::dialect::{Dialect, Grant, Proof};
use super::reads::{check_read_allowing, is_command_word, is_safe_value, PlannedRead};
use super::{k8s, program_for, quiet, read_cli_checked, CloudAccount};
use crate::exec::{run_program, CommandOutcome, ExecState};
use crate::program::Program;
use crate::providers::cli_command;
use crate::trackers::connector::TrackerError;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

/// One command the deploy runs, in the AI's plan.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployStep {
    /// What the step is for, in a person's words.
    pub label: String,
    /// Arguments after the program name, one token each.
    pub args: Vec<String>,
    /// What the step changes on the cloud, so the confirm page can say it.
    pub changes: String,
    /// Which CLI runs this step; empty for the cloud's own.
    ///
    /// A cloud is not always one CLI, here as in a read (`reads::PlannedRead::
    /// program`). `gcloud` creates a GKE cluster and cannot put a workload in
    /// one, so a Kubernetes step says `kubectl` and `k8s.rs` is the gate that
    /// decides whether it may.
    #[serde(default)]
    pub program: String,
}

/// A setting the plan promises to leave as it is: a read, and where in its
/// answer the setting sits.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeepRead {
    pub label: String,
    pub read: PlannedRead,
    /// Dotted path into the read's JSON answer (`spec.template.spec.containers.0.env`).
    pub path: String,
}

/// How the deployment is proved: the read that answers the service's URL, and
/// what to ask it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProveRead {
    pub read: PlannedRead,
    /// Dotted path to the URL in the read's JSON answer (`status.url`).
    pub url_path: String,
    /// The path requested on that URL (`/`, `/healthz`).
    pub path: String,
    /// The HTTP status that means "running".
    pub expect: u16,
    /// The scheme the endpoint answers on when the read hands back a bare host;
    /// `https` for every managed front end, `http` for an L4 LoadBalancer
    /// address, which carries no certificate.
    #[serde(default)]
    pub scheme: String,
}

/// The plan as the AI wrote it.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployPlan {
    pub steps: Vec<DeployStep>,
    pub keep: Vec<KeepRead>,
    pub prove: Option<ProveRead>,
}

/// Which part of a plan a refusal is about.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanPart {
    Step,
    Keep,
    Prove,
}

/// One thing Aime would not keep, and why - in words the AI is asked to act on.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rejected {
    pub part: PlanPart,
    pub label: String,
    pub reason: String,
}

/// What survived the check, and what did not.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckedPlan {
    pub steps: Vec<DeployStep>,
    pub keep: Vec<KeepRead>,
    pub prove: Option<ProveRead>,
    pub rejected: Vec<Rejected>,
}

/// What one HTTP request to the deployed service came back with.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub status: u16,
    pub duration_ms: u64,
    /// The first lines of the body, for the log and for the AI when it failed.
    pub body_head: String,
}

/// The location flags a deploy's reads name themselves. A resource read gets
/// its `<region>` filled from the resource; here there is no resource, and
/// `gcloud run services describe` without a region asks a question nobody is
/// there to answer (seen in the first real plan, 2026-09-06: the read checker
/// refused `--region`, the AI dropped it, and the command would have failed).
const LOCATION_FLAGS: [&str; 3] = ["--region", "--zone", "--location"];

/// A deploy's reads are not about a kind of resource, so they run under the
/// cloud's own CLI and under no other - see `reads::program_of`.
const NO_KIND: &str = "";

/// Command words no DEPLOYMENT needs. A deploy creates and updates; removing
/// something is a separate, deliberate act.
///
/// The resource panel's operations go through this same checker with
/// `removal` set, because deleting a resource IS day-to-day work and refusing
/// it outright only sends someone to the web console to do it with less
/// ceremony than Aime can offer: there the command is shown in full first, and
/// the person has to type the resource's own name before the button works
/// (`components/CloudOps.tsx`).
///
/// `rm` and `rb` are here because AWS spells removal as its own commands:
/// `aws s3 rm s3://bucket/key` and `aws s3 rb s3://bucket` say nothing that
/// matches the words above, and both take something away.
const REFUSED_WORDS: [&str; 7] = ["delete", "destroy", "undelete", "purge", "abandon", "rm", "rb"];

/// The same words where a CLI writes them as one hyphenated operation.
///
/// `gcloud` and `az` put the verb last (`az group delete`), which the whole
/// word above catches. Every AWS API operation is one word - `delete-bucket`,
/// `delete-stack`, `terminate-instances` - so without these a deployment could
/// take away what it never made.
const REFUSED_WORD_PREFIXES: [&str; 5] = ["remove-", "delete-", "destroy-", "terminate-", "purge-"];

/// How long one step may run. A source deploy builds in Cloud Build; twenty
/// minutes is generous for it and still ends a hang unattended.
const STEP_TIMEOUT_MS: u64 = 20 * 60 * 1000;

/// How much of a probe's body is kept: enough to see an error page's title.
const BODY_HEAD: usize = 2_000;

/// Checks a plan against the CLI and the rules above. `existing` says whether
/// the target already runs, which is what makes an overriding flag a refusal.
///
/// Never fails for a plan the AI could have written better: every problem lands
/// in `rejected` with the words the AI is asked to act on. It fails only for a
/// cloud this module cannot deploy to.
#[tauri::command]
pub async fn cloud_check_deploy(
    app: AppHandle,
    cloud_id: String,
    existing: bool,
    plan: DeployPlan,
    removal: Option<bool>,
    deploying: Option<bool>,
) -> Result<CheckedPlan, String> {
    let dialect = Dialect::of(&cloud_id).ok_or_else(|| format!("Aime does not deploy to {cloud_id} yet"))?;
    let removal = removal.unwrap_or(false);
    // Absent means work on a resource, which is the stricter reading.
    let deploying = deploying.unwrap_or(false);
    let program = program_for(&app, &cloud_id);
    let mut checked = CheckedPlan::default();
    for step in plan.steps {
        // Which CLI first: a step Aime will not run under any program is
        // refused before its command line is read, and the reason says which
        // programs there are rather than complaining about the words.
        let checked_step = match step_program(&cloud_id, &program, dialect, &step) {
            Ok(runs_under) => check_step(&runs_under, dialect, &step, existing, removal, deploying).await,
            Err(reason) => Err(reason),
        };
        match checked_step {
            Ok(()) => checked.steps.push(step),
            Err(reason) => checked.rejected.push(Rejected {
                part: PlanPart::Step,
                label: step.label,
                reason,
            }),
        }
    }
    for keep in plan.keep {
        match check_read_allowing(&program, &cloud_id, NO_KIND, &keep.read, &LOCATION_FLAGS).await {
            Ok(read) => checked.keep.push(KeepRead { read, ..keep }),
            Err(reason) => checked.rejected.push(Rejected {
                part: PlanPart::Keep,
                label: keep.label,
                reason,
            }),
        }
    }
    if let Some(prove) = plan.prove {
        match check_read_allowing(&program, &cloud_id, NO_KIND, &prove.read, &LOCATION_FLAGS).await {
            Ok(read) => checked.prove = Some(ProveRead { read, ..prove }),
            Err(reason) => checked.rejected.push(Rejected {
                part: PlanPart::Prove,
                label: prove.read.label,
                reason,
            }),
        }
    }
    Ok(checked)
}

/// One step to run, with everything that pins it: which cloud, which account,
/// whether the target already exists (the keep rule), and where.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepRequest {
    pub cloud_id: String,
    pub account: CloudAccount,
    pub existing: bool,
    pub step: DeployStep,
    /// The project directory the command runs in - `--source .` means this.
    pub cwd: String,
    /// Whether this caller is allowed to remove something: the resource
    /// panel's operations are, a deployment is not. Absent means not.
    #[serde(default)]
    pub removal: bool,
    /// Whether this step is part of deploying the open repository.
    ///
    /// Two things follow from it and nothing else does: the commands a deploy
    /// needs and the panel may not run (`Dialect::deploy_opens`), and the
    /// folder a CLI may keep a project in - the repository here, Aime's own
    /// work folder for everything else. Absent means an operation on a
    /// resource, which is the stricter of the two.
    #[serde(default)]
    pub deploying: bool,
}

/// Runs one confirmed step, streaming its output as `exec:output` under `id`.
///
/// The shape rules are applied again here, without the CLI: the step came from
/// a checked plan, but a rule that costs nothing to repeat is one that cannot
/// be bypassed by a caller holding a different plan.
#[tauri::command]
pub async fn cloud_deploy_step(
    app: AppHandle,
    state: State<'_, ExecState>,
    id: String,
    request: StepRequest,
) -> Result<CommandOutcome, String> {
    let dialect = Dialect::of(&request.cloud_id)
        .ok_or_else(|| format!("Aime does not deploy to {} yet", request.cloud_id))?;
    let line = StepLine::parse(&request.step.args, request.existing, dialect)?;
    line.refuse_forbidden(request.removal, request.deploying, dialect)?;
    let own = program_for(&app, &request.cloud_id);
    let program = step_program(&request.cloud_id, &own, dialect, &request.step)?;
    let runs_kubectl = program == k8s::PROGRAM;
    if runs_kubectl {
        // The kubeconfig a `get-credentials` step wrote names the auth plugin
        // as its provider, so without it every call fails on the exec step
        // before it reaches the cluster. Aime fetches what is missing rather
        // than stopping a deploy the person already confirmed - see `k8s`.
        ensure_kubectl(&own).await?;
    }
    // Each CLI is told where to work in its own words (`dialect::Scope`);
    // `kubectl` is told by the kubeconfig the cluster step wrote, and would
    // refuse those flags outright.
    let args = if runs_kubectl {
        request.step.args.clone()
    } else {
        scoped_for_run(
            &app,
            &request.step.args,
            &request.account,
            dialect,
            request.deploying.then_some(request.cwd.as_str()),
        )?
    };
    let mut command = cli_command(&program, &args);
    quiet(&mut command);
    let label = format!("{program} {}", args.join(" "));
    run_program(
        &app,
        &state,
        &id,
        &label,
        command,
        &request.cwd,
        Some(STEP_TIMEOUT_MS),
    )
    .await
}

/// Runs one read of a deploy - a `keep` before and after, the `prove` at the
/// end - checked first, scoped, answered as JSON.
#[tauri::command]
pub async fn cloud_deploy_read(
    app: AppHandle,
    cloud_id: String,
    account: CloudAccount,
    read: PlannedRead,
) -> Result<String, String> {
    let dialect = Dialect::of(&cloud_id).ok_or_else(|| format!("Aime does not deploy to {cloud_id} yet"))?;
    let own = program_for(&app, &cloud_id);
    // A read names its program exactly as a step does. Measured 2026-09-12:
    // without this, the AI's six diagnostic reads after a failed `kubectl
    // apply` all ran as `gcloud get …` and were refused one after another.
    if read.program == k8s::PROGRAM {
        let command = read.args.first().map(String::as_str).unwrap_or_default();
        k8s::refuse_unless_reading(&cloud_id, command)?;
        let mut args = read.args.clone();
        args.extend(k8s::json_flags().map(String::from));
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        return read_cli_checked(k8s::PROGRAM, &borrowed)
            .await
            .map_err(|failure| failure.message);
    }
    let checked = check_read_allowing(&own, &cloud_id, NO_KIND, &read, &LOCATION_FLAGS).await?;
    let mut args = scoped_for_run(&app, &checked.args, &account, dialect, None)?;
    args.extend(dialect.json.map(String::from));
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    read_cli_checked(&own, &borrowed)
        .await
        .map_err(|failure| failure.message)
}

/// Asks the deployed service itself, so "running" is something Aime saw.
#[tauri::command]
pub async fn cloud_http_probe(url: String) -> Result<Probe, String> {
    let client = crate::trackers::http::client().map_err(|error| match error {
        TrackerError::Network(detail) => detail,
        other => other.to_string(),
    })?;
    let started = Instant::now();
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("{url}: {error}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok(Probe {
        status,
        duration_ms: started.elapsed().as_millis() as u64,
        body_head: head_of(&body),
    })
}

/// Which of the named programs this machine has, so the plan can say whether
/// a build happens here or in the cloud. The names come from the caller: what
/// a deployment might need is the AI's knowledge, not this module's.
#[tauri::command]
pub fn programs_present(names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .filter(|name| is_command_word(name) && Program::resolve(name).exists())
        .collect()
}

/// A step's arguments with the scope Aime pins, in the CLI's own words: the
/// project or subscription, and the owner for a CLI that takes one.
///
/// The owner flag is left out when the dialect has none - `az` carries the
/// signed-in user in the token behind the subscription - and when the account
/// row does not know it.
fn scoped(args: &[String], account: &CloudAccount, dialect: &Dialect) -> Vec<String> {
    let mut scoped = args.to_vec();
    scoped.extend([dialect.scope.unit.to_string(), account.id.clone()]);
    if let Some(owner) = dialect.scope.owner {
        if !account.owner.is_empty() {
            scoped.extend([owner.to_string(), account.owner.clone()]);
        }
    }
    scoped
}

/// The scope, plus the flags only this installation can fill in.
///
/// Kept apart from `scoped` because these need the running app: the Supabase
/// CLI has to be told a work folder it may write into, or it drops a project
/// folder into whatever directory the command ran in - which is the person's
/// repository (`dialect::Dialect::runtime_flags`).
///
/// `working_in` is that folder, and it is the repository exactly when the step
/// belongs to a deploy. Work on a resource keeps the CLI out of the repository;
/// a deploy is the repository going to the cloud, so keeping it out there made
/// the whole cloud undeployable.
fn scoped_for_run(
    app: &AppHandle,
    args: &[String],
    account: &CloudAccount,
    dialect: &Dialect,
    working_in: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut full = scoped(args, account, dialect);
    if let Some(flags) = dialect.runtime_flags {
        full.extend(flags(app, working_in)?);
    }
    Ok(full)
}

/// Every check a step has to pass: the shape rules, then the CLI's own `--help`.
async fn check_step(
    program: &str,
    dialect: &Dialect,
    step: &DeployStep,
    existing: bool,
    removal: bool,
    deploying: bool,
) -> Result<(), String> {
    let line = StepLine::parse(&step.args, existing, dialect)?;
    line.refuse_forbidden(removal, deploying, dialect)?;
    line.words_exist(program, dialect).await
}

/// Puts what a `kubectl` step needs on this machine, if it is not here already.
///
/// Aime's own doing, not the AI's: `gcloud components` is a group no planned
/// step may touch, and rightly - but a deploy the person has already confirmed
/// should not stop on a binary the Cloud SDK already here can fetch in one
/// command. Each component is checked before it is fetched, so the common case
/// (both present) costs nothing and a second step costs nothing either.
async fn ensure_kubectl(gcloud: &str) -> Result<(), String> {
    let mut python: Option<String> = None;
    for component in k8s::NEEDED {
        if Program::resolve(component).exists() {
            continue;
        }
        // Windows only, and asked for once: see `k8s::BUNDLED_PYTHON` for the
        // error this avoids. Elsewhere the Cloud SDK runs on the system's
        // Python and updates itself without being told anything.
        if cfg!(target_os = "windows") && python.is_none() {
            python = Some(bundled_python(gcloud).await?);
        }
        install_component(gcloud, component, python.as_deref()).await?;
    }
    Ok(())
}

/// The Python the Cloud SDK can update itself with, off the last line of its
/// own answer.
async fn bundled_python(gcloud: &str) -> Result<String, String> {
    let printed = read_cli_checked(gcloud, &k8s::BUNDLED_PYTHON)
        .await
        .map_err(|failure| {
            format!(
                "could not find a Python to update the Cloud SDK with: {}",
                failure.message
            )
        })?;
    printed
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "`gcloud components copy-bundled-python` named no Python".to_string())
}

/// One Cloud SDK component, fetched with the Python it needs when there is one.
async fn install_component(gcloud: &str, component: &str, python: Option<&str>) -> Result<(), String> {
    let args = k8s::install(component);
    let mut command = cli_command(gcloud, args.iter().copied());
    quiet(&mut command);
    if let Some(python) = python {
        command.env(k8s::PYTHON_ENV, python);
    }
    let output = command
        .output()
        .await
        .map_err(|e| format!("could not run `{gcloud} {}`: {e}", args.join(" ")))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "`{component}` is needed before `{}` can reach a GKE cluster, and installing it failed: {}",
        k8s::PROGRAM,
        head_of(&String::from_utf8_lossy(&output.stderr))
    ))
}

/// Which CLI a step runs under, or the reason it may not run at all.
///
/// The cloud's own CLI when the step names none. A step that names one is held
/// to the gate for it: `kubectl` for Google Cloud's clusters and the commands
/// that deploy to one, nothing else anywhere. This is what keeps a model's
/// answer from widening what Aime is willing to run.
fn step_program(cloud_id: &str, own: &str, dialect: &Dialect, step: &DeployStep) -> Result<String, String> {
    if step.program.is_empty() {
        return Ok(own.to_string());
    }
    if Some(step.program.as_str()) != dialect.second_program {
        return Err(match dialect.second_program {
            Some(second) => format!(
                "Aime runs a deploy step with `{own}` or `{second}`, never `{}`",
                step.program
            ),
            None => format!(
                "Aime runs a deploy step with `{own}` and nothing else, never `{}`",
                step.program
            ),
        });
    }
    let command = step.args.first().map(String::as_str).unwrap_or_default();
    k8s::refuse_unless_deploying(cloud_id, command)?;
    Ok(k8s::PROGRAM.to_string())
}

/// A deploy command as gcloud reads it: the command words, the positionals they
/// take, and flags with their values.
///
/// Unlike a read there is no verb list to say where the words end - `run
/// deploy web`, `services enable run.googleapis.com`, `builds submit .` - so the
/// split is measured against the CLI itself (`words_exist`), and until then
/// every leading token that could be a command word is treated as one.
struct StepLine<'a> {
    /// Tokens before the first flag that are shaped like command words or
    /// positionals; how many are words is settled by `--help`.
    heads: Vec<&'a str>,
    flags: Vec<(&'a str, Option<&'a str>)>,
}

impl<'a> StepLine<'a> {
    fn parse(args: &'a [String], existing: bool, dialect: &Dialect) -> Result<Self, String> {
        if args.is_empty() {
            return Err("an empty command".into());
        }
        let mut heads = Vec::new();
        let mut flags: Vec<(&str, Option<&str>)> = Vec::new();
        for token in args {
            if let Some(name) = token.strip_prefix("--") {
                if name.contains('=') {
                    return Err(format!("`{token}`: a flag and its value are two tokens"));
                }
                if !is_command_word(name) {
                    return Err(format!("`{token}` is not a flag"));
                }
                if dialect.own_flags.contains(&token.as_str()) {
                    return Err(format!("`{token}` is Aime's to add"));
                }
                if dialect.refused_flags.contains(&token.as_str()) {
                    return Err(format!(
                        "`{token}` changes what the CLI does with the command line rather than \
                         what it asks the cloud"
                    ));
                }
                if existing {
                    if let Some(prefix) = dialect.overriding.iter().find(|p| token.starts_with(*p)) {
                        let family = &token[prefix.len()..];
                        return Err(format!(
                            "`{token}` replaces what the running service already has; \
                             use `{}{family}` so its settings are kept",
                            dialect.merging
                        ));
                    }
                }
                flags.push((token.as_str(), None));
            } else if let Some((_, value @ None)) = flags.last_mut() {
                if !is_safe_value(token) {
                    return Err(format!("`{token}` holds something a shell could misread"));
                }
                *value = Some(token.as_str());
            } else if !flags.is_empty() {
                return Err(format!("`{token}` follows a flag that already has a value"));
            } else {
                if !is_safe_value(token) {
                    return Err(format!("`{token}` holds something a shell could misread"));
                }
                heads.push(token.as_str());
            }
        }
        if heads.is_empty() {
            return Err("no command, only flags".into());
        }
        Ok(Self { heads, flags })
    }

    /// The words a deployment must never say, wherever they stand.
    fn refuse_forbidden(&self, removal: bool, deploying: bool, dialect: &Dialect) -> Result<(), String> {
        let first = self.heads[0];
        // What a deploy opens is checked before anything refuses it, because
        // these words ARE the deploy on some clouds: `supabase functions
        // deploy` sits inside a group the panel may not touch.
        if deploying
            && dialect.deploy_opens.iter().any(|(group, command)| {
                *group == first && (command.is_empty() || self.heads.get(1) == Some(command))
            })
        {
            return Ok(());
        }
        if dialect.refused_groups.contains(&first) {
            if let Some(grant) = dialect.grant.as_ref() {
                if first == grant.group && self.heads.get(1) == Some(&grant.command) {
                    return self.refuse_unsafe_grant(grant);
                }
            }
            return Err(format!("`{first}` {}", dialect.groups_are));
        }
        if let Some(refused) = dialect
            .refused_commands
            .iter()
            .find(|one| one.group == first && self.heads.get(1) == Some(&one.command))
        {
            return Err(format!("`{} {}` {}", refused.group, refused.command, refused.why));
        }
        if let Some(word) = self.heads.iter().find(|word| {
            REFUSED_WORDS.contains(word)
                || REFUSED_WORD_PREFIXES
                    .iter()
                    .any(|prefix| word.starts_with(prefix))
        }) {
            if !removal {
                return Err(format!(
                    "`{word}` removes something; a deployment only adds and updates"
                ));
            }
        }
        if let Some(refused) = dialect.refused_values.iter().find(|one| {
            self.flags
                .iter()
                .any(|(flag, value)| *flag == one.flag && *value == Some(one.value))
        }) {
            return Err(format!("`{} {}` {}", refused.flag, refused.value, refused.why));
        }
        Ok(())
    }

    /// The fence around the one project-level grant a deployment may make.
    ///
    /// A binding is `--member <who> --role <what>`; both have to be there and
    /// both have to be narrow, or the step is refused with words the AI can
    /// act on. Nothing here decides WHICH role a build needs - that is the
    /// AI's to know and the CLI's to accept; Aime only says which grants a
    /// deployment may never make.
    fn refuse_unsafe_grant(&self, grant: &Grant) -> Result<(), String> {
        let value_of = |name: &str| {
            self.flags
                .iter()
                .find(|(flag, _)| *flag == name)
                .and_then(|(_, value)| *value)
        };
        let Some(member) = value_of(grant.member) else {
            return Err(format!("a binding needs `{}`", grant.member));
        };
        if !member.starts_with(grant.member_prefix) {
            return Err(format!(
                "`{member}` is not a service account; a deployment may grant an account-level \
                 role only to a `{}` - a person or `allUsers` is somebody's own decision",
                grant.member_prefix
            ));
        }
        let Some(role) = value_of(grant.role) else {
            return Err(format!("a binding needs `{}`", grant.role));
        };
        if grant.refused_roles.contains(&role) {
            return Err(format!(
                "`{role}` can grant every other role; name the narrow role this actually needs"
            ));
        }
        Ok(())
    }

    /// Whether the leading words are a command the CLI here knows.
    ///
    /// `gcloud <words> --help` exits 0 for a real command and 2 for one it does
    /// not have (measured 2026-09-05). The walk extends the command one word
    /// at a time and stops at the first token the CLI does not accept, which
    /// is then the first positional - so `run deploy web` needs two calls and
    /// `services enable run.googleapis.com` one, since a dotted token is never
    /// tried as a word.
    ///
    /// The probe token comes from the dialect because it is not the same on
    /// every CLI: `aws` has no `--help` flag and answers a positional `help`
    /// instead (`dialect::Dialect::help`).
    async fn words_exist(&self, program: &str, dialect: &Dialect) -> Result<(), String> {
        if dialect.proof == Proof::Listed {
            return self.words_listed(program, dialect).await;
        }
        let mut words: Vec<&str> = Vec::new();
        // The help of the last command that existed, which is the one the
        // flags belong to - already paid for by the walk, so reading it costs
        // nothing more.
        let mut help = String::new();
        for head in &self.heads {
            if !is_command_word(head) {
                break;
            }
            let mut probe = words.clone();
            probe.push(head);
            probe.push(dialect.help);
            let Ok(text) = read_cli_checked(program, &probe).await else {
                break;
            };
            help = text;
            words.push(head);
        }
        if words.is_empty() {
            return Err(format!(
                "`{} {}` is not a command the {} CLI here knows",
                dialect.program, self.heads[0], dialect.name
            ));
        }
        if dialect.proof == Proof::WordsAndFlags {
            return self.flags_fit(&words, &help);
        }
        Ok(())
    }

    /// The same question for a CLI whose exit code does not answer it.
    ///
    /// The Supabase CLI prints its command tree and `reads.rs` walks it; the
    /// difference here is that a step is not a read, so it may end in
    /// arguments (`functions delete my-fn`) where a read may not. What it may
    /// NOT do is misspell a subcommand, and the walk tells the two apart by
    /// whether the level above lists any subcommands at all - measured in the
    /// app 2026-09-18, when the AI answered `supabase db upgrade`, a command
    /// that does not exist, and the CLI printed the help of `db` and exited 0.
    async fn words_listed(&self, program: &str, dialect: &Dialect) -> Result<(), String> {
        let words: Vec<&str> = self
            .heads
            .iter()
            .copied()
            .take_while(|head| is_command_word(head))
            .collect();
        // How many leading tokens are the command, and the command's own help -
        // which is what says whether it takes an argument at all.
        let (command, help) = match super::reads::supabase_walk(program, &words).await? {
            super::reads::SupabaseWalk::All => {
                let mut probe = words.clone();
                probe.push(dialect.help);
                let help = read_cli_checked(program, &probe)
                    .await
                    .map_err(|failure| failure.message)?;
                (words.len(), help)
            }
            super::reads::SupabaseWalk::Arguments { at: 0, .. } => {
                return Err(format!(
                    "`{} {}` is not a command the {} CLI here knows",
                    dialect.program, self.heads[0], dialect.name
                ))
            }
            super::reads::SupabaseWalk::Arguments { at, help } => (at, help),
            super::reads::SupabaseWalk::Unknown(at) => {
                return Err(format!(
                    "`{} {}` is not a command the {} CLI here knows",
                    dialect.program,
                    words[..=at].join(" "),
                    dialect.name
                ))
            }
        };
        // Everything after the command is an argument, whether or not it looks
        // like a command word - `max_connections` does not, and it was still
        // the token that broke. Measured in the app 2026-09-18: `postgres-config
        // get max_connections` ran, and the CLI answered with its usage block
        // instead of the configuration, because that command takes none.
        let Some(extra) = self.heads.get(command) else {
            return Ok(());
        };
        if super::reads::supabase_takes_a_positional(&help) {
            return Ok(());
        }
        Err(format!(
            "`{} {}` takes no argument, so `{extra}` is not one it can use",
            dialect.program,
            self.heads[..command].join(" ")
        ))
    }

    /// Whether the flags belong to the command, for a CLI that says so.
    ///
    /// Two sources, because one CLI describes itself two ways. Its models
    /// carry every API operation and name the flags it has and the ones it
    /// requires; the commands the CLI adds itself are in no model, and those
    /// declare themselves in the synopsis of their own help - which the walk
    /// has just fetched.
    fn flags_fit(&self, words: &[&str], help: &str) -> Result<(), String> {
        if let [service, command] = words[..] {
            if let Some(verdict) = super::reads::aws_operation_flags(service, command, &self.flags) {
                // The model describes the API; the CLI adds flags of its own on
                // top of a real operation, and then the model is not the whole
                // truth. Measured 2026-09-22: `cloudfront create-invalidation
                // --paths` is in that command's own help and in no model, which
                // has `--invalidation-batch` and calls it required - so a plan
                // that used the CLI's own flag was refused for using it.
                return verdict.or_else(|refusal| self.help_allows(help).ok_or(refusal));
            }
        }
        self.synopsis_fits(words, help)
    }

    /// The command's own help as a second opinion: `Some(())` when it lists
    /// every flag this step carries AND every flag it marks required is there.
    ///
    /// Only used to overturn a refusal from the model, never to make one: a
    /// help Aime cannot parse says nothing, and nothing is not an accusation.
    fn help_allows(&self, help: &str) -> Option<()> {
        let accepted = super::reads::flags_in_synopsis(help)?;
        let carried = |flag: &String| self.flags.iter().any(|(had, _)| had == flag);
        let known = self
            .flags
            .iter()
            .all(|(flag, _)| accepted.iter().any(|known| known == flag));
        let complete = super::reads::required_flags_in_synopsis(help).iter().all(carried);
        (known && complete).then_some(())
    }

    /// Whether the command's own help accepts every flag, for the commands the
    /// CLI adds itself and no model carries.
    fn synopsis_fits(&self, words: &[&str], help: &str) -> Result<(), String> {
        let Some(accepted) = super::reads::flags_in_synopsis(help) else {
            return Ok(());
        };
        let command = words.join(" ");
        for (flag, _) in &self.flags {
            if !accepted.iter().any(|known| known == flag) {
                return Err(format!(
                    "`{command}` has no `{flag}`; its own help lists {}",
                    if accepted.is_empty() {
                        "no flags at all".to_string()
                    } else {
                        accepted.join(", ")
                    }
                ));
            }
        }
        Ok(())
    }
}

fn head_of(body: &str) -> String {
    let cut = body
        .char_indices()
        .map(|(at, _)| at)
        .find(|at| *at >= BODY_HEAD)
        .unwrap_or(body.len());
    body[..cut].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(args: &[&str]) -> DeployStep {
        under("", args)
    }

    /// The dialect a test means when it does not say: the one every rule here
    /// was written against.
    fn gcloud() -> &'static Dialect {
        Dialect::of("gcp").expect("Google Cloud has a dialect")
    }

    fn az() -> &'static Dialect {
        Dialect::of("azure").expect("Azure has a dialect")
    }

    fn aws() -> &'static Dialect {
        Dialect::of("aws").expect("AWS has a dialect")
    }

    fn supabase() -> &'static Dialect {
        Dialect::of("supabase").expect("Supabase has a dialect")
    }

    /// The split that gave Supabase a Deploy button at last.
    ///
    /// For three sessions Aime said this cloud could not be deployed to,
    /// because the commands that deploy it - `link`, `functions deploy`, `db
    /// push`, `config push` - read a `supabase/` directory, and the panel runs
    /// this CLI from a work folder that has none. A deploy does not: it runs
    /// inside the repository, where those files are. So the same words are
    /// refused for work on a resource and allowed for a deploy, and nothing
    /// else moves with them.
    #[test]
    fn what_deploys_a_supabase_project_is_open_to_a_deploy_and_shut_to_the_panel() {
        for words in [
            // No `--project-ref` on it: Aime pins that itself, and a plan
            // that writes one of Aime's own flags is refused before this.
            ["link"].as_slice(),
            ["functions", "deploy", "hello"].as_slice(),
            ["db", "push"].as_slice(),
            ["config", "push"].as_slice(),
        ] {
            assert!(
                shape_for(supabase(), words, false).is_ok(),
                "a deploy needs {words:?}"
            );
            assert!(
                op_shape_for(supabase(), words).is_err(),
                "the panel has no project to run {words:?} against"
            );
        }
        // What a deploy opens is exactly that list: the rest of the refused
        // groups stays refused on both paths.
        for words in [
            ["db", "reset"].as_slice(),
            ["db", "query", "select 1"].as_slice(),
            ["start"].as_slice(),
            ["login"].as_slice(),
        ] {
            assert!(shape_for(supabase(), words, false).is_err(), "{words:?}");
            assert!(op_shape_for(supabase(), words).is_err(), "{words:?}");
        }
    }

    /// A step that names the CLI it runs under, the way a plan may.
    fn under(program: &str, args: &[&str]) -> DeployStep {
        DeployStep {
            label: "step".into(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            changes: String::new(),
            program: program.to_string(),
        }
    }

    #[test]
    fn a_step_runs_under_the_clouds_own_cli_unless_it_names_another() {
        assert_eq!(
            step_program("gcp", "gcloud", gcloud(), &step(&["run", "deploy"])),
            Ok("gcloud".into())
        );
        assert_eq!(
            step_program(
                "gcp",
                "gcloud",
                gcloud(),
                &under("kubectl", &["apply", "--filename", "k8s/"])
            ),
            Ok("kubectl".into())
        );
    }

    #[test]
    fn a_step_may_not_name_any_other_program_or_an_undeploying_kubectl() {
        // A model naming a shell, a package manager or a build tool is the case
        // this gate exists for: the refusal says what the two programs are.
        for invented in ["sh", "bash", "helm", "terraform", "docker", "npm"] {
            let refused = step_program("gcp", "gcloud", gcloud(), &under(invented, &["anything"]))
                .expect_err("only two programs run a step");
            assert!(refused.contains(invented), "unhelpful: {refused}");
            assert!(
                refused.contains("kubectl"),
                "the refusal does not say what IS run: {refused}"
            );
        }
        // `kubectl` itself is held to the commands that deploy.
        let refused = step_program("gcp", "gcloud", gcloud(), &under("kubectl", &["exec", "pod"]))
            .expect_err("a shell on a pod is not a deployment");
        assert!(refused.contains("exec"), "unhelpful: {refused}");
        // And it belongs to Google Cloud's clusters alone: a cloud whose
        // dialect names no second program says so in the refusal itself.
        let refused = step_program("azure", "az", az(), &under("kubectl", &["apply"]))
            .expect_err("Azure runs `az` and nothing else");
        assert!(
            refused.contains("`az`") && refused.contains("kubectl"),
            "unhelpful: {refused}"
        );
    }

    fn shape(args: &[&str], existing: bool) -> Result<(), String> {
        shape_for(gcloud(), args, existing)
    }

    fn shape_for(dialect: &Dialect, args: &[&str], existing: bool) -> Result<(), String> {
        let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        StepLine::parse(&owned, existing, dialect)?.refuse_forbidden(false, true, dialect)
    }

    /// The same line as the resource panel checks it: removal allowed, and
    /// none of what a deploy opens.
    fn op_shape(args: &[&str]) -> Result<(), String> {
        op_shape_for(gcloud(), args)
    }

    fn op_shape_for(dialect: &Dialect, args: &[&str]) -> Result<(), String> {
        let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        StepLine::parse(&owned, true, dialect)?.refuse_forbidden(true, false, dialect)
    }

    #[test]
    fn a_deploy_from_source_has_the_shape_gcloud_takes() {
        shape(
            &[
                "run",
                "deploy",
                "web",
                "--source",
                ".",
                "--region",
                "asia-southeast1",
            ],
            false,
        )
        .expect("a well-formed step passes the shape rules");
        shape(
            &[
                "services",
                "enable",
                "run.googleapis.com",
                "cloudbuild.googleapis.com",
            ],
            false,
        )
        .expect("several positionals are fine");
    }

    #[test]
    fn a_running_service_keeps_its_settings() {
        let refused = shape(&["run", "deploy", "web", "--set-env-vars", "A=1"], true)
            .expect_err("--set-* replaces the service's variables");
        assert!(
            refused.contains("--update-env-vars"),
            "the merging flag is named: {refused}"
        );
        shape(&["run", "deploy", "web", "--update-env-vars", "A=1"], true)
            .expect("--update-* merges, which keeps what is there");
        shape(&["run", "deploy", "web", "--set-env-vars", "A=1"], false)
            .expect("a service that does not exist yet has nothing to keep");
        let cleared = shape(&["run", "services", "update", "web", "--clear-env-vars"], true)
            .expect_err("--clear-* wipes");
        assert!(cleared.contains("--update-env-vars"));
    }

    /// The grant every source deploy needs, and the three ways it could be
    /// abused. Written against the failure a real deploy hit 2026-09-10:
    /// `gcloud run deploy --source` refused because
    /// `130881371924-compute@developer.gserviceaccount.com` had no build roles.
    #[test]
    fn a_build_service_account_can_be_granted_its_role_but_not_the_keys_to_the_project() {
        let grant = |member: &str, role: &str| {
            shape(
                &[
                    "projects",
                    "add-iam-policy-binding",
                    // The project is this command's positional and the AI knows
                    // it; `--project`, which Aime adds, is a flag and stays
                    // Aime's.
                    "shop-prod-1234",
                    "--member",
                    member,
                    "--role",
                    role,
                ],
                false,
            )
        };
        let build_account = "serviceAccount:130881371924-compute@developer.gserviceaccount.com";
        assert!(
            grant(build_account, "roles/cloudbuild.builds.builder").is_ok(),
            "the one grant that makes a source build work has to be possible"
        );

        for role in [
            "roles/owner",
            "roles/editor",
            "roles/resourcemanager.projectIamAdmin",
        ] {
            let refused = grant(build_account, role).expect_err("a blanket role is refused");
            assert!(refused.contains(role), "the refusal names the role: {refused}");
        }
        assert!(
            grant("allUsers", "roles/cloudbuild.builds.builder").is_err(),
            "a project role is for a machine identity, never for everyone"
        );
        assert!(
            grant("user:someone@example.com", "roles/cloudbuild.builds.builder").is_err(),
            "granting a person a project role is that person's own decision"
        );
        assert!(
            shape(&["projects", "add-iam-policy-binding", "shop-prod-1234"], false).is_err(),
            "a binding with no member and no role is not a binding"
        );
        assert!(
            shape(
                &["projects", "remove-iam-policy-binding", "shop-prod-1234"],
                false
            )
            .is_err(),
            "the exception is for adding only"
        );
        assert!(
            shape(
                &["projects", "set-iam-policy", "<project>", "--member", "x"],
                false
            )
            .is_err(),
            "replacing the whole policy is not adding a binding"
        );
    }

    /// Deleting a resource is day-to-day work, and refusing it only sends
    /// someone to the web console to do the same thing with less ceremony. So
    /// the resource panel's operations may remove; a deployment still may not,
    /// and neither may touch the account either way.
    #[test]
    fn the_resource_panel_may_remove_what_a_deployment_may_not() {
        for command in [
            &["run", "services", "delete", "web"][..],
            &["run", "services", "remove-iam-policy-binding", "web"][..],
            &["pubsub", "topics", "delete", "orders"][..],
        ] {
            assert!(shape(command, false).is_err(), "a deployment does not remove");
            assert!(
                op_shape(command).is_ok(),
                "the panel does, with the name typed out"
            );
        }
        // Allowing removal opens exactly that, and nothing else.
        assert!(op_shape(&["auth", "revoke"]).is_err());
        assert!(op_shape(&["config", "unset", "project"]).is_err());
        assert!(op_shape(&["projects", "delete", "shop-prod-1234"]).is_err());
    }

    #[test]
    fn nothing_is_removed_and_the_account_is_not_touched() {
        assert!(shape(&["run", "services", "delete", "web"], false).is_err());
        assert!(shape(&["projects", "create", "sandbox"], false).is_err());
        assert!(shape(&["billing", "projects", "link", "p"], false).is_err());
        assert!(shape(&["run", "services", "remove-iam-policy-binding", "web"], false).is_err());
        assert!(shape(&["auth", "login"], false).is_err());
        shape(
            &[
                "run",
                "services",
                "add-iam-policy-binding",
                "web",
                "--member",
                "allUsers",
            ],
            false,
        )
        .expect("adding is what a deployment does");
    }

    #[test]
    fn the_flags_aime_adds_and_the_forms_it_cannot_run_are_refused() {
        assert!(shape(&["run", "deploy", "web", "--project", "other"], false).is_err());
        assert!(shape(&["run", "deploy", "web", "--account", "x@y"], false).is_err());
        assert!(shape(&["run", "deploy", "web", "--format", "json"], false).is_err());
        let joined = shape(&["run", "deploy", "web", "--region=asia"], false).expect_err("--x=y");
        assert!(joined.contains("two tokens"));
        assert!(shape(&["run", "deploy", "web; rm -rf /"], false).is_err());
        assert!(
            shape(&["--region", "x"], false).is_err(),
            "flags alone are not a command"
        );
    }

    fn account(id: &str, owner: &str) -> CloudAccount {
        CloudAccount {
            id: id.into(),
            label: String::new(),
            detail: String::new(),
            current: false,
            owner: owner.into(),
            tenant: String::new(),
            sign_in: String::new(),
        }
    }

    #[test]
    fn the_scope_is_aimes_and_follows_the_plan_s_arguments() {
        let args = scoped(
            &step(&["run", "deploy", "web"]).args,
            &account("my-project", "dev@example.com"),
            gcloud(),
        );
        assert_eq!(
            args,
            [
                "run",
                "deploy",
                "web",
                "--project",
                "my-project",
                "--account",
                "dev@example.com"
            ]
        );
    }

    /// Azure is scoped by subscription, and by nothing else: `az` has no
    /// account flag, so passing the signed-in user would fail the command.
    #[test]
    fn an_azure_step_is_pinned_to_the_subscription_alone() {
        let args = scoped(
            &step(&["webapp", "up", "--name", "web"]).args,
            &account("1b3e09f3-1a77-441b-aeca-3488d1efac95", "someone@example.com"),
            az(),
        );
        assert_eq!(
            args,
            [
                "webapp",
                "up",
                "--name",
                "web",
                "--subscription",
                "1b3e09f3-1a77-441b-aeca-3488d1efac95"
            ]
        );
    }

    /// The Azure rules, each one against the group it is about.
    #[test]
    fn an_azure_deployment_stays_out_of_the_account_the_money_and_the_cli() {
        shape_for(
            az(),
            &[
                "group",
                "create",
                "--name",
                "rg-aime",
                "--location",
                "southeastasia",
            ],
            false,
        )
        .expect("a resource group is where an Azure deployment starts");
        shape_for(az(), &["webapp", "up", "--name", "web", "--sku", "F1"], false).expect("the deploy itself");

        for refused in [
            vec!["account", "set", "--name", "other"],
            vec!["login"],
            vec!["config", "set", "core.output=none"],
            vec!["extension", "add", "--name", "containerapp"],
            vec!["role", "assignment", "create", "--role", "Owner"],
            vec!["billing", "account", "list"],
        ] {
            let reason = shape_for(az(), &refused, false)
                .expect_err(&format!("`az {}` is not a deployment", refused.join(" ")));
            assert!(
                reason.contains(refused[0]),
                "the refusal does not name the group: {reason}"
            );
        }
    }

    /// AWS is scoped by profile, and by nothing else: the credentials are the
    /// account, and the region belongs to the resource rather than the scope.
    #[test]
    fn an_aws_operation_is_pinned_to_the_profile_alone() {
        let args = scoped(
            &step(&[
                "ecs",
                "update-service",
                "--service",
                "web",
                "--region",
                "ap-southeast-2",
            ])
            .args,
            &account("default", ""),
            aws(),
        );
        assert_eq!(
            args,
            [
                "ecs",
                "update-service",
                "--service",
                "web",
                "--region",
                "ap-southeast-2",
                "--profile",
                "default"
            ]
        );
    }

    /// The AWS rules, each against the thing it is about.
    #[test]
    fn an_aws_operation_stays_out_of_the_identity_the_money_and_the_shell() {
        shape_for(
            aws(),
            &[
                "ecs",
                "update-service",
                "--service",
                "web",
                "--force-new-deployment",
            ],
            true,
        )
        .expect("redeploying a service is the day-to-day work this is for");
        shape_for(aws(), &["logs", "tail", "/aws/lambda/web"], false).expect("tailing logs changes nothing");

        for refused in [
            vec!["configure", "set", "region", "us-east-1"],
            vec!["iam", "attach-role-policy", "--role-name", "web"],
            vec!["sts", "assume-role", "--role-arn", "arn"],
            vec!["organizations", "list-accounts"],
            vec!["ce", "get-cost-and-usage"],
            vec!["ec2-instance-connect", "send-ssh-public-key"],
        ] {
            let reason = shape_for(aws(), &refused, false)
                .expect_err(&format!("`aws {}` is not an operation", refused.join(" ")));
            assert!(
                reason.contains(refused[0]),
                "the refusal does not name the group: {reason}"
            );
        }
    }

    /// Every AWS operation is one hyphenated word, so "delete" as a whole word
    /// catches none of them - and a deployment that can take something away is
    /// a deployment that can take away what it never made.
    #[test]
    fn an_aws_deployment_never_takes_anything_away() {
        for refused in [
            vec!["s3api", "delete-bucket", "--bucket", "b"],
            vec!["cloudformation", "delete-stack", "--stack-name", "s"],
            vec!["ec2", "terminate-instances", "--instance-ids", "i-0abc"],
            // `s3` spells its own two, and neither looks like the words above.
            vec!["s3", "rm", "s3://b/key"],
            vec!["s3", "rb", "s3://b"],
        ] {
            let reason = shape_for(aws(), &refused, false)
                .expect_err(&format!("`aws {}` removes something", refused.join(" ")));
            assert!(reason.contains("removes something"), "{reason}");
        }
        // The panel may still remove: there the person types the resource's own
        // name first, which is the ceremony a deployment has no place for.
        op_shape_for(aws(), &["s3api", "delete-bucket", "--bucket", "b"])
            .expect("removing a resource is day-to-day work on the panel");
    }

    /// The one thing `cloudformation deploy` can ask for that reaches outside
    /// the stack: the right to make identities, and how they are named.
    #[test]
    fn a_stack_may_make_roles_it_owns_and_not_ones_somebody_else_named() {
        let line = |capability: &'static str| {
            vec![
                "cloudformation",
                "deploy",
                "--template-file",
                "infra/site.yaml",
                "--stack-name",
                "aime-site",
                "--capabilities",
                capability,
            ]
        };
        shape_for(aws(), &line("CAPABILITY_IAM"), false)
            .expect("a stack whose roles CloudFormation names belongs to that stack");

        let named = shape_for(aws(), &line("CAPABILITY_NAMED_IAM"), false).expect_err("named IAM");
        assert!(named.contains("name of its own choosing"), "{named}");
        let expand = shape_for(aws(), &line("CAPABILITY_AUTO_EXPAND"), false).expect_err("auto expand");
        assert!(expand.contains("after the person has read it"), "{expand}");
    }

    /// `aws cloudfront create-invalidation help`, captured verbatim 2026-09-22.
    const CREATE_INVALIDATION_HELP: &str = r#"
Synopsis
********

     create-invalidation
   --distribution-id <value>
   [--invalidation-batch <value>]
   [--paths <value>]
   [--cli-input-json | --cli-input-yaml]
   [--generate-cli-skeleton <value>]
   [--debug]
   [--endpoint-url <value>]
   [--no-verify-ssl]
   [--no-paginate]
   [--output <value>]
   [--query <value>]
   [--profile <value>]
   [--region <value>]
   [--version <value>]
   [--color <value>]
   [--no-sign-request]
   [--ca-bundle <value>]
   [--cli-read-timeout <value>]
   [--cli-connect-timeout <value>]
   [--cli-binary-format <value>]
   [--no-cli-pager]
   [--cli-auto-prompt]
   [--no-cli-auto-prompt]


Options
"#;

    /// The CLI adds flags on top of a real API operation, and then the service
    /// model is not the whole truth about that command.
    ///
    /// Measured on a real plan: `create-invalidation --paths` was refused
    /// because the model has only `--invalidation-batch` - and calls it
    /// required - while the command's own help lists `--paths` and marks
    /// nothing but `--distribution-id` required.
    #[test]
    fn a_flag_the_cli_adds_is_a_flag_the_command_has() {
        let args: Vec<String> = [
            "cloudfront",
            "create-invalidation",
            "--distribution-id",
            "E123",
            "--paths",
            "/*",
        ]
        .iter()
        .map(|word| (*word).to_string())
        .collect();
        let line = StepLine::parse(&args, false, aws()).expect("a well-formed line");
        line.flags_fit(&["cloudfront", "create-invalidation"], CREATE_INVALIDATION_HELP)
            .expect("the command's own help lists `--paths`");

        // A flag NEITHER source knows is still refused, and the refusal says
        // what the command does have.
        let made_up: Vec<String> = [
            "cloudfront",
            "create-invalidation",
            "--distribution-id",
            "E123",
            "--everything",
        ]
        .iter()
        .map(|word| (*word).to_string())
        .collect();
        let refusal = StepLine::parse(&made_up, false, aws())
            .expect("a well-formed line")
            .flags_fit(&["cloudfront", "create-invalidation"], CREATE_INVALIDATION_HELP)
            .expect_err("`--everything` is in no model and in no help");
        assert!(refusal.contains("--everything"), "{refusal}");

        // And a flag the help marks REQUIRED cannot be left out.
        let missing: Vec<String> = ["cloudfront", "create-invalidation", "--paths", "/*"]
            .iter()
            .map(|word| (*word).to_string())
            .collect();
        StepLine::parse(&missing, false, aws())
            .expect("a well-formed line")
            .flags_fit(&["cloudfront", "create-invalidation"], CREATE_INVALIDATION_HELP)
            .expect_err("`--distribution-id` is bare in the synopsis, so it is required");
    }

    /// A shell is refused inside a group the panel otherwise needs.
    #[test]
    fn an_aws_operation_may_not_open_a_session_on_a_machine() {
        for refused in [
            vec!["ssm", "start-session", "--target", "i-0abc"],
            vec!["ssm", "send-command", "--document-name", "AWS-RunShellScript"],
            vec!["ecs", "execute-command", "--command", "sh"],
        ] {
            let reason = shape_for(aws(), &refused, false)
                .expect_err(&format!("`aws {}` runs code", refused.join(" ")));
            assert!(reason.contains(refused[1]), "{reason}");
        }
        // The groups themselves stay open, or the panel could not redeploy an
        // ECS service or read a parameter.
        shape_for(aws(), &["ssm", "get-parameter", "--name", "/web/db"], false).expect("a parameter read");
    }

    /// The flags that would carry an AWS command line out of Aime's sight.
    #[test]
    fn an_aws_operation_may_not_redirect_itself_or_smuggle_its_parameters() {
        for flag in [
            "--endpoint-url",
            "--cli-input-json",
            "--generate-cli-skeleton",
            "--no-verify-ssl",
            "--query",
        ] {
            let reason = shape_for(aws(), &["ecs", "describe-services", flag, "x"], false)
                .expect_err(&format!("`{flag}` is not part of an operation"));
            assert!(reason.contains(flag), "{reason}");
        }
    }

    /// The same through the gate on the two CLIs whose global flags were read
    /// from their own help: a step that runs as somebody else, or answers in a
    /// shape Aime did not ask for, is not a deployment step.
    #[test]
    fn a_gcloud_or_az_step_may_not_change_who_runs_it_or_what_it_answers() {
        for flag in [
            "--impersonate-service-account",
            "--configuration",
            "--flags-file",
            "--log-http",
        ] {
            let reason = shape_for(gcloud(), &["run", "deploy", "web", flag, "x"], false)
                .expect_err(&format!("`gcloud … {flag}` is not a step"));
            assert!(reason.contains(flag), "{reason}");
        }
        for flag in ["--debug", "--query"] {
            let reason = shape_for(az(), &["webapp", "up", "--name", "web", flag, "x"], false)
                .expect_err(&format!("`az … {flag}` is not a step"));
            assert!(reason.contains(flag), "{reason}");
        }
    }

    /// `az rest` is a raw ARM request: it would carry a DELETE straight past
    /// every rule in this module, so it is refused by name.
    #[test]
    fn a_raw_api_call_is_not_a_step() {
        assert!(shape_for(az(), &["rest", "--method", "delete", "--url", "https://x"], false).is_err());
    }

    /// Azure has no `--set-*` family, so an existing target refuses nothing by
    /// shape - and the flag Aime adds itself is refused on both clouds.
    #[test]
    fn each_cloud_refuses_the_flags_its_own_cli_is_given_by_aime() {
        shape_for(
            az(),
            &["webapp", "config", "appsettings", "set", "--settings", "A=1"],
            true,
        )
        .expect("Azure spells a change as a verb, and there is nothing to refuse by shape");
        assert!(
            shape_for(az(), &["webapp", "up", "--subscription", "other"], false).is_err(),
            "the subscription is Aime's to pin"
        );
        assert!(
            shape_for(az(), &["webapp", "up", "--output", "table"], false).is_err(),
            "the answer's shape is Aime's to ask for"
        );
    }

    #[test]
    fn a_body_is_cut_on_a_character_boundary() {
        let long = "é".repeat(BODY_HEAD);
        let head = head_of(&long);
        assert!(head.chars().count() <= BODY_HEAD);
        assert!(long.starts_with(&head));
    }

    #[test]
    fn only_programs_shaped_like_a_name_are_looked_up() {
        // `git` is on every machine this crate builds on; the odd token is not
        // even asked about, so a caller cannot probe arbitrary paths.
        let present = programs_present(vec!["git".into(), "../evil".into(), "no-such-tool-here".into()]);
        assert_eq!(present, vec!["git".to_string()]);
    }

    /// Against the real CLI, when this machine has it: the walk has to stop at
    /// the first positional and accept the words before it.
    #[tokio::test]
    async fn the_word_walk_uses_the_installed_gcloud_when_there_is_one() {
        if !Program::resolve("gcloud").exists() {
            eprintln!("gcloud is not installed here; the word walk was not exercised");
            return;
        }
        let owned: Vec<String> = ["run", "deploy", "web", "--source", "."]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        StepLine::parse(&owned, false, gcloud())
            .expect("shape")
            .words_exist("gcloud", gcloud())
            .await
            .expect("`gcloud run deploy` exists and `web` is its positional");

        let wrong: Vec<String> = ["rnu", "deploy", "web"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        assert!(
            StepLine::parse(&wrong, false, gcloud())
                .expect("shape")
                .words_exist("gcloud", gcloud())
                .await
                .is_err(),
            "a misspelled group is not a command"
        );
    }

    /// The same walk against `az`, whose `--help` answers the same way:
    /// measured 2026-09-17 on 2.90.0, exit 0 with the help on stdout for a
    /// real command and exit 2 with nothing on stdout for a misspelled one.
    #[tokio::test]
    async fn the_word_walk_uses_the_installed_az_when_there_is_one() {
        if !Program::resolve("az").exists() {
            eprintln!("az is not installed here; the word walk was not exercised");
            return;
        }
        let owned: Vec<String> = ["webapp", "up", "--name", "web"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        StepLine::parse(&owned, false, az())
            .expect("shape")
            .words_exist("az", az())
            .await
            .expect("`az webapp up` exists");

        let wrong: Vec<String> = ["webap", "up"].iter().map(|arg| (*arg).to_string()).collect();
        let refused = StepLine::parse(&wrong, false, az())
            .expect("shape")
            .words_exist("az", az())
            .await
            .expect_err("a misspelled group is not a command");
        assert!(
            refused.contains("Azure"),
            "the refusal names the cloud: {refused}"
        );
    }

    /// The same walk against `aws`, which answers a different token.
    ///
    /// This is the test that would have caught the whole AWS arm being
    /// impossible: measured 2026-09-18 on aws-cli 2.17.31, `aws ec2
    /// describe-instances --help` exits **252** - so a walk that sent the flag
    /// would refuse every command AWS has, and the tab would never offer one.
    #[tokio::test]
    async fn the_word_walk_uses_the_installed_aws_when_there_is_one() {
        if !Program::resolve("aws").exists() {
            eprintln!("aws is not installed here; the word walk was not exercised");
            return;
        }
        let owned: Vec<String> = ["ecs", "update-service", "--service", "web"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        StepLine::parse(&owned, false, aws())
            .expect("shape")
            .words_exist("aws", aws())
            .await
            .expect("`aws ecs update-service` exists");

        // What the walk does NOT prove, here as on the other two CLIs: a
        // misspelled operation under a real service passes, because `aws ecs`
        // is itself a command and the walk stops at the first word the CLI
        // rejects. That command fails at run time in the CLI's own words,
        // which is where the person sees it.
        let wrong: Vec<String> = ["ecs", "update-servce"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        StepLine::parse(&wrong, false, aws())
            .expect("shape")
            .words_exist("aws", aws())
            .await
            .expect("the walk keeps the one word it proved");

        let nonsense: Vec<String> = ["ec3", "update-service"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        let refused = StepLine::parse(&nonsense, false, aws())
            .expect("shape")
            .words_exist("aws", aws())
            .await
            .expect_err("a service the CLI does not have is not a command");
        assert!(refused.contains("AWS"), "the refusal names the cloud: {refused}");
    }
}
