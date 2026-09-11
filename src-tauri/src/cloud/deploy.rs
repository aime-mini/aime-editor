//! Deploying the open project to a cloud: the AI plans, Aime checks, a person
//! confirms, Aime runs and proves.
//!
//! Why the AI never holds the CLI here. Measured 2026-09-06: Claude Code's plan
//! mode - the "read-only" level every analysing turn runs at - still executed a
//! command through its Bash tool. Plan mode forbids edits, not commands, and a
//! command can be `gcloud run services delete`. So a deploy is the reads of
//! `reads.rs` one layer up: the AI writes argument lists, this module proves
//! each one against the CLI's own `--help` and against rules of its own, the
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
//! Only Google Cloud has an arm. The others would need their own grammar and
//! their own measurement, and a button offering a command Aime cannot check is
//! worse than no button.

use super::reads::{check_read_allowing, is_command_word, is_safe_value, PlannedRead};
use super::{program_for, quiet, read_cli_checked, CloudAccount};
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

/// The one cloud this module can deploy to.
const GCP: &str = "gcp";

/// Flags Aime appends itself; a plan that carries one is refused, as a read is.
const OWN_FLAGS: [&str; 4] = ["--project", "--account", "--format", "--quiet"];

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
const REFUSED_WORDS: [&str; 5] = ["delete", "destroy", "undelete", "purge", "abandon"];
const REFUSED_WORD_PREFIX: &str = "remove-";

/// Command groups a deployment has no business in: the account, the money, the
/// sign-in and the CLI itself.
const REFUSED_GROUPS: [&str; 6] = [
    "projects",
    "billing",
    "organizations",
    "auth",
    "config",
    "components",
];

/// The one command under `projects` a deployment legitimately needs.
///
/// Measured 2026-09-10 on the first deploy that got past billing: `gcloud run
/// deploy --source` failed with *Build failed because the default service
/// account is missing required IAM permissions* - the change Google made to
/// new projects, which every source deploy now meets. The AI diagnosed it
/// exactly and then said it was not allowed to fix it, because the fix is a
/// project-level grant. Refusing that sends the person to the web console for
/// the commonest failure there is, which is the opposite of the point.
///
/// So it is allowed, and fenced by `refuse_unsafe_grant`: only ADDING a
/// binding, only to a service account, and never a role that hands out the
/// right to hand out rights. The person still sees the whole command on the
/// confirm page before anything runs.
const PROJECT_IAM_GRANT: &str = "add-iam-policy-binding";

/// Roles a plan may not grant, because each is a way to take everything else.
///
/// `editor` and `owner` are the blanket grants; the other four are the
/// escalation paths - the right to change IAM, to mint service-account keys,
/// or to become another account.
const REFUSED_ROLES: [&str; 6] = [
    "roles/owner",
    "roles/editor",
    "roles/iam.securityAdmin",
    "roles/iam.serviceAccountKeyAdmin",
    "roles/iam.serviceAccountTokenCreator",
    "roles/resourcemanager.projectIamAdmin",
];

/// What a binding must name as its member: an identity that belongs to a
/// machine, never a person, a group, a domain or `allUsers`.
const SERVICE_ACCOUNT_MEMBER: &str = "serviceAccount:";

/// Flag families that replace or wipe what a service already has (gcloud's
/// own convention: `--set-*` replaces, `--update-*` merges, `--clear-*` wipes,
/// `--remove-*` deletes). Refused when the target exists.
const OVERRIDING_PREFIXES: [&str; 3] = ["--set-", "--clear-", "--remove-"];

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
) -> Result<CheckedPlan, String> {
    if cloud_id != GCP {
        return Err(format!("Aime does not deploy to {cloud_id} yet"));
    }
    let removal = removal.unwrap_or(false);
    let program = program_for(&app, &cloud_id);
    let mut checked = CheckedPlan::default();
    for step in plan.steps {
        match check_step(&program, &step, existing, removal).await {
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
    if request.cloud_id != GCP {
        return Err(format!("Aime does not deploy to {} yet", request.cloud_id));
    }
    let line = StepLine::parse(&request.step.args, request.existing)?;
    line.refuse_forbidden(request.removal)?;
    let program = program_for(&app, &request.cloud_id);
    let args = scoped(&request.step.args, &request.account);
    let mut command = cli_command(&program, &args);
    quiet(&mut command);
    let label = format!("gcloud {}", args.join(" "));
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
    if cloud_id != GCP {
        return Err(format!("Aime does not deploy to {cloud_id} yet"));
    }
    let program = program_for(&app, &cloud_id);
    let checked = check_read_allowing(&program, &cloud_id, NO_KIND, &read, &LOCATION_FLAGS).await?;
    let mut args = scoped(&checked.args, &account);
    args.extend(["--format".into(), "json".into()]);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    read_cli_checked(&program, &borrowed)
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

/// A step's arguments with the scope Aime pins: the project, and the account
/// that can see it. `--account` is left out when the cloud has no such level,
/// and never for gcloud in practice, where every project has an owner.
fn scoped(args: &[String], account: &CloudAccount) -> Vec<String> {
    let mut scoped = args.to_vec();
    scoped.extend(["--project".into(), account.id.clone()]);
    if !account.owner.is_empty() {
        scoped.extend(["--account".into(), account.owner.clone()]);
    }
    scoped
}

/// Every check a step has to pass: the shape rules, then the CLI's own `--help`.
async fn check_step(program: &str, step: &DeployStep, existing: bool, removal: bool) -> Result<(), String> {
    let line = StepLine::parse(&step.args, existing)?;
    line.refuse_forbidden(removal)?;
    line.words_exist(program).await
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
    fn parse(args: &'a [String], existing: bool) -> Result<Self, String> {
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
                if OWN_FLAGS.contains(&token.as_str()) {
                    return Err(format!("`{token}` is Aime's to add"));
                }
                if existing {
                    if let Some(prefix) = OVERRIDING_PREFIXES.iter().find(|p| token.starts_with(*p)) {
                        let family = &token[prefix.len()..];
                        return Err(format!(
                            "`{token}` replaces what the running service already has; \
                             use `--update-{family}` so its settings are kept"
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
    fn refuse_forbidden(&self, removal: bool) -> Result<(), String> {
        let first = self.heads[0];
        if REFUSED_GROUPS.contains(&first) {
            if first == "projects" && self.heads.get(1) == Some(&PROJECT_IAM_GRANT) {
                return self.refuse_unsafe_grant();
            }
            return Err(format!("`{first}` manages the account, not a deployment"));
        }
        if let Some(word) = self
            .heads
            .iter()
            .find(|word| REFUSED_WORDS.contains(word) || word.starts_with(REFUSED_WORD_PREFIX))
        {
            if !removal {
                return Err(format!(
                    "`{word}` removes something; a deployment only adds and updates"
                ));
            }
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
    fn refuse_unsafe_grant(&self) -> Result<(), String> {
        let value_of = |name: &str| {
            self.flags
                .iter()
                .find(|(flag, _)| *flag == name)
                .and_then(|(_, value)| *value)
        };
        let Some(member) = value_of("--member") else {
            return Err("a binding needs `--member`".into());
        };
        if !member.starts_with(SERVICE_ACCOUNT_MEMBER) {
            return Err(format!(
                "`{member}` is not a service account; a deployment may grant a project role \
                 only to a `serviceAccount:` - a person or `allUsers` is somebody's own decision"
            ));
        }
        let Some(role) = value_of("--role") else {
            return Err("a binding needs `--role`".into());
        };
        if REFUSED_ROLES.contains(&role) {
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
    async fn words_exist(&self, program: &str) -> Result<(), String> {
        let mut words: Vec<&str> = Vec::new();
        for head in &self.heads {
            if !is_command_word(head) {
                break;
            }
            let mut probe = words.clone();
            probe.push(head);
            probe.push("--help");
            if read_cli_checked(program, &probe).await.is_err() {
                break;
            }
            words.push(head);
        }
        if words.is_empty() {
            return Err(format!(
                "`gcloud {}` is not a command the Google Cloud CLI here knows",
                self.heads[0]
            ));
        }
        // A flag the command does not take would fail at run time with the
        // CLI's own words; the words themselves are what has to exist here.
        let _ = &self.flags;
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
        DeployStep {
            label: "step".into(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            changes: String::new(),
        }
    }

    fn shape(args: &[&str], existing: bool) -> Result<(), String> {
        let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        StepLine::parse(&owned, existing)?.refuse_forbidden(false)
    }

    /// The same line as the resource panel checks it: removal allowed.
    fn op_shape(args: &[&str]) -> Result<(), String> {
        let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        StepLine::parse(&owned, true)?.refuse_forbidden(true)
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

    #[test]
    fn the_scope_is_aimes_and_follows_the_plan_s_arguments() {
        let account = CloudAccount {
            id: "my-project".into(),
            label: String::new(),
            detail: String::new(),
            current: false,
            owner: "dev@example.com".into(),
            tenant: String::new(),
            sign_in: String::new(),
        };
        let args = scoped(&step(&["run", "deploy", "web"]).args, &account);
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
        StepLine::parse(&owned, false)
            .expect("shape")
            .words_exist("gcloud")
            .await
            .expect("`gcloud run deploy` exists and `web` is its positional");

        let wrong: Vec<String> = ["rnu", "deploy", "web"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        assert!(
            StepLine::parse(&wrong, false)
                .expect("shape")
                .words_exist("gcloud")
                .await
                .is_err(),
            "a misspelled group is not a command"
        );
    }
}
