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
    /// `None` when Aime has no measured way to ask this CLI who it is.
    pub signed_in: Option<bool>,
    /// Who the CLI is signed in as, in that cloud's own words.
    pub account: Option<String>,
    /// The command that signs in, for a person or for a terminal.
    pub sign_in_hint: String,
    /// How to get the CLI; a page rather than a command where no package
    /// manager on this platform carries it.
    pub install_hint: String,
}

/// A cloud Aime knows how to look for.
struct Cloud {
    id: &'static str,
    label: &'static str,
    command: &'static str,
    sign_in_hint: &'static str,
    install_hint: &'static str,
}

/// The four the user asked for, in the order the panel lists them.
const CLOUDS: [Cloud; 4] = [
    Cloud {
        id: "azure",
        label: "Azure",
        command: "az",
        sign_in_hint: "az login",
        install_hint: "winget install -e --id Microsoft.AzureCLI",
    },
    Cloud {
        id: "aws",
        label: "AWS",
        command: "aws",
        sign_in_hint: "aws configure",
        install_hint: "winget install -e --id Amazon.AWSCLI",
    },
    Cloud {
        id: "gcp",
        label: "Google Cloud",
        command: "gcloud",
        sign_in_hint: "gcloud auth login",
        install_hint: "https://cloud.google.com/sdk/docs/install",
    },
    Cloud {
        id: "supabase",
        label: "Supabase",
        command: "supabase",
        sign_in_hint: "supabase login",
        install_hint: "https://supabase.com/docs/guides/local-development/cli/getting-started",
    },
];

/// Every cloud, with whatever this machine could answer about it.
///
/// Never fails: a machine with none of them installed still gets four rows,
/// because "you have nothing set up" is the answer a new user needs most.
#[tauri::command]
pub async fn cloud_report() -> Vec<CloudStatus> {
    let mut report = Vec::with_capacity(CLOUDS.len());
    for cloud in CLOUDS {
        let version = crate::environment::version_of(cloud.command).await;
        let identity = if version.is_some() {
            identity_of(cloud.id).await
        } else {
            // Nothing to ask. A missing CLI is not a signed-out one, and
            // saying "not signed in" here would send a reader to the wrong fix.
            None
        };
        report.push(CloudStatus {
            id: cloud.id.to_string(),
            label: cloud.label.to_string(),
            command: cloud.command.to_string(),
            installed: version.is_some(),
            version,
            signed_in: identity.as_ref().map(|found| found.signed_in),
            account: identity.and_then(|found| found.account),
            sign_in_hint: cloud.sign_in_hint.to_string(),
            install_hint: cloud.install_hint.to_string(),
        });
    }
    report
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
