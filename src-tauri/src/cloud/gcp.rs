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
//! `location`, `project`, `labels`) are read from the CLI's own source and the
//! generated API clients beside its binary (`googlecloudsdk/core/credentials/
//! store.py`, `cloudresourcemanager_v1_messages.py`, `cloudasset_v1_messages.py`)
//! because no signed-in Google account was on this machine to capture a live
//! answer from. That is the one gap left, and it is named in the tests.
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
//! labels a team puts on its resources. It needs the Cloud Asset API enabled on
//! the project; when it is not, the CLI says so in its own words, with the page
//! that enables it, and those words are what the panel shows.

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

/// Everything Cloud Asset Inventory can find in one project.
pub(super) async fn resources(project: &str) -> Result<Vec<CloudResource>, String> {
    let scope = format!("projects/{project}");
    let text = read_cli(
        "gcloud",
        &[
            "asset",
            "search-all-resources",
            "--scope",
            &scope,
            "--page-size",
            PAGE_SIZE,
            "--limit",
            SEARCH_LIMIT,
            "--format",
            "json",
        ],
    )
    .await?;
    Ok(resources_in(&text, project))
}

/// The search results as the panel's resources.
///
/// The search answers `project` as `projects/<number>`, which is not what a
/// person or a command calls the project, so the group is the id the search
/// was scoped to. The name is the display name when the resource has one and
/// the last segment of its full name when it does not - a bucket's full name
/// is `//storage.googleapis.com/<bucket>`, and that segment is the bucket.
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
                name: if display.is_empty() {
                    last_segment(&id)
                } else {
                    display
                },
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

    /// `gcloud auth list --format=json` as the CLI's own `AcctInfo` serialises
    /// (`store.py`: `status` is `ACTIVE` or empty), around the measured
    /// signed-out answer `[]`. Two accounts, one active - the shape that
    /// justifies listing projects per account.
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

    /// `gcloud projects list --format=json`, fields as the CLI's generated
    /// `Project` message names them (`cloudresourcemanager_v1_messages.py`).
    /// Not a captured answer: no Google account was signed in on this machine.
    const PROJECTS: &str = r#"[
  {
    "createTime": "2025-01-10T03:14:15.000Z",
    "labels": {
      "env": "prod"
    },
    "lifecycleState": "ACTIVE",
    "name": "Shop Production",
    "projectId": "shop-prod-1234",
    "projectNumber": "123456789012"
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

    /// `gcloud asset search-all-resources --format=json`, fields as the CLI's
    /// generated `ResourceSearchResult` names them (`cloudasset_v1_messages.py`).
    /// Not a captured answer, for the same reason.
    const SEARCH: &str = r#"[
  {
    "assetType": "compute.googleapis.com/Instance",
    "displayName": "web-1",
    "labels": {
      "app": "shop"
    },
    "location": "asia-southeast1-b",
    "name": "//compute.googleapis.com/projects/shop-prod-1234/zones/asia-southeast1-b/instances/web-1",
    "project": "projects/123456789012",
    "state": "RUNNING"
  },
  {
    "assetType": "storage.googleapis.com/Bucket",
    "location": "asia-southeast1",
    "name": "//storage.googleapis.com/shop-prod-uploads",
    "project": "projects/123456789012"
  },
  {
    "assetType": "run.googleapis.com/Service",
    "displayName": "",
    "location": "asia-southeast1",
    "name": "//run.googleapis.com/projects/shop-prod-1234/locations/asia-southeast1/services/api",
    "project": "projects/123456789012"
  },
  {
    "assetType": "serviceusage.googleapis.com/Service",
    "displayName": "bigqueryreservation.googleapis.com",
    "location": "global",
    "name": "//serviceusage.googleapis.com/projects/123456789012/services/bigqueryreservation.googleapis.com",
    "project": "projects/123456789012"
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
            ["shop-prod-1234", "bare-project"],
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
        // A project with no display name is called by its id, not by nothing.
        assert_eq!(projects[1].label, "bare-project");
        assert!(!projects[1].current);
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
            resources.len(),
            3,
            "an enabled API is not a resource and is left out"
        );

        let vm = &resources[0];
        assert_eq!(vm.name, "web-1");
        assert_eq!(vm.kind, "compute.googleapis.com/Instance");
        assert_eq!(vm.location, "asia-southeast1-b");
        assert_eq!(
            vm.group, "shop-prod-1234",
            "the id the search was scoped to, not `projects/<number>`"
        );
        assert_eq!(vm.tags.get("app").map(String::as_str), Some("shop"));

        // No display name: the last segment of the full name is the name.
        assert_eq!(resources[1].name, "shop-prod-uploads");
        assert_eq!(resources[2].name, "api");
        assert!(resources[2].tags.is_empty());
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
