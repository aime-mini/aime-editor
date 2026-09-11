//! Google Cloud through `gcloud`, measured 2026-09-05 against 583.0.0 (winget)
//! and 502.0.0 (the copy the Cloud Code extension keeps), which answered alike.
//!
//! What was measured, signed out: `gcloud auth list --format=json` answers `[]`
//! with **exit 0** - so, unlike `az` and `aws`, a non-zero exit is not the
//! signed-out answer here and the list itself has to be read. `gcloud projects
//! list` and `gcloud asset search-all-resources` exit 1 with "You do not
//! currently have an active account selected"; `gcloud config list
//! --format=json` answers from disk, and a property that is unset is simply
//! absent from it. The shapes of a credentialed account (`account`, `status` in
//! `ACTIVE` or empty), of a project (`projectId`, `name`, `lifecycleState`,
//! `labels`) and of a search result (`name`, `assetType`, `displayName`,
//! `location`, `project`, `labels`) were first read from the CLI's own source
//! and the generated API clients beside its binary (`googlecloudsdk/core/
//! credentials/store.py`, `cloudresourcemanager_v1_messages.py`,
//! `cloudasset_v1_messages.py`) because no Google account was signed in here.
//! One is now: the fixtures below are captured answers, identifiers masked.
//!
//! What an "account" is here. Azure lists subscriptions and AWS profiles - the
//! unit a command is scoped by. In Google Cloud that unit is the PROJECT, and the
//! signed-in Google account sits above it: exactly Azure's user → subscription
//! shape, so the panel lists projects under the account that can see them.
//! Unlike the other two this reaches the network: gcloud keeps no project list
//! on disk, and `gcloud projects list` is the one call that answers. It is made
//! once per signed-in account when the tab is opened, and the answer is kept.
//!
//! One listing for every kind of resource, as for the other clouds: `gcloud
//! asset search-all-resources --scope projects/<id>` is Cloud Asset Inventory's
//! search, which answers for every searchable type at once and carries the
//! labels a team puts on its resources. Which project is charged for that call
//! decides whether it answers at all, and it is not the project being listed -
//! see `NO_QUOTA_PROJECT`. When the API really is unavailable the CLI says so
//! in its own words, with the page that enables it, and those words are what
//! the panel shows.

use super::{field, read_cli, CloudAccount, CloudResource, Identity};

/// The two files `gcloud config list --format=json` groups under `core`.
const CORE_SECTION: &str = "core";

/// Only a live project is somewhere to deploy; a project awaiting deletion
/// still lists, and listing it would offer a target that is about to vanish.
const LIVE_PROJECT: &str = "ACTIVE";

/// How many results one page carries; the API's own maximum.
const PAGE_SIZE: &str = "500";

/// One past the panel's cap, so a full answer proves there was more.
const SEARCH_LIMIT: &str = "10001";

/// Charge the search's quota the old way: send no quota project at all.
///
/// Measured 2026-09-10 against 583.0.0 on a real account, over 13 projects.
/// Cloud Asset's "is this API enabled" check follows the *quota* project,
/// which by default is whatever `core/project` this machine has set - not the
/// project being listed. So one `gcloud config set project` pointed at a
/// project without the API turns **every** tab in the panel red, including the
/// project the person is looking at, and `--billing-project <that project>`
/// only moves the same refusal onto it. `LEGACY` is the CLI's own sentinel for
/// the pre-quota-project behaviour: `creds.py: GetQuotaProject` answers `None`
/// for it and the `X-Goog-User-Project` header is left off, which is the state
/// in which the search answers for all 13. Aime reads someone else's cloud; it
/// must not depend on a property their terminal owns.
const NO_QUOTA_PROJECT: &str = "LEGACY";

/// Asset types the search returns that are not things a person deployed.
///
/// An enabled API is a switch on the project, not a resource in it; the first
/// real project looked at (2026-09-05) answered 28 rows, 23 of them
/// `serviceusage.googleapis.com/Service`, and the map read as an application
/// made of API switches. They are left out the way AWS's tagging API never
/// returns the account's enabled services either.
const NOT_A_RESOURCE: [&str; 1] = ["serviceusage.googleapis.com/Service"];

/// Who `gcloud` is signed in as: the accounts it holds credentials for.
///
/// The claim is "has credentials", not "has an active one": a project can be
/// read through any credentialed account with `--account`, which is how the
/// listing below works, and an account marked inactive is not signed out.
pub(super) async fn identity() -> Identity {
    let Ok(text) = read_cli("gcloud", &["auth", "list", "--format", "json"]).await else {
        return Identity {
            signed_in: false,
            account: None,
        };
    };
    let accounts = accounts_in(&text);
    Identity {
        signed_in: !accounts.is_empty(),
        account: accounts
            .iter()
            .find(|(_, active)| *active)
            .or(accounts.first())
            .map(|(account, _)| account.clone()),
    }
}

/// Every credentialed account and whether it is the active one, in the order
/// the CLI lists them.
fn accounts_in(json: &str) -> Vec<(String, bool)> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .map(|entry| (field(entry, "account"), field(entry, "status") == "ACTIVE"))
        .filter(|(account, _)| !account.is_empty())
        .collect()
}

/// The projects each signed-in account can see, under that account.
///
/// One `projects list` per account rather than one for the active account only:
/// a second Google account signed into the same CLI sees different projects,
/// and listing only the active one hides the rest exactly the way "one cloud,
/// one account" did for Azure.
pub(super) async fn projects() -> Result<Vec<CloudAccount>, String> {
    let listed = read_cli("gcloud", &["auth", "list", "--format", "json"]).await?;
    let config = read_cli("gcloud", &["config", "list", "--format", "json"]).await?;
    let current = current_project(&config);
    let mut projects = Vec::new();
    for (account, active) in accounts_in(&listed) {
        let text = read_cli(
            "gcloud",
            &["projects", "list", "--account", &account, "--format", "json"],
        )
        .await?;
        let current_here = if active { current.as_deref() } else { None };
        projects.extend(projects_in(&text, &account, current_here));
    }
    Ok(projects)
}

/// The project the CLI itself would use, when one is set.
fn current_project(config_json: &str) -> Option<String> {
    let config: serde_json::Value = serde_json::from_str(config_json).ok()?;
    let project = config.pointer(&format!("/{CORE_SECTION}/project"))?.as_str()?;
    (!project.is_empty()).then(|| project.to_string())
}

/// The live projects in one `projects list` answer, as the panel's accounts.
fn projects_in(json: &str, owner: &str, current: Option<&str>) -> Vec<CloudAccount> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .filter(|entry| field(entry, "lifecycleState") == LIVE_PROJECT)
        .map(|entry| {
            let id = field(entry, "projectId");
            let name = field(entry, "name");
            CloudAccount {
                label: if name.is_empty() { id.clone() } else { name },
                // The id is what every command takes, so it is shown even when
                // the display name is what a person recognises.
                detail: id.clone(),
                current: current == Some(id.as_str()),
                owner: owner.to_string(),
                tenant: String::new(),
                sign_in: sign_in_for(owner),
                id,
            }
        })
        .collect()
}

/// The command that signs one account in again, or a first account in.
///
/// `--no-launch-browser` is what keeps the browser in front of the editor (see
/// `sign_in.rs`); the account, when known, is the positional the CLI's own
/// `auth login --help` documents, so the consent page is for that account.
pub(super) fn sign_in_for(account: &str) -> String {
    if account.is_empty() {
        "gcloud auth login --no-launch-browser".to_string()
    } else {
        format!("gcloud auth login {account} --no-launch-browser")
    }
}

/// A billing account `gcloud` can see, and whether it can pay for anything.
///
/// The panel needs this for one question only: when a project is refused for
/// having no billing account, is there an open one to link it to? Linking is a
/// single command; CREATING or reopening one is not in the CLI at all
/// (measured 2026-09-10: `gcloud billing accounts` offers describe, list and
/// the IAM verbs, and no `create`), and that is the one thing the panel has to
/// send someone to Google's own page for.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BillingAccount {
    /// What `billing projects link --billing-account` takes: `01AFA3-…`.
    pub id: String,
    /// What a person recognises it by, e.g. `My Billing Account`.
    pub label: String,
    /// A closed account is listed too, and it can pay for nothing.
    pub open: bool,
}

/// Every billing account the signed-in Google account can see.
///
/// `gcloud billing accounts list` says it lists "active" accounts; measured on
/// a real account 2026-09-10, it also returns closed ones with `open: false`,
/// so the flag is read rather than the list being trusted to be usable.
pub(super) async fn billing_accounts() -> Result<Vec<BillingAccount>, String> {
    let text = read_cli("gcloud", &["billing", "accounts", "list", "--format", "json"]).await?;
    Ok(billing_accounts_in(&text))
}

/// The `billing accounts list` answer as the panel's billing accounts.
fn billing_accounts_in(json: &str) -> Vec<BillingAccount> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .filter_map(|entry| {
            let id = last_segment(&field(entry, "name"));
            if id.is_empty() {
                return None;
            }
            let label = field(entry, "displayName");
            Some(BillingAccount {
                open: entry.get("open").and_then(serde_json::Value::as_bool) == Some(true),
                label: if label.is_empty() { id.clone() } else { label },
                id,
            })
        })
        .collect()
}

/// Everything Cloud Asset Inventory can find in one project.
pub(super) async fn resources(project: &str) -> Result<Vec<CloudResource>, String> {
    let scope = format!("projects/{project}");
    let text = read_cli("gcloud", &search_args(&scope)).await?;
    Ok(resources_in(&text, project))
}

/// The listing call as a command line, so a test can hold it to the flags that
/// keep it independent of this machine.
fn search_args(scope: &str) -> [&str; 12] {
    [
        "asset",
        "search-all-resources",
        "--scope",
        scope,
        "--page-size",
        PAGE_SIZE,
        "--limit",
        SEARCH_LIMIT,
        "--billing-project",
        NO_QUOTA_PROJECT,
        "--format",
        "json",
    ]
}

/// The search results as the panel's resources.
///
/// The search answers `project` as `projects/<number>`, which is not what a
/// person or a command calls the project, so the group is the id the search
/// was scoped to. The name is the display name when the resource has one and
/// the last segment of its full name when it does not - a bucket's full name
/// is `//storage.googleapis.com/<bucket>`, and that segment is the bucket.
/// A display name is not always short, though: Pub/Sub answers a topic's whole
/// path (`projects/<id>/topics/<topic>`) and an IAM key its whole path plus the
/// key's hex id, so the last segment is taken from either side.
///
/// And a display name is not always an identifier: a service account's is
/// `Default compute service account` while `gcloud` addresses it by its email,
/// an API key's is `Browser key 1` while the command wants a uuid. What a
/// command line gets is always the last segment of the resource's own name.
fn resources_in(json: &str, project: &str) -> Vec<CloudResource> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .filter_map(|entry| {
            let id = field(entry, "name");
            let kind = field(entry, "assetType");
            if id.is_empty() || NOT_A_RESOURCE.contains(&kind.as_str()) {
                return None;
            }
            let display = field(entry, "displayName");
            Some(CloudResource {
                name: last_segment(if display.is_empty() { &id } else { &display }),
                // The label and the identifier are two different things here:
                // the display name is what a person recognises the resource by,
                // and the last segment of its own full name is what `gcloud`
                // takes on a command line. See `CloudResource::cli_name`.
                cli_name: last_segment(&id),
                kind,
                location: field(entry, "location"),
                group: project.to_string(),
                tags: labels_of(entry),
                id,
            })
        })
        .collect()
}

/// The last path segment of a full resource name.
fn last_segment(full_name: &str) -> String {
    full_name
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// Labels are Google Cloud's tags: a plain object of strings.
fn labels_of(entry: &serde_json::Value) -> std::collections::BTreeMap<String, String> {
    entry
        .get("labels")
        .and_then(serde_json::Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Makes one project the CLI's own default - and its owner the active account,
/// because a default project the active account cannot see is a terminal that
/// answers "permission denied" to everything.
pub(super) async fn set_default(account: &CloudAccount) -> Result<(), String> {
    if !account.owner.is_empty() {
        read_cli("gcloud", &["config", "set", "account", &account.owner]).await?;
    }
    read_cli("gcloud", &["config", "set", "project", &account.id]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `gcloud auth list --format=json`. The first entry is captured
    /// (2026-09-10, address masked); the second is the non-active shape the
    /// CLI's own `AcctInfo` writes (`store.py`: `status` is `ACTIVE` or
    /// empty), which this machine cannot produce because one account is
    /// signed in. Two accounts, one active - the shape that justifies listing
    /// projects per account, around the measured signed-out answer `[]`.
    const AUTH_LIST: &str = r#"[
  {
    "account": "dev@example.com",
    "status": "ACTIVE"
  },
  {
    "account": "ops@example.com",
    "status": ""
  }
]"#;

    /// `gcloud projects list --account dev@example.com --format=json`, four of
    /// the thirteen captured 2026-09-10 with ids, numbers and display names
    /// masked and their shapes kept: `labels` is absent unless something put
    /// one there (Firebase does), and **two projects answered the same display
    /// name**, which is why the panel shows the id underneath it. The deleting
    /// project and the nameless one are the `Project` message's other two
    /// documented states (`cloudresourcemanager_v1_messages.py`), not captured
    /// - all thirteen here are `ACTIVE` and named.
    const PROJECTS: &str = r#"[
  {
    "createTime": "2026-07-30T15:20:30.549Z",
    "lifecycleState": "ACTIVE",
    "name": "Shop Production",
    "projectId": "shop-prod-1234",
    "projectNumber": "123456789012"
  },
  {
    "createTime": "2019-05-02T01:57:19.801Z",
    "labels": {
      "firebase": "enabled"
    },
    "lifecycleState": "ACTIVE",
    "name": "My First Project",
    "projectId": "intense-hour-239401",
    "projectNumber": "188910246780"
  },
  {
    "createTime": "2019-04-29T08:12:05.117Z",
    "lifecycleState": "ACTIVE",
    "name": "My First Project",
    "projectId": "affable-fabric-236216",
    "projectNumber": "220977833936"
  },
  {
    "createTime": "2024-06-01T00:00:00.000Z",
    "lifecycleState": "DELETE_REQUESTED",
    "name": "Old Sandbox",
    "projectId": "old-sandbox",
    "projectNumber": "987654321098"
  },
  {
    "createTime": "2025-03-03T00:00:00.000Z",
    "lifecycleState": "ACTIVE",
    "name": "",
    "projectId": "bare-project",
    "projectNumber": "111111111111"
  }
]"#;

    /// `gcloud asset search-all-resources --format=json`, captured 2026-09-10
    /// from two real projects and masked onto one id. Every branch of the
    /// parser below is a shape that actually arrived, and three of them would
    /// not have been guessed: a **Pub/Sub topic and an IAM key answer a whole
    /// path as their `displayName`**, a Firebase app answers **no**
    /// `displayName` and **no** `location` at all, and an App Engine
    /// application carries its hostname in `additionalAttributes`. Written
    /// from memory of "what a search result looks like", this fixture would
    /// have gone on passing while the name column showed
    /// `projects/shop-prod-1234/topics/ShippingQueue`.
    const SEARCH: &str = r#"[
  {
    "additionalAttributes": {
      "defaultHostname": "shop-prod-1234.appspot.com"
    },
    "assetType": "appengine.googleapis.com/Application",
    "displayName": "shop-prod-1234",
    "location": "us-central1",
    "name": "//appengine.googleapis.com/projects/shop-prod-1234/locations/us-central1/applications/shop-prod-1234",
    "parentAssetType": "cloudresourcemanager.googleapis.com/Project",
    "parentFullResourceName": "//cloudresourcemanager.googleapis.com/projects/shop-prod-1234",
    "project": "projects/123456789012",
    "state": "SERVING"
  },
  {
    "assetType": "firebase.googleapis.com/FirebaseAppInfo",
    "name": "//firebase.googleapis.com/projects/123456789012/androidApps/1:123456789012:android:a1b2c3d4e5f6a7b8c9d0e1",
    "parentAssetType": "cloudresourcemanager.googleapis.com/Project",
    "parentFullResourceName": "//cloudresourcemanager.googleapis.com/projects/shop-prod-1234",
    "project": "projects/123456789012"
  },
  {
    "assetType": "firebase.googleapis.com/FirebaseProject",
    "displayName": "Shop Production",
    "labels": {
      "firebase": "enabled"
    },
    "name": "//firebase.googleapis.com/projects/123456789012",
    "parentFullResourceName": "//cloudresourcemanager.googleapis.com/projects/shop-prod-1234",
    "project": "projects/123456789012",
    "state": "ACTIVE"
  },
  {
    "assetType": "iam.googleapis.com/ServiceAccountKey",
    "createTime": "2020-01-14T07:43:11Z",
    "displayName": "projects/shop-prod-1234/serviceAccounts/firebase-adminsdk-mhtpx@shop-prod-1234.iam.gserviceaccount.com/keys/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "location": "global",
    "name": "//iam.googleapis.com/projects/shop-prod-1234/serviceAccounts/100000000000000000001/keys/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "parentAssetType": "iam.googleapis.com/ServiceAccount",
    "parentFullResourceName": "//iam.googleapis.com/projects/shop-prod-1234/serviceAccounts/firebase-adminsdk-mhtpx@shop-prod-1234.iam.gserviceaccount.com",
    "project": "projects/123456789012"
  },
  {
    "assetType": "pubsub.googleapis.com/Topic",
    "displayName": "projects/shop-prod-1234/topics/ShippingQueue",
    "location": "global",
    "name": "//pubsub.googleapis.com/projects/shop-prod-1234/topics/ShippingQueue",
    "parentAssetType": "cloudresourcemanager.googleapis.com/Project",
    "parentFullResourceName": "//cloudresourcemanager.googleapis.com/projects/shop-prod-1234",
    "project": "projects/123456789012"
  },
  {
    "assetType": "serviceusage.googleapis.com/Service",
    "displayName": "bigqueryreservation.googleapis.com",
    "location": "global",
    "name": "//serviceusage.googleapis.com/projects/123456789012/services/bigqueryreservation.googleapis.com",
    "parentAssetType": "cloudresourcemanager.googleapis.com/Project",
    "parentFullResourceName": "//cloudresourcemanager.googleapis.com/projects/shop-prod-1234",
    "project": "projects/123456789012",
    "state": "ENABLED"
  },
  {
    "assetType": "storage.googleapis.com/Bucket",
    "createTime": "2018-01-27T06:09:03Z",
    "displayName": "shop-prod-1234.appspot.com",
    "location": "us",
    "name": "//storage.googleapis.com/shop-prod-1234.appspot.com",
    "parentAssetType": "cloudresourcemanager.googleapis.com/Project",
    "parentFullResourceName": "//cloudresourcemanager.googleapis.com/projects/shop-prod-1234",
    "project": "projects/123456789012",
    "updateTime": "2018-01-27T06:09:03Z"
  }
]"#;

    #[test]
    fn signed_out_is_an_empty_list_with_exit_zero_so_the_list_itself_is_read() {
        // Measured: `[]`, exit 0. A probe reading only the exit code would call
        // this signed in.
        assert!(accounts_in("[]").is_empty());
        assert_eq!(
            accounts_in(AUTH_LIST),
            vec![
                ("dev@example.com".to_string(), true),
                ("ops@example.com".to_string(), false),
            ]
        );
        assert!(accounts_in("not json").is_empty());
    }

    #[test]
    fn projects_are_listed_under_their_account_and_dead_ones_are_left_out() {
        let projects = projects_in(PROJECTS, "dev@example.com", Some("shop-prod-1234"));
        assert_eq!(
            projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            [
                "shop-prod-1234",
                "intense-hour-239401",
                "affable-fabric-236216",
                "bare-project"
            ],
            "a project awaiting deletion is not somewhere to deploy"
        );
        let shop = &projects[0];
        assert_eq!(shop.label, "Shop Production");
        assert_eq!(shop.detail, "shop-prod-1234");
        assert!(shop.current);
        assert_eq!(shop.owner, "dev@example.com");
        assert_eq!(
            shop.sign_in,
            "gcloud auth login dev@example.com --no-launch-browser"
        );
        // Two projects really are called "My First Project": the id under the
        // name is the only thing that tells them apart.
        assert_eq!(projects[1].label, projects[2].label);
        assert_ne!(projects[1].detail, projects[2].detail);
        // A project with no display name is called by its id, not by nothing.
        assert_eq!(projects[3].label, "bare-project");
        assert!(!projects[3].current);
    }

    #[test]
    fn the_current_project_is_read_from_config_list_and_may_be_unset() {
        // Measured with nothing set: `core` holds only the properties given.
        assert_eq!(current_project(r#"{"core": {"disable_prompts": "1"}}"#), None);
        assert_eq!(
            current_project(r#"{"core": {"account": "dev@example.com", "project": "shop-prod-1234"}}"#),
            Some("shop-prod-1234".to_string())
        );
        assert_eq!(current_project(""), None);
    }

    #[test]
    fn a_search_result_becomes_a_resource_named_the_way_a_person_names_it() {
        let resources = resources_in(SEARCH, "shop-prod-1234");
        assert_eq!(
            resources.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            [
                "shop-prod-1234",
                "1:123456789012:android:a1b2c3d4e5f6a7b8c9d0e1",
                "Shop Production",
                "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                "ShippingQueue",
                "shop-prod-1234.appspot.com",
            ],
            "an enabled API is not a resource and is left out, and a topic is \
             called by its name and not by the path the search answers"
        );

        let app_engine = &resources[0];
        assert_eq!(app_engine.kind, "appengine.googleapis.com/Application");
        assert_eq!(app_engine.location, "us-central1");
        assert_eq!(
            app_engine.group, "shop-prod-1234",
            "the id the search was scoped to, not `projects/<number>`"
        );

        // No display name: the last segment of the full name is the name, and
        // a resource the search gives no location keeps an empty one.
        let firebase_app = &resources[1];
        assert!(firebase_app.location.is_empty());
        assert!(firebase_app.tags.is_empty());

        // Labels are the tags the panel groups applications by.
        let firebase_project = &resources[2];
        assert_eq!(
            firebase_project.tags.get("firebase").map(String::as_str),
            Some("enabled")
        );
    }

    /// `gcloud billing accounts list --format=json`, captured 2026-09-10 with
    /// the id and the display name masked. One account, and it is **closed** -
    /// the state that decides whether the panel can offer to link a project or
    /// has to send someone to Google's page. A second, open account is added
    /// in the same shape so both branches are covered; this machine has one.
    const BILLING_ACCOUNTS: &str = r#"[
  {
    "currencyCode": "USD",
    "displayName": "My Billing Account",
    "masterBillingAccount": "",
    "name": "billingAccounts/01AFA3-CF2B61-DE899A",
    "open": false,
    "parent": ""
  },
  {
    "currencyCode": "USD",
    "displayName": "",
    "masterBillingAccount": "",
    "name": "billingAccounts/0A1B2C-3D4E5F-6A7B8C",
    "open": true,
    "parent": ""
  }
]"#;

    #[test]
    fn a_billing_account_is_listed_with_whether_it_can_actually_pay() {
        let accounts = billing_accounts_in(BILLING_ACCOUNTS);
        assert_eq!(
            accounts,
            vec![
                BillingAccount {
                    id: "01AFA3-CF2B61-DE899A".to_string(),
                    label: "My Billing Account".to_string(),
                    open: false,
                },
                BillingAccount {
                    // No display name: the id is what a person is shown, the
                    // same rule a nameless project follows.
                    id: "0A1B2C-3D4E5F-6A7B8C".to_string(),
                    label: "0A1B2C-3D4E5F-6A7B8C".to_string(),
                    open: true,
                },
            ],
            "the id is the last segment of `name`, and a closed account is \
             listed rather than filtered out - the panel says why it cannot help"
        );
        assert!(billing_accounts_in("").is_empty());
        assert!(billing_accounts_in("[{}]").is_empty());
    }

    #[test]
    fn the_listing_does_not_depend_on_the_project_this_machine_has_set() {
        let args = search_args("projects/shop-prod-1234");
        let quota = args
            .iter()
            .position(|arg| *arg == "--billing-project")
            .expect("the listing says which project its quota is charged to");
        assert_eq!(
            args[quota + 1],
            NO_QUOTA_PROJECT,
            "measured over 13 projects: any real project here makes Cloud Asset \
             check its API against that one, so a `gcloud config set project` in \
             somebody's terminal turns every tab in the panel red"
        );
        assert!(
            !args.contains(&"--project"),
            "`--project` would set the quota project too, by the CLI's own help"
        );
    }

    #[test]
    fn nothing_here_panics_on_an_answer_that_is_not_the_expected_shape() {
        assert!(resources_in("", "p").is_empty());
        assert!(
            resources_in("[{}]", "p").is_empty(),
            "a result with no name is nothing to list"
        );
        assert!(projects_in("{}", "x", None).is_empty());
        assert_eq!(last_segment(""), "");
        assert_eq!(last_segment("//storage.googleapis.com/bucket/"), "bucket");
    }

    #[test]
    fn a_first_sign_in_names_no_account_and_a_repeat_names_the_one_that_expired() {
        assert_eq!(sign_in_for(""), "gcloud auth login --no-launch-browser");
        assert_eq!(
            sign_in_for("ops@example.com"),
            "gcloud auth login ops@example.com --no-launch-browser"
        );
    }
}
