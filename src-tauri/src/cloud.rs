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
//! remembered (2026-09-02): `az account show` answers exit 0 with the
//! subscription in `name`, `aws sts get-caller-identity --output json` answers
//! exit 0 with `Account` and `Arn`. Neither `gcloud` nor `supabase` is on this
//! machine, so neither has a sign-in probe here: inventing the flag names would
//! be exactly the guess the project's rule forbids, and an unmeasured probe
//! that answers "not signed in" is worse than one that says nothing.

use crate::providers::cli_command;
use serde::Serialize;
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
        sign_in_hint: "gcloud auth login",
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

/// Every cloud, with whatever this machine could answer about it.
///
/// Never fails: a machine with none of them installed still gets four rows,
/// because "you have nothing set up" is the answer a new user needs most.
#[tauri::command]
pub async fn cloud_report(app: AppHandle) -> Vec<CloudStatus> {
    let mut report = Vec::with_capacity(CLOUDS.len());
    for cloud in CLOUDS {
        // PATH first, because a CLI the user installed themselves is the one
        // their own shell would run; Aime's own copy is the fallback.
        let mut path = None;
        let mut version = crate::environment::version_of(cloud.command).await;
        if version.is_none() {
            if let Some(own) = fetched_copy(&app, &cloud) {
                version = version_at(&own).await;
                if version.is_some() {
                    path = Some(own.to_string_lossy().to_string());
                }
            }
        }
        let installed = version.is_some();
        let identity = if installed {
            identity_of(cloud.id).await
        } else {
            // Nothing to ask. A missing CLI is not a signed-out one, and
            // saying "not signed in" here would send a reader to the wrong fix.
            None
        };
        // Only asked when there is something to offer: a machine that already
        // has the CLI does not need its package manager probed.
        let installable = !installed && crate::environment::can_run_install(hint_of(&cloud)).await;
        report.push(CloudStatus {
            id: cloud.id.to_string(),
            label: cloud.label.to_string(),
            command: cloud.command.to_string(),
            installed,
            version,
            path,
            signed_in: identity.as_ref().map(|found| found.signed_in),
            account: identity.and_then(|found| found.account),
            sign_in_hint: cloud.sign_in_hint.to_string(),
            installable,
            install_hint: hint_of(&cloud).to_string(),
        });
    }
    report
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
struct Identity {
    signed_in: bool,
    /// The cloud's own name for the account, when it gave one.
    account: Option<String>,
}

/// Asks one CLI who it is, for the two clouds whose answer was measured.
async fn identity_of(id: &str) -> Option<Identity> {
    match id {
        "azure" => Some(probe("az", &["account", "show", "--output", "json"], "name").await),
        "aws" => Some(probe("aws", &["sts", "get-caller-identity", "--output", "json"], "Arn").await),
        // See the module comment: no measured probe, so no claim.
        _ => None,
    }
}

/// Runs one read-only identity command and reads a single field out of its JSON.
///
/// A non-zero exit is the signed-out answer for both CLIs measured, so it is
/// read as that rather than as a failure. `AWS_PAGER` is emptied because the AWS
/// CLI pipes its own output through a pager by default, and a pager waiting for
/// a keypress inside a spawned process never returns.
async fn probe(command: &str, args: &[&str], field: &str) -> Identity {
    let mut cmd = cli_command(command, args.iter().copied());
    cmd.env("AWS_PAGER", "");
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

    #[test]
    fn every_cloud_the_user_asked_for_has_a_row() {
        let ids: Vec<&str> = CLOUDS.iter().map(|cloud| cloud.id).collect();
        assert_eq!(ids, vec!["azure", "aws", "gcp", "supabase"]);
    }

    #[tokio::test]
    async fn a_cloud_with_no_measured_probe_makes_no_claim() {
        // The rule this enforces: an unmeasured probe that answers "not signed
        // in" sends a reader to the wrong fix, so it answers nothing instead.
        assert!(identity_of("gcp").await.is_none());
        assert!(identity_of("supabase").await.is_none());
    }
}
