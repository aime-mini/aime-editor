//! The clouds a project deploys to, and who this machine is on them.
//!
//! Aime never asks for a key, a secret or a password. Every cloud here already
//! ships a CLI that owns its own sign-in - device codes, SSO, refresh tokens,
//! the OS keychain - and re-implementing that would mean holding credentials
//! Aime has no business holding. So connecting *is* signing into the vendor's
//! CLI, and Aime's job is to say which CLIs are here, who they are signed in
//! as, and to hand the account over to the AI that will deploy with it.
//!
//! What each probe runs was measured against the real CLI rather than
//! remembered: `az account show` answers exit 0 with the subscription in
//! `name`, `aws sts get-caller-identity --output json` answers exit 0 with
//! `Account` and `Arn` (2026-09-02); `gcloud auth list --format=json` answers
//! the credentialed accounts, and `[]` with exit 0 when there are none
//! (2026-09-05, see `gcp.rs`); `supabase orgs list -o json` exits 1 with
//! "Access token not provided" when signed out (2026-09-05, see
//! `supabase.rs`). Nothing here was recalled: inventing a CLI's flags would be
//! exactly the guess the project's rule forbids, and an unmeasured probe that
//! answers "not signed in" is worse than one that says nothing.

mod bq;
pub mod credentials;
pub mod deploy;
mod gcp;
pub mod reads;
pub mod sign_in;
mod supabase;

use crate::program::Program;

use crate::providers::cli_command;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// One cloud, and what this machine can do with it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub id: String,
    pub label: String,
    /// The CLI that owns this cloud's sign-in.
    pub command: String,
    pub installed: bool,
    pub version: Option<String>,
    /// Where the CLI is, when it is a copy Aime downloaded rather than one on
    /// PATH. The AI is given this outright: a binary in Aime's data folder is
    /// invisible to a process that just types the command's name.
    pub path: Option<String>,
    /// `None` when Aime has no measured way to ask this CLI who it is.
    pub signed_in: Option<bool>,
    /// Who the CLI is signed in as, in that cloud's own words.
    pub account: Option<String>,
    /// The command that signs in, for a person or for a terminal.
    pub sign_in_hint: String,
    /// How to get the CLI; a page rather than a command where no package
    /// manager on this platform carries it.
    pub install_hint: String,
    /// Whether Aime could run that install here: the hint is a command, and the
    /// program it runs is on this machine. One rule shared with the environment
    /// rows, so the two can never disagree about whether a button would work.
    pub installable: bool,
}

/// A cloud Aime knows how to look for.
struct Cloud {
    id: &'static str,
    label: &'static str,
    command: &'static str,
    sign_in_hint: &'static str,
    /// One install hint per platform, because a package manager is not
    /// portable: winget exists only on Windows, and a `brew` line shown to a
    /// Windows user is a command they cannot run. Empty means "no single
    /// command installs this here" and the row falls back to `docs`.
    windows: &'static str,
    unix: &'static str,
    /// The vendor's own page, for the platform where no one command will do.
    docs: &'static str,
}

/// The Supabase CLI release Aime fetches, and the file inside it.
///
/// Pinned like every other download in this project rather than tracking
/// `latest`: an install that changes under the user is not reproducible, and a
/// version bump should be a commit somebody reviewed. Measured 2026-09-02
/// against the real release: all six platform archives exist under stable,
/// unversioned names, and the Windows one holds `supabase.exe` at its root.
const SUPABASE_VERSION: &str = "v2.116.0";

/// The release Aime fetches for one cloud, when it fetches one at all.
///
/// The single source of truth for "does Aime download this?": a boolean field
/// beside it could disagree with it, and the first cloud added after Supabase
/// would then have downloaded Supabase.
fn download_of(id: &str) -> Option<(String, &'static str)> {
    match id {
        "supabase" => Some(supabase_download()),
        _ => None,
    }
}

fn supabase_download() -> (String, &'static str) {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    let binary = if cfg!(target_os = "windows") {
        "supabase.exe"
    } else {
        "supabase"
    };
    (
        format!(
            "https://github.com/supabase/cli/releases/download/{SUPABASE_VERSION}/supabase_{platform}_{arch}.tar.gz"
        ),
        binary,
    )
}

/// The four the user asked for, in the order the panel lists them.
///
/// Every package name here was checked rather than remembered:
/// `winget show --id <id> --exact` for the Windows column, and Homebrew's own
/// API (`formulae.brew.sh/api/formula/<name>.json`, `/api/cask/<token>.json`)
/// for the Unix one. Two of those checks changed what shipped: `Google.CloudSDK`
/// turned out to exist in winget after all, and Homebrew carries the Supabase
/// CLI as a core formula - so Supabase, which has no winget package at all, is
/// still one click away on macOS and on a Linux box with brew.
const CLOUDS: [Cloud; 4] = [
    Cloud {
        id: "azure",
        label: "Azure",
        command: "az",
        sign_in_hint: "az login",
        windows: "winget install -e --id Microsoft.AzureCLI",
        unix: "brew install azure-cli",
        docs: "https://learn.microsoft.com/cli/azure/install-azure-cli",
    },
    Cloud {
        id: "aws",
        label: "AWS",
        command: "aws",
        sign_in_hint: "aws configure",
        windows: "winget install -e --id Amazon.AWSCLI",
        unix: "brew install awscli",
        docs: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
    },
    Cloud {
        id: "gcp",
        label: "Google Cloud",
        command: "gcloud",
        // The flag that makes the CLI print the page instead of opening it -
        // see `sign_in.rs` for why the browser must be opened by Aime.
        sign_in_hint: "gcloud auth login --no-launch-browser",
        windows: "winget install -e --id Google.CloudSDK",
        // A cask, not a formula - and casks are macOS-only, so a Linux box
        // gets the page. `brew install --cask` there fails, and a button that
        // fails is worse than a link that works.
        unix: "brew install --cask gcloud-cli",
        docs: "https://cloud.google.com/sdk/docs/install",
    },
    Cloud {
        id: "supabase",
        label: "Supabase",
        command: "supabase",
        sign_in_hint: "supabase login",
        // Nothing to type on any platform: `winget search supabase` finds
        // nothing, brew carries it but only where brew is installed, and the
        // documented Windows route is a scoop bucket plus an install - two
        // commands, which is not an install hint. Aime fetches the release
        // binary instead, which needs no package manager at all.
        windows: "",
        unix: "",
        docs: "https://supabase.com/docs/guides/local-development/cli/getting-started",
    },
];

/// The install hint for this platform, or the vendor's page when no single
/// command will do it here.
fn hint_of(cloud: &Cloud) -> &'static str {
    if download_of(cloud.id).is_some() {
        return crate::lsp::AIME_DOWNLOADS;
    }
    let own = if cfg!(target_os = "windows") {
        cloud.windows
    } else if cfg!(target_os = "macos") {
        cloud.unix
    } else if cloud.unix.starts_with("brew install --cask") {
        // See the Google Cloud row: casks do not exist off macOS.
        ""
    } else {
        cloud.unix
    };
    if own.is_empty() {
        cloud.docs
    } else {
        own
    }
}

/// Where Aime keeps the cloud CLIs it downloaded itself.
///
/// Beside `language-servers` rather than inside it: both are "tools Aime
/// fetched", but a folder named for language servers holding a cloud CLI is the
/// kind of small lie that costs somebody an hour later.
fn clouds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cloud-clis"))
}

/// The copy Aime fetched for this cloud, if it is on disk.
fn fetched_copy(app: &AppHandle, cloud: &Cloud) -> Option<PathBuf> {
    let (_, binary) = download_of(cloud.id)?;
    let path = clouds_dir(app).ok()?.join(binary);
    path.is_file().then_some(path)
}

/// Downloads one cloud's CLI into Aime's own folder.
///
/// The route that needs nothing already installed, which is why the Supabase
/// row can offer a button on Windows, macOS and Linux alike while the other
/// three depend on a package manager being there.
pub(crate) async fn cloud_download(
    app: AppHandle,
    id: &str,
    report: impl FnMut(String),
) -> Result<(), String> {
    let cloud = CLOUDS
        .iter()
        .find(|candidate| candidate.id == id)
        .ok_or_else(|| format!("No cloud called {id}"))?;
    let (url, binary) = download_of(id).ok_or_else(|| format!("Aime does not download a CLI for {id}"))?;
    crate::archive::fetch_binary(&url, &clouds_dir(&app)?, binary, cloud.label, report).await?;
    Ok(())
}

/// Whether Aime fetches this cloud's CLI itself, for the installer.
pub(crate) fn is_fetched(id: &str) -> bool {
    download_of(id).is_some()
}

/// The program that runs one cloud's CLI: its name when the user's own shell
/// would find it, else the copy Aime downloaded, by absolute path.
///
/// Every command that reaches a CLI goes through this, so a Supabase CLI that
/// exists only in Aime's data folder is reached by every listing and read and
/// not only by the version probe - which is how the first version of the
/// panel reported "installed" and then failed every command.
pub(crate) fn program_for(app: &AppHandle, cloud_id: &str) -> String {
    let Some(cloud) = CLOUDS.iter().find(|cloud| cloud.id == cloud_id) else {
        return cloud_id.to_string();
    };
    if Program::resolve(cloud.command).exists() {
        return cloud.command.to_string();
    }
    fetched_copy(app, cloud).map_or_else(
        || cloud.command.to_string(),
        |own| own.to_string_lossy().to_string(),
    )
}

/// Every cloud, with whatever this machine could answer about it.
///
/// Never fails: a machine with none of them installed still gets four rows,
/// because "you have nothing set up" is the answer a new user needs most.
///
/// The four are probed at once. Each probe is a CLI start-up plus, for three of
/// them, a round trip to the cloud; in a row they took the user 20-30 s of
/// "looking for cloud CLIs" (reported 2026-09-05), side by side they take the
/// slowest one.
#[tauri::command]
pub async fn cloud_report(app: AppHandle) -> Vec<CloudStatus> {
    let [azure, aws, gcp, supabase] = &CLOUDS;
    let (azure, aws, gcp, supabase) = tokio::join!(
        status_of(&app, azure),
        status_of(&app, aws),
        status_of(&app, gcp),
        status_of(&app, supabase),
    );
    vec![azure, aws, gcp, supabase]
}

/// One cloud, probed on its own - what the panel asks for while a terminal
/// sign-in is under way, so the other three CLIs are not probed every few
/// seconds along with it.
#[tauri::command]
pub async fn cloud_status(app: AppHandle, cloud_id: String) -> Option<CloudStatus> {
    let cloud = CLOUDS.iter().find(|cloud| cloud.id == cloud_id)?;
    Some(status_of(&app, cloud).await)
}

async fn status_of(app: &AppHandle, cloud: &Cloud) -> CloudStatus {
    // PATH first, because a CLI the user installed themselves is the one
    // their own shell would run; Aime's own copy is the fallback.
    let mut path = None;
    let mut version = crate::environment::version_of(cloud.command).await;
    if version.is_none() {
        if let Some(own) = fetched_copy(app, cloud) {
            version = version_at(&own).await;
            if version.is_some() {
                path = Some(own.to_string_lossy().to_string());
            }
        }
    }
    let installed = version.is_some();
    let identity = if installed {
        identity_of(app, cloud.id).await
    } else {
        // Nothing to ask. A missing CLI is not a signed-out one, and
        // saying "not signed in" here would send a reader to the wrong fix.
        None
    };
    // Only asked when there is something to offer: a machine that already
    // has the CLI does not need its package manager probed.
    let installable = !installed && crate::environment::can_run_install(hint_of(cloud)).await;
    CloudStatus {
        id: cloud.id.to_string(),
        label: cloud.label.to_string(),
        command: cloud.command.to_string(),
        installed,
        version,
        path,
        signed_in: identity.as_ref().map(|found| found.signed_in),
        account: identity.and_then(|found| found.account),
        sign_in_hint: sign_in_hint_of(app, cloud),
        installable,
        install_hint: hint_of(cloud).to_string(),
    }
}

/// The sign-in a person or a terminal runs for one cloud.
///
/// Supabase's is spelled with the program that will actually run, because its
/// sign-in goes to a terminal tab and a CLI that exists only in Aime's data
/// folder is not on that terminal's PATH - seen in the app, 2026-09-05: a
/// PowerShell answering "supabase is not recognized" under a panel that said
/// the CLI was installed.
fn sign_in_hint_of(app: &AppHandle, cloud: &Cloud) -> String {
    if cloud.id == "supabase" {
        supabase::sign_in_for(&program_for(app, cloud.id))
    } else {
        cloud.sign_in_hint.to_string()
    }
}

/// A program as a terminal command line: bare when it is a name on PATH, quoted
/// when it is a path - with PowerShell's call operator on Windows, because a
/// quoted string on its own is an expression there, not a command.
pub(crate) fn terminal_invocation(program: &str) -> String {
    let is_path = program.contains(['/', '\\']);
    if !is_path {
        return program.to_string();
    }
    if cfg!(target_os = "windows") {
        format!("& \"{program}\"")
    } else {
        format!("\"{program}\"")
    }
}

/// The version of a binary at a known path, spawned directly.
///
/// Not `environment::version_of`, which goes through `cmd /C` so that a bare
/// name like `az` is resolved the way a shell would. An absolute path needs no
/// resolving, and handing one to `cmd /C` is a trap: a user whose folder has a
/// space in it - `C:\Users\John Smith\...` - gets that line split in two and
/// the CLI reported missing right after Aime downloaded it.
async fn version_at(path: &std::path::Path) -> Option<String> {
    let mut command = tokio::process::Command::new(path);
    command.arg("--version");
    // tokio's Command carries this itself on Windows, which is why the rest of
    // the backend calls it without an import.
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = command.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.lines().next().unwrap_or_default().trim().to_string())
}

/// The install command for one cloud, for the installer that runs it.
///
/// Exists so `install_tool` can reach these the same way it reaches a language
/// server or an AI CLI: one queue, one log window, one place that decides
/// nothing is ever installed that Aime did not itself offer.
pub(crate) fn install_hint_for(id: &str) -> Option<String> {
    CLOUDS
        .iter()
        .find(|cloud| cloud.id == id)
        .map(|cloud| hint_of(cloud).to_string())
}

/// What a sign-in probe found.
pub(crate) struct Identity {
    pub(crate) signed_in: bool,
    /// The cloud's own name for the account, when it gave one.
    pub(crate) account: Option<String>,
}

/// Asks one CLI who it is, each in the way that was measured.
async fn identity_of(app: &AppHandle, id: &str) -> Option<Identity> {
    match id {
        "azure" => Some(probe("az", &["account", "show", "--output", "json"], "name").await),
        "aws" => Some(probe("aws", &["sts", "get-caller-identity", "--output", "json"], "Arn").await),
        "gcp" => Some(gcp::identity().await),
        "supabase" => Some(match supabase::cli(app) {
            Ok(cli) => supabase::identity(&cli).await,
            Err(reason) => {
                eprintln!("[cloud] supabase: {reason}");
                Identity {
                    signed_in: false,
                    account: None,
                }
            }
        }),
        // See the module comment: no measured probe, so no claim.
        _ => None,
    }
}

/// Runs one read-only identity command and reads a single field out of its JSON.
///
/// A non-zero exit is the signed-out answer for both CLIs that come through
/// here, so it is read as that rather than as a failure. `AWS_PAGER` is emptied
/// because the AWS CLI pipes its own output through a pager by default, and a
/// pager waiting for a keypress inside a spawned process never returns.
async fn probe(command: &str, args: &[&str], field: &str) -> Identity {
    let mut cmd = cli_command(command, args.iter().copied());
    quiet(&mut cmd);
    let Ok(output) = cmd.output().await else {
        return Identity {
            signed_in: false,
            account: None,
        };
    };
    if !output.status.success() {
        return Identity {
            signed_in: false,
            account: None,
        };
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Identity {
        signed_in: true,
        account: json_string(&text, field),
    }
}

/// One string field out of a flat JSON object, without a JSON parser.
///
/// These two payloads are small, flat and printed by the CLI itself, and the
/// field wanted is a single string. Pulling in a parse of the whole document to
/// read one key would be the heavier of the two mistakes available here - but
/// the reason this is safe is worth being explicit about: the search is for
/// `"<field>"` followed by a colon and a quoted value, so a nested object with
/// the same key would answer first and there is none in either payload.
pub(crate) fn json_string(text: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let after = text.split_once(&needle)?.1;
    let after = after.trim_start().strip_prefix(':')?.trim_start();
    let value = after.strip_prefix('"')?;
    let end = value.find('"')?;
    Some(value[..end].to_string())
}

/// One identity a cloud CLI already holds on this machine.
///
/// "One cloud, one account" was the shape of the first version and it was
/// wrong: measured on this machine 2026-09-03, `az` held **four subscriptions
/// across two signed-in users and two tenants**, and `aws` held **28
/// profiles**. Showing the first of those and calling it "the account" hides
/// almost everything a person came to the panel for.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccount {
    /// What a command needs to name it: a subscription id, a profile name, a
    /// project id.
    pub id: String,
    /// What a person recognises it by.
    pub label: String,
    /// The second line — the tenant, the project id, whatever narrows it further.
    pub detail: String,
    /// Whether this is the one the CLI would use with no override.
    pub current: bool,
    /// Who owns it, when that cloud has such a level *locally*.
    ///
    /// Azure does: `az account list` returns subscriptions, and each carries
    /// the signed-in user it belongs to — measured on this machine, four
    /// subscriptions across **two different users** and two tenants. Listing
    /// those four flat loses the one fact that tells them apart. Google Cloud
    /// has the same shape: projects under the signed-in Google account that can
    /// see them (`gcp.rs`).
    ///
    /// AWS does not. A profile is a name in a config file; which account and
    /// role it resolves to is only knowable by calling `sts
    /// get-caller-identity`, and doing that for 28 profiles to draw a list
    /// would be 28 network calls before the panel had drawn anything. So this
    /// is empty for AWS, and the tree simply lists profiles.
    pub owner: String,
    /// The Azure tenant the subscription lives in, which `az login` has to be
    /// told when a token for it expires. Empty for the other clouds.
    pub tenant: String,
    /// The command that signs into THIS account, as the CLI's own config says
    /// it: `az login` with the tenant, `aws configure` for the profile that
    /// actually holds the keys, `aws sso login` for an SSO profile, `gcloud
    /// auth login` naming the Google account. Worked out from disk (see
    /// `sign_in.rs`), never from the name of the cloud alone.
    pub sign_in: String,
}

/// One thing that exists in a cloud, in the words its own CLI used.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudResource {
    /// The full identifier — an Azure resource id, an AWS ARN, a Google Cloud
    /// full resource name (`//compute.googleapis.com/projects/…`).
    pub id: String,
    pub name: String,
    /// The name the CLI itself takes for this resource, which is not always the
    /// name a person reads.
    ///
    /// Measured 2026-09-11 over 162 real Google Cloud resources: five kinds of
    /// the twenty answer a display label where the command line wants an id. A
    /// service account reads `Default compute service account` and is addressed
    /// by its email, an API key reads `Browser key 1` and is addressed by a
    /// uuid, a project reads `My First Project` and is addressed by its id.
    /// Filling `<name>` from the label put a string with spaces in it on 47
    /// command lines, and every one of them failed. So the label stays for the
    /// eye, and this is what a command gets.
    #[serde(default)]
    pub cli_name: String,
    /// Resource type, as that cloud spells it.
    pub kind: String,
    /// Region, when the identifier carries one.
    pub location: String,
    /// The grouping that cloud uses: a resource group, an account number, a
    /// project id.
    pub group: String,
    /// The resource's own tags, as its cloud reports them.
    ///
    /// Carried rather than dropped because tags are how a team says which
    /// application a resource belongs to, and "which of these ten apps is this"
    /// is the question a list of a hundred resources has to answer. Azure
    /// returns them on `az resource list`, AWS on
    /// `resourcegroupstaggingapi get-resources` - it is that API's whole
    /// subject - and Google Cloud calls them labels and returns them on
    /// `asset search-all-resources`, so all three come for free with the call
    /// already being made.
    pub tags: BTreeMap<String, String>,
}

/// One account's inventory, and whether it is all of it.
///
/// The count matters as much as the rows: a subscription with four thousand
/// resources is a different thing to look at than one with nine, and a list
/// that silently stopped at a page boundary would read as the second.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudInventory {
    pub resources: Vec<CloudResource>,
    /// True when the cloud had more than Aime asked for.
    pub truncated: bool,
}

/// How many resources one listing brings back.
///
/// Bounded on purpose. AWS answers 100 at a time and pages with a token, so
/// "everything" is an unbounded number of round trips into somebody's account;
/// Azure answers in one payload whose size is whatever the subscription is.
///
/// Ten thousand, not two: the first cap was two thousand, and the first real
/// account measured against it (2026-09-03) held **6,252** resources - 3,730 of
/// them database snapshots - which the CLI returned in 24 seconds and 2.8 MB.
/// Cut at two thousand, the panel showed whichever third arrived first and the
/// applications a person came to see were simply absent. The UI still says
/// when this cap is hit rather than pretending it was the total.
const RESOURCE_CAP: usize = 10_000;

/// Every identity one cloud's CLI holds locally.
///
/// Read from the CLI's own local state where it has one, which is why the panel
/// can list them without touching the cloud: `az account list` and
/// `aws configure list-profiles` both answer from disk. Google Cloud keeps no
/// project list on disk, so its one listing call reaches the network (see
/// `gcp.rs`), and so does Supabase's, whose token lives in the keyring and
/// whose project list is the service's (`supabase.rs`).
#[tauri::command]
pub async fn cloud_accounts(app: AppHandle, cloud_id: String) -> Result<Vec<CloudAccount>, String> {
    match cloud_id.as_str() {
        "azure" => azure_accounts().await,
        "aws" => aws_profiles().await,
        "gcp" => gcp::projects().await,
        "supabase" => supabase::projects(&supabase::cli(&app)?).await,
        other => Err(format!("No cloud called {other}")),
    }
}

/// The billing accounts Google Cloud can see, open ones included.
///
/// Asked for only when a project has just been refused for having no billing
/// account: it decides whether the panel can offer the one command that fixes
/// that (`billing projects link`) or has to say plainly that only Google's own
/// page can open a billing account. No other cloud has this shape, so no other
/// cloud answers.
#[tauri::command]
pub async fn cloud_billing_accounts(cloud_id: String) -> Result<Vec<gcp::BillingAccount>, String> {
    match cloud_id.as_str() {
        "gcp" => gcp::billing_accounts().await,
        other => Err(format!("{other} has no billing accounts of its own")),
    }
}

/// Azure's subscriptions, each with the user and tenant it belongs to.
async fn azure_accounts() -> Result<Vec<CloudAccount>, String> {
    let text = read_cli("az", &["account", "list", "--output", "json"]).await?;
    let list: Vec<serde_json::Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .map(|entry| {
            let user = entry
                .pointer("/user/name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let tenant = field(entry, "tenantId");
            CloudAccount {
                id: field(entry, "id"),
                label: field(entry, "name"),
                detail: field(entry, "tenantDisplayName"),
                current: entry.get("isDefault").and_then(serde_json::Value::as_bool) == Some(true),
                owner: user.to_string(),
                sign_in: azure_sign_in(&tenant),
                tenant,
            }
        })
        .collect())
}

/// AWS's named profiles. The identity behind each one lives in the cloud, so it
/// is not asked for here — a panel that resolved 28 ARNs on open would make 28
/// network calls to draw a list.
async fn aws_profiles() -> Result<Vec<CloudAccount>, String> {
    let text = read_cli("aws", &["configure", "list-profiles"]).await?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| CloudAccount {
            id: name.to_string(),
            label: name.to_string(),
            detail: String::new(),
            current: name == "default",
            owner: String::new(),
            tenant: String::new(),
            sign_in: sign_in::aws_sign_in_for(name),
        })
        .collect())
}

/// The sign-in for one Azure subscription: device code, in its own tenant.
///
/// `--use-device-code` is what keeps the browser in front of the editor (see
/// `sign_in.rs`), and the tenant is what the CLI's own expiry message asks for
/// - measured 2026-09-03, `Status_InteractionRequired` ends with `az login
/// --tenant "<id>"`.
fn azure_sign_in(tenant: &str) -> String {
    if tenant.is_empty() {
        "az login --use-device-code".to_string()
    } else {
        format!("az login --use-device-code --tenant {tenant}")
    }
}

/// What exists in one account of one cloud.
///
/// One generic command per cloud rather than one assembled from per-service
/// commands: `az resource list` answers for every Azure type at once, `aws
/// resourcegroupstaggingapi get-resources` does the same for AWS (both measured
/// 2026-09-03), and `gcloud asset search-all-resources` for Google Cloud
/// (2026-09-05). A panel built out of `az webapp list` plus `az storage account
/// list` plus twenty more would be both slower and permanently incomplete.
/// Supabase has no such call and a project is made of three known things, so
/// its three listings are the exception that proves the rule (`supabase.rs`).
///
/// Called only when a person opens an account, never on the way past: this is
/// the one call here that reaches the network, and the fewer of those the
/// better.
#[tauri::command]
pub async fn cloud_resources(
    app: AppHandle,
    cloud_id: String,
    account: String,
) -> Result<CloudInventory, String> {
    let resources = match cloud_id.as_str() {
        "azure" => azure_resources(&account).await?,
        "aws" => aws_resources(&account).await?,
        "gcp" => gcp::resources(&account).await?,
        "supabase" => supabase::resources(&supabase::cli(&app)?, &account).await?,
        other => return Err(format!("No cloud called {other}")),
    };
    let truncated = resources.len() > RESOURCE_CAP;
    Ok(CloudInventory {
        resources: resources.into_iter().take(RESOURCE_CAP).collect(),
        truncated,
    })
}

async fn azure_resources(subscription: &str) -> Result<Vec<CloudResource>, String> {
    let text = read_cli(
        "az",
        &[
            "resource",
            "list",
            "--subscription",
            subscription,
            "--output",
            "json",
        ],
    )
    .await?;
    let list: Vec<serde_json::Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .map(|entry| CloudResource {
            id: field(entry, "id"),
            cli_name: field(entry, "name"),
            name: field(entry, "name"),
            kind: field(entry, "type"),
            location: field(entry, "location"),
            group: field(entry, "resourceGroup"),
            tags: azure_tags(entry),
        })
        .collect())
}

/// One past the cap, so a full page proves there was more rather than leaving
/// it ambiguous. Kept as a string because that is what the CLI takes.
const AWS_MAX_ITEMS: &str = "10001";

/// AWS answers with ARNs, which carry the type, the region and the account.
async fn aws_resources(profile: &str) -> Result<Vec<CloudResource>, String> {
    let text = read_cli(
        "aws",
        &[
            "resourcegroupstaggingapi",
            "get-resources",
            "--profile",
            profile,
            "--max-items",
            AWS_MAX_ITEMS,
            "--output",
            "json",
        ],
    )
    .await?;
    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let list = parsed
        .get("ResourceTagMappingList")
        .and_then(serde_json::Value::as_array)
        .ok_or("The AWS CLI answered without a resource list")?;
    Ok(list
        .iter()
        .filter_map(|entry| {
            let arn = entry.get("ResourceARN")?.as_str()?;
            Some(CloudResource {
                tags: aws_tags(entry),
                ..parse_arn(arn)
            })
        })
        .collect())
}

/// Splits an ARN into the parts a list needs to be readable.
///
/// `arn:aws:<service>:<region>:<account>:<tail>`, and the tail is where every
/// service spells itself differently. All of these arrived from one real
/// account (2026-09-03): `function:MyFunc`, `stack/Name/<uuid>`,
/// `secret:prod/db-AbCdEf`, `log-group:/aws/lambda/x:*`, `task-definition/web:12`,
/// `cluster-snapshot:rds:shop-2026`, a bare queue name, and API Gateway's
/// `/restapis/abc123` with an empty account. One rule covers them: the type is
/// what comes before the FIRST `:` or `/`, whichever is first, and the name is
/// everything after it - so `secret:prod/db` is a secret called `prod/db`, not
/// a `secret:prod`. Two facts about specific services are applied on top and
/// named as such: a CloudFormation stack ends in a generated id that is not
/// its name, and a log group ends in `:*`.
pub(crate) fn parse_arn(arn: &str) -> CloudResource {
    let parts: Vec<&str> = arn.split(':').collect();
    let service = parts.get(2).copied().unwrap_or_default();
    let tail = parts.get(5..).map(|rest| rest.join(":")).unwrap_or_default();
    let tail = tail.trim_start_matches('/');
    let separator = tail.find([':', '/']);
    let (kind_tail, name) = match separator {
        Some(at) => (&tail[..at], &tail[at + 1..]),
        None => ("", tail),
    };
    let name = strip_trailing_id(name.strip_suffix(":*").unwrap_or(name));
    CloudResource {
        tags: BTreeMap::new(),
        id: arn.to_string(),
        cli_name: name.clone(),
        name,
        kind: if kind_tail.is_empty() {
            service.to_string()
        } else {
            format!("{service}/{kind_tail}")
        },
        location: parts.get(3).copied().unwrap_or_default().to_string(),
        group: parts.get(4).copied().unwrap_or_default().to_string(),
    }
}

/// The resource name without the id a cloud appended to it.
///
/// A CloudFormation stack is `stack/PaymentPlan/e6146b90-d5a9-11ec-...`, and
/// its name is `PaymentPlan`; an SSM parameter is `parameter/shop/db-password`,
/// whose name really is `shop/db-password`. The difference is that the first
/// ends in a generated id, so that is what gets cut - a segment of hex and
/// dashes long enough to be an identifier and nothing a person would name
/// something.
fn strip_trailing_id(name: &str) -> String {
    let Some((head, last)) = name.rsplit_once('/') else {
        return name.to_string();
    };
    let generated = last.len() >= 8
        && last.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
        && last.chars().any(|ch| ch.is_ascii_digit());
    if generated {
        head.to_string()
    } else {
        name.to_string()
    }
}

/// Makes one account the CLI's own default, when the user asks for that.
///
/// Switching in the panel does **not** come here: every read passes
/// `--subscription`/`--profile`/`--project` explicitly, so looking at another
/// account changes nothing outside Aime. Silently rewriting the default a
/// person's own terminal uses would be the editor reaching outside its window.
/// This is the separate, deliberate action — and it exists for Azure and
/// Google Cloud, whose CLIs hold such a default (`az account set`, `gcloud
/// config set project`), not for AWS: an AWS profile is chosen per command, and
/// the closest thing is an environment variable Aime has no business writing
/// into a shell profile.
#[tauri::command]
pub async fn cloud_set_account(cloud_id: String, account: CloudAccount) -> Result<(), String> {
    match cloud_id.as_str() {
        "azure" => read_cli("az", &["account", "set", "--subscription", &account.id])
            .await
            .map(|_| ()),
        "gcp" => gcp::set_default(&account).await,
        other => Err(format!("Aime has no measured way to set a default for {other}")),
    }
}

/// Azure reports tags as a plain object, or `null` for a resource with none.
fn azure_tags(entry: &serde_json::Value) -> BTreeMap<String, String> {
    entry
        .get("tags")
        .and_then(serde_json::Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// AWS reports tags as a list of `{Key, Value}` pairs.
fn aws_tags(entry: &serde_json::Value) -> BTreeMap<String, String> {
    entry
        .get("Tags")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|tag| {
                    Some((
                        tag.get("Key")?.as_str()?.to_string(),
                        tag.get("Value")?.as_str().unwrap_or_default().to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A string field of a JSON object, empty when it is absent.
pub(crate) fn field(value: &serde_json::Value, name: &str) -> String {
    value
        .get(name)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Runs one read-only cloud command and hands back its stdout.
///
/// A non-zero exit is reported with the CLI's own words rather than flattened
/// to "signed out". Measured 2026-09-03: `az account list` answered from cache
/// while `az resource list` failed with `Status_InteractionRequired` on the
/// same machine — the CLI holds the account but its token has expired, and only
/// its own message tells the user to sign in again. `AWS_PAGER` is emptied for
/// the reason `probe` gives: a pager waiting for a keypress never returns.
/// A CLI that ran and refused, with the exit code kept.
///
/// The code is not decoration: the AWS CLI answers **252** when the command
/// line is wrong and something else when the service refused, and those two
/// call for completely different things to be said to the user.
pub(crate) struct CliFailure {
    pub(crate) code: Option<i32>,
    pub(crate) message: String,
}

pub(crate) async fn read_cli(command: &str, args: &[&str]) -> Result<String, String> {
    read_cli_checked(command, args)
        .await
        .map_err(|failure| failure.message)
}

/// Runs a CLI and hands back its stdout whatever it exits with; `Err` only when
/// the program could not be started at all.
///
/// For the CLI whose help is not an error but exits like one. Measured
/// 2026-09-11: `bq help show` describes a real command in 10,586 bytes on
/// stdout, writes nothing whatever to stderr, and exits 1 - so
/// `read_cli_checked` throws the answer away and reports "`bq` failed and said
/// nothing". Only a caller that reads the output rather than the exit code may
/// use this.
pub(crate) async fn read_cli_output(command: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = cli_command(command, args.iter().copied());
    quiet(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Could not run `{command}`: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Keeps a spawned CLI from waiting on a person who is not there.
///
/// `AWS_PAGER` is emptied for the reason `probe` gives; `gcloud` asks questions
/// at its prompt - enable this API?, take this survey? - and with prompts
/// disabled it takes the default and says what it did on stderr instead.
pub(super) fn quiet(cmd: &mut tokio::process::Command) {
    cmd.env("AWS_PAGER", "");
    cmd.env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1");
}

pub(crate) async fn read_cli_checked(command: &str, args: &[&str]) -> Result<String, CliFailure> {
    let mut cmd = cli_command(command, args.iter().copied());
    quiet(&mut cmd);
    let output = cmd.output().await.map_err(|e| CliFailure {
        code: None,
        message: format!("Could not run `{command}`: {e}"),
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(CliFailure {
            code: output.status.code(),
            message: if stderr.is_empty() {
                format!("`{command}` failed and said nothing")
            } else {
                stderr
            },
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod arn_tests {
    use super::parse_arn;

    /// Captured from `aws resourcegroupstaggingapi get-resources` on this
    /// machine (2026-09-03), with the account number masked — these are the
    /// three shapes that arrived, and they are not the same shape. Writing
    /// this fixture from memory of "what an ARN looks like" is how the
    /// CloudFormation tail ends up in the name column.
    #[test]
    fn an_arn_splits_into_the_parts_a_list_can_show() {
        let vault = parse_arn("arn:aws:backup:ap-southeast-2:000000000000:backup-vault:db");
        assert_eq!(
            vault.name, "db",
            "a colon separates the type from the name as well"
        );
        assert_eq!(vault.kind, "backup/backup-vault");
        assert_eq!(vault.location, "ap-southeast-2");
        assert_eq!(vault.group, "000000000000");

        // A stack carries a trailing uuid the name column must not show.
        let stack = parse_arn(
            "arn:aws:cloudformation:ap-southeast-2:000000000000:stack/PaymentPlan-AssignPaymentPlanConfig/e6146b90-d5a9-11ec-af06-0a345b1cc91a",
        );
        assert_eq!(stack.name, "PaymentPlan-AssignPaymentPlanConfig");
        assert_eq!(stack.kind, "cloudformation/stack");

        // S3 carries neither region nor account, which must not shift the name.
        let bucket = parse_arn("arn:aws:s3:::my-bucket");
        assert_eq!(bucket.name, "my-bucket");
        assert_eq!(bucket.kind, "s3");
        assert_eq!(bucket.location, "");

        // A secret's separator is a colon and its NAME holds a slash: splitting
        // on the slash first made the type `secret:prod` and lost every secret.
        let secret = parse_arn("arn:aws:secretsmanager:ap-southeast-2:000000000000:secret:prod/db-AbCdEf");
        assert_eq!(secret.kind, "secretsmanager/secret");
        assert_eq!(secret.name, "prod/db-AbCdEf");

        // A log group ends in `:*`, which is not part of its name.
        let logs = parse_arn("arn:aws:logs:ap-southeast-2:000000000000:log-group:/aws/lambda/x:*");
        assert_eq!(logs.kind, "logs/log-group");
        assert_eq!(logs.name, "/aws/lambda/x");

        // A task definition's revision is part of what identifies it.
        let task = parse_arn("arn:aws:ecs:ap-southeast-2:000000000000:task-definition/web:12");
        assert_eq!(task.kind, "ecs/task-definition");
        assert_eq!(task.name, "web:12");

        // API Gateway leaves the account empty and starts the tail with a slash.
        let api = parse_arn("arn:aws:apigateway:ap-southeast-2::/restapis/abc123");
        assert_eq!(api.kind, "apigateway/restapis");
        assert_eq!(api.name, "abc123");
        assert_eq!(api.group, "");

        // A queue has no type segment at all; that is a fact about SQS.
        let queue = parse_arn("arn:aws:sqs:ap-southeast-2:000000000000:order-queue");
        assert_eq!(queue.kind, "sqs");
        assert_eq!(queue.name, "order-queue");
    }

    /// Nothing here may panic on a string that is not an ARN at all: the input
    /// comes off the network.
    #[test]
    fn a_malformed_arn_is_read_as_far_as_it_goes() {
        assert_eq!(parse_arn("").name, "");
        assert_eq!(parse_arn("arn:aws").name, "");
        assert_eq!(parse_arn("not-an-arn").name, "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `az account show` really prints, captured from a run rather
    /// than remembered - key order, indentation and the mix of value types are
    /// all as the CLI emits them. Only the identifiers are stand-ins: a real
    /// tenant and subscription have no business in a repository.
    const AZ: &str = r#"{
  "environmentName": "AzureCloud",
  "id": "00000000-0000-0000-0000-000000000000",
  "isDefault": true,
  "name": "Example Subscription",
  "state": "Enabled"
}"#;

    /// The same, from `aws sts get-caller-identity --output json` - note the
    /// four-space indent, which is the CLI's own and not this file's.
    const AWS: &str = r#"{
    "UserId": "AIDAEXAMPLEUSERID0000",
    "Account": "000000000000",
    "Arn": "arn:aws:iam::000000000000:user/example-dev"
}"#;

    #[test]
    fn reads_the_subscription_azure_reports() {
        assert_eq!(json_string(AZ, "name"), Some("Example Subscription".to_string()));
    }

    #[test]
    fn reads_the_identity_aws_reports() {
        assert_eq!(
            json_string(AWS, "Arn"),
            Some("arn:aws:iam::000000000000:user/example-dev".to_string())
        );
    }

    #[test]
    fn answers_nothing_for_a_field_that_is_not_there() {
        assert_eq!(json_string(AZ, "Arn"), None);
        assert_eq!(json_string("not json at all", "name"), None);
    }

    #[test]
    fn answers_nothing_when_the_value_is_not_a_string() {
        // `isDefault` is a boolean. Reading it as a string would put "true," or
        // half the rest of the document into an account label.
        assert_eq!(json_string(AZ, "isDefault"), None);
    }

    #[test]
    fn the_installer_can_reach_every_cloud_it_offers_a_command_for() {
        // Whatever this build runs on, every cloud answers something and no
        // cloud answers a command belonging to another platform.
        for cloud in CLOUDS.iter() {
            let hint = install_hint_for(cloud.id).expect("every cloud has a hint");
            assert!(!hint.is_empty(), "{} answered nothing", cloud.id);
            if is_fetched(cloud.id) {
                continue;
            }
            let manager = if cfg!(target_os = "windows") {
                "brew"
            } else {
                "winget"
            };
            assert!(
                !hint.starts_with(manager),
                "{} offers {manager}, which is not this platform's",
                cloud.id
            );
        }
        assert_eq!(install_hint_for("not-a-cloud"), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_offers_the_winget_packages_that_exist() {
        // Checked with `winget show --id <id> --exact`, not remembered.
        assert_eq!(
            install_hint_for("azure").as_deref(),
            Some("winget install -e --id Microsoft.AzureCLI")
        );
        assert_eq!(
            install_hint_for("gcp").as_deref(),
            Some("winget install -e --id Google.CloudSDK")
        );
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn linux_gets_brew_where_a_formula_exists_and_a_page_where_only_a_cask_does() {
        // Homebrew runs on Linux and carries the Azure and AWS formulae, so
        // those rows are one click there too. Casks are macOS-only, which is
        // why the Google Cloud row is a page rather than a command that fails.
        assert_eq!(
            install_hint_for("azure").as_deref(),
            Some("brew install azure-cli")
        );
        assert!(install_hint_for("gcp").is_some_and(|hint| hint.starts_with("https://")));
    }

    #[test]
    fn the_cli_aime_fetches_is_the_same_offer_on_every_platform() {
        // The whole reason for fetching rather than delegating: Supabase has no
        // winget package, brew only helps where brew is installed, and its
        // documented Windows route is two commands - so a download is the one
        // answer that is identical on Windows, macOS and Linux.
        assert!(is_fetched("supabase"));
        assert_eq!(
            install_hint_for("supabase").as_deref(),
            Some(crate::lsp::AIME_DOWNLOADS)
        );
        for other in ["azure", "aws", "gcp"] {
            assert!(!is_fetched(other), "{other} should come from a package manager");
        }
    }

    #[test]
    fn the_download_names_this_platform_and_this_architecture() {
        // A URL built for the wrong platform downloads happily and then fails
        // to run, which is the slowest possible way to find out.
        let (url, binary) = supabase_download();
        assert!(url.starts_with("https://github.com/supabase/cli/releases/download/"));
        assert!(
            url.contains(SUPABASE_VERSION),
            "the release must be pinned: {url}"
        );
        let platform = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        };
        assert!(
            url.ends_with(&format!("supabase_{platform}_{arch}.tar.gz")),
            "{url}"
        );
        assert_eq!(
            binary,
            if cfg!(target_os = "windows") {
                "supabase.exe"
            } else {
                "supabase"
            }
        );
    }

    /// A name on PATH is typed as it is; a path is quoted, and PowerShell
    /// needs `&` in front to run a quoted path rather than echo it.
    #[test]
    fn a_downloaded_cli_is_invoked_by_its_quoted_path() {
        assert_eq!(terminal_invocation("supabase"), "supabase");
        let path = if cfg!(target_os = "windows") {
            r"C:\Users\John Smith\AppData\Roaming\aime\cloud-clis\supabase.exe"
        } else {
            "/home/john smith/.local/share/aime/cloud-clis/supabase"
        };
        let expected = if cfg!(target_os = "windows") {
            format!("& \"{path}\"")
        } else {
            format!("\"{path}\"")
        };
        assert_eq!(terminal_invocation(path), expected);
    }

    #[test]
    fn every_cloud_the_user_asked_for_has_a_row() {
        let ids: Vec<&str> = CLOUDS.iter().map(|cloud| cloud.id).collect();
        assert_eq!(ids, vec!["azure", "aws", "gcp", "supabase"]);
    }
}
