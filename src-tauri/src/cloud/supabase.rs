//! Supabase through its CLI, measured 2026-09-05 against v2.116.0 - the
//! release Aime itself downloads (`SUPABASE_VERSION`), run from a scratch copy.
//!
//! What was measured. Signed out, every remote command exits 1 and writes
//! "Access token not provided. Supply an access token by running `supabase
//! login`…" to stderr; with a token the service rejects, exit 1 and
//! "Unauthorized" - so a non-zero exit is the signed-out answer, as for `az` and
//! `aws`. `supabase login --token …` stored the token in the OS keyring, not in
//! a file: `~/.supabase` held only `telemetry.json`, which every command
//! rewrites, so there is no file a sign-in leaves behind to watch for
//! (`credentials.rs` has no Supabase entry, and the panel polls after a
//! terminal sign-in instead). `supabase login --no-browser` refuses to run
//! outside a TTY - "Cannot use automatic login flow inside non-TTY
//! environments" - which is why the sign-in runs in a terminal tab and not
//! through `sign_in.rs`. And `supabase <anything> --help` exits 0 even for a
//! command that does not exist (it prints the nearest parent's help), so a read
//! is checked by walking the CLI's own SUBCOMMANDS tree instead (`reads.rs`).
//!
//! The JSON shapes are the Management API's, which the CLI prints verbatim with
//! `-o json`. They were first read from the API's own OpenAPI document
//! (`api.supabase.com/api/v1-json`, schemas
//! `V1ProjectWithDatabaseResponse_Output`, `OrganizationResponseV1_Output`,
//! `FunctionResponse_Output`, `BranchResponse_Output`) because no Supabase
//! account was signed in here. One is now, and the fixtures below are captured
//! answers with the identifiers masked (2026-09-21, CLI 2.116.0). Capturing
//! them corrected a guess the document had allowed: `organization_slug` is not
//! a readable slug but a second copy of `organization_id`, so the fallback for
//! an organization the token cannot name shows an id and not a name. The one
//! project this account has holds no Edge Function and no preview branch -
//! `functions list` and `branches list` both answered `[]`, which is captured
//! too. Their non-empty answers were captured on 2026-09-23 by deploying a
//! probe function to that project and removing it again; a preview branch
//! needs the Pro plan (the create answers 402 `entitlement_required` on Free),
//! so the one branch captured is the default one that attempt left behind.
//!
//! What an "account" is here: a PROJECT, under the organization that owns it -
//! the same two levels as Azure's user → subscription and Google's account →
//! project. A project is one Postgres database with Edge Functions and preview
//! branches around it, so those are its resources; there is no generic
//! inventory call, and the three listings that exist are the ones made.

use super::{field, read_cli, CloudAccount, CloudResource, Identity};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The scheme Aime gives a Supabase resource's identifier, since the CLI has
/// none: `supabase://<ref>/functions/<slug>`.
const ID_SCHEME: &str = "supabase://";

/// The status a healthy project reports; anything else is worth a second line.
const HEALTHY: &str = "ACTIVE_HEALTHY";

/// Told to every call, and to the sign-in a person types.
///
/// The CLI guesses whether a robot is driving it ("agent detection", its
/// `--agent` flag) from the environment, and an Aime launched by an AI agent
/// inherits that agent's variables (`AI_AGENT=claude-code_…`, measured
/// 2026-09-05). Guessed wrong, it answers a person's `login` in a terminal with
/// `NonInteractiveError: Cannot prompt for input in JSON output mode` and wraps
/// every answer in `{"_tag":…}`. Aime knows better than a guess: its own calls
/// want the plain `-o json` the schemas describe, and a sign-in in a terminal
/// tab has a person at the keyboard by definition.
const HUMAN_PRESENT: [&str; 2] = ["--agent", "no"];

/// Told to every read. Measured against a real project (2026-09-05):
/// `postgres-config get` answers "must set the --experimental flag to run this
/// command" without it and the configuration with it, while the commands that
/// never needed it (`functions list`) answer the same either way. A read is a
/// read; which of them the vendor still calls experimental is not a person's
/// problem to remember.
const EXPERIMENTAL: [&str; 1] = ["--experimental"];

/// Where the CLI may keep its project folder: a directory of Aime's, never the
/// one the app happens to run in.
///
/// Measured 2026-09-05: any call carrying `--project-ref` writes
/// `supabase/.temp/cli-latest` and `linked-project.json` into the CURRENT
/// WORKING DIRECTORY, which for a `tauri dev` build is the repository itself -
/// so the first read of a project dropped a folder into the source tree, Vite
/// saw a new file and reloaded the whole window every time the cloud panel
/// opened. `--workdir` moves those files, measured, to the directory it names.
const WORKDIR: &str = "supabase-work";

/// The Supabase CLI as Aime runs it: which program, and where it may write.
pub(super) struct Cli {
    program: String,
    workdir: PathBuf,
}

/// The CLI for this app: on PATH or Aime's own copy, with a work folder of its own.
pub(super) fn cli(app: &AppHandle) -> Result<Cli, String> {
    let workdir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cloud-clis")
        .join(WORKDIR);
    std::fs::create_dir_all(&workdir).map_err(|e| format!("could not create {}: {e}", workdir.display()))?;
    Ok(Cli {
        program: super::program_for(app, "supabase"),
        workdir,
    })
}

impl Cli {
    /// The program a read is run with.
    pub(super) fn program(&self) -> &str {
        &self.program
    }

    /// The flags every call carries, after the command's own.
    pub(super) fn flags(&self) -> Vec<String> {
        flags_for(&self.workdir)
    }

    async fn call(&self, args: &[&str]) -> Result<String, String> {
        let flags = self.flags();
        let mut full: Vec<&str> = args.to_vec();
        full.extend(flags.iter().map(String::as_str));
        read_cli(&self.program, &full).await
    }
}

/// The flags every OPERATION or deploy step carries, for `cloud/dialect.rs`.
///
/// The read flags plus `--yes`. Read from this CLI's own `--help` on this
/// machine: *answer yes to all prompts*. Aime adds it because by the time a
/// command gets here the person has already read it in full and, for anything
/// that removes something, typed the resource's own name - while a CLI that
/// stops to ask on a pipe does not stop, it hangs, which this project has paid
/// for three times now (the `gcloud` billing prompt of session 33, the `az`
/// extension prompt of session 37). A plan may not write it: it is Aime's to
/// decide, not the AI's.
///
/// `working_in` is where the CLI may keep a project, and it decides what this
/// CLI can do at all. Nothing - an operation on a resource - keeps it in
/// Aime's own folder, which is what stops a panel from dropping `supabase/`
/// into somebody's repository (session 33). A DEPLOYMENT passes the repository
/// itself, because that is where a Supabase project lives: `supabase/config.
/// toml`, `supabase/functions/<slug>/index.ts` and the migrations are files in
/// it, and `link`, `functions deploy` and `db push` are only meaningful there.
/// Carrying the operations' answer into a deploy was what made Aime say for
/// three sessions that this cloud could not be deployed to - a restriction of
/// its own, read back as the CLI's.
pub(super) fn step_flags(app: &AppHandle, working_in: Option<&str>) -> Result<Vec<String>, String> {
    let mut flags = match working_in {
        Some(project) => flags_for(Path::new(project)),
        None => cli(app)?.flags(),
    };
    flags.push("--yes".to_string());
    Ok(flags)
}

/// Agent guess off, experimental reads on, project folder in Aime's own place.
fn flags_for(workdir: &Path) -> Vec<String> {
    let mut flags: Vec<String> = HUMAN_PRESENT
        .iter()
        .chain(EXPERIMENTAL.iter())
        .map(|flag| (*flag).to_string())
        .collect();
    flags.push("--workdir".to_string());
    flags.push(workdir.to_string_lossy().to_string());
    flags
}

/// Who the CLI is signed in as: the organizations its token can see.
///
/// The one command that answers cheaply and needs nothing but the token;
/// Supabase has no local "who am I" - the token lives in the keyring and the
/// CLI has no command to name its owner without asking the service.
pub(super) async fn identity(cli: &Cli) -> Identity {
    let Ok(text) = cli.call(&["orgs", "list", "-o", "json"]).await else {
        return Identity {
            signed_in: false,
            account: None,
        };
    };
    let organizations = organizations_in(&text);
    Identity {
        signed_in: true,
        account: organizations.values().next().cloned(),
    }
}

/// Organizations by id, from `orgs list -o json`.
fn organizations_in(json: &str) -> BTreeMap<String, String> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .map(|entry| (field(entry, "id"), field(entry, "name")))
        .filter(|(id, _)| !id.is_empty())
        .collect()
}

/// Every project the token can see, under its organization.
pub(super) async fn projects(cli: &Cli) -> Result<Vec<CloudAccount>, String> {
    let organizations = organizations_in(&cli.call(&["orgs", "list", "-o", "json"]).await?);
    let text = cli.call(&["projects", "list", "-o", "json"]).await?;
    Ok(projects_in(&text, &organizations, &sign_in_for(&cli.program)))
}

/// The projects in one `projects list -o json` answer, as the panel's accounts.
///
/// The ref is what every command takes (`--project-ref`), so it is the id and
/// the second line; the organization is named rather than numbered, from the
/// list that carries the names.
fn projects_in(json: &str, organizations: &BTreeMap<String, String>, sign_in: &str) -> Vec<CloudAccount> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .filter_map(|entry| {
            let reference = field(entry, "ref");
            if reference.is_empty() {
                return None;
            }
            let organization_id = field(entry, "organization_id");
            let owner = organizations
                .get(&organization_id)
                .cloned()
                .unwrap_or_else(|| field(entry, "organization_slug"));
            let status = field(entry, "status");
            let detail = if status.is_empty() || status == HEALTHY {
                field(entry, "region")
            } else {
                format!("{} · {status}", field(entry, "region"))
            };
            Some(CloudAccount {
                label: field(entry, "name"),
                detail,
                // The CLI links a project to a working directory, not to the
                // machine, so there is no default here to mark.
                current: false,
                owner,
                tenant: String::new(),
                sign_in: sign_in.to_string(),
                id: reference,
            })
        })
        .collect()
}

/// The sign-in, which has to run in a terminal (see the module comment) - so it
/// names the program the way a terminal has to be told it.
pub(super) fn sign_in_for(program: &str) -> String {
    format!(
        "{} login {}",
        super::terminal_invocation(program),
        HUMAN_PRESENT.join(" ")
    )
}

/// What one project is made of: its database, its Edge Functions, its preview
/// branches.
///
/// Three calls, because that is what exists - the CLI has no inventory command.
/// A failed function listing is the project's answer and is reported; a failed
/// branch listing is not, because branching is a feature a project may simply
/// not have, and a project without it must still show its database. That
/// failure is logged rather than lost.
pub(super) async fn resources(cli: &Cli, project_ref: &str) -> Result<Vec<CloudResource>, String> {
    let projects = cli.call(&["projects", "list", "-o", "json"]).await?;
    let project = project_in(&projects, project_ref)
        .ok_or_else(|| format!("The token no longer sees a project called {project_ref}"))?;
    let region = field(&project, "region");
    let mut resources = vec![database_of(&project, &region)];

    let functions = cli
        .call(&["functions", "list", "--project-ref", project_ref, "-o", "json"])
        .await?;
    resources.extend(functions_in(&functions, project_ref, &region));

    match cli
        .call(&["branches", "list", "--project-ref", project_ref, "-o", "json"])
        .await
    {
        Ok(branches) => resources.extend(branches_in(&branches, project_ref, &region)),
        Err(reason) => eprintln!("[cloud] supabase branches of {project_ref} not listed: {reason}"),
    }
    Ok(resources)
}

/// One project's object out of the list, by ref.
fn project_in(json: &str, project_ref: &str) -> Option<serde_json::Value> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.into_iter().find(|entry| field(entry, "ref") == project_ref)
}

/// The project's Postgres database, named by its host - which is also the one
/// thing a developer connecting to it needs first.
fn database_of(project: &serde_json::Value, region: &str) -> CloudResource {
    let reference = field(project, "ref");
    let database = project.get("database").cloned().unwrap_or_default();
    let host = field(&database, "host");
    let mut tags = BTreeMap::new();
    for (tag, key) in [
        ("engine", "postgres_engine"),
        ("version", "version"),
        ("release_channel", "release_channel"),
    ] {
        let value = field(&database, key);
        if !value.is_empty() {
            tags.insert(tag.to_string(), value);
        }
    }
    let status = field(project, "status");
    if !status.is_empty() {
        tags.insert("status".to_string(), status);
    }
    let name = if host.is_empty() {
        field(project, "name")
    } else {
        host
    };
    CloudResource {
        id: format!("{ID_SCHEME}{reference}/database"),
        cli_name: name.clone(),
        name,
        kind: "supabase/database".to_string(),
        location: region.to_string(),
        group: reference,
        tags,
    }
}

/// Edge Functions, by slug - the name the CLI takes on every functions command.
fn functions_in(json: &str, project_ref: &str, region: &str) -> Vec<CloudResource> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .filter_map(|entry| {
            let slug = field(entry, "slug");
            if slug.is_empty() {
                return None;
            }
            let mut tags = BTreeMap::new();
            for key in ["status", "version", "verify_jwt"] {
                if let Some(value) = entry.get(key) {
                    tags.insert(key.to_string(), scalar(value));
                }
            }
            Some(CloudResource {
                id: format!("{ID_SCHEME}{project_ref}/functions/{slug}"),
                cli_name: slug.clone(),
                name: slug,
                kind: "supabase/function".to_string(),
                location: region.to_string(),
                group: project_ref.to_string(),
                tags,
            })
        })
        .collect()
}

/// Preview branches, by name.
///
/// Not the default branch. Its `project_ref` is the project's own - it IS the
/// project, which the panel already shows as its database - and it exists as
/// soon as branching was ever tried: measured, a create refused with 402 on the
/// Free plan still left a `main` with `is_default: true` behind. Listed, it
/// would be a branch nobody made, and every branch action on it would land on
/// production.
fn branches_in(json: &str, project_ref: &str, region: &str) -> Vec<CloudResource> {
    let list: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .filter_map(|entry| {
            let name = field(entry, "name");
            if name.is_empty() || field(entry, "project_ref") == project_ref {
                return None;
            }
            let mut tags = BTreeMap::new();
            for key in ["status", "preview_project_status", "git_branch", "persistent"] {
                if let Some(value) = entry.get(key) {
                    tags.insert(key.to_string(), scalar(value));
                }
            }
            Some(CloudResource {
                id: format!("{ID_SCHEME}{project_ref}/branches/{name}"),
                cli_name: name.clone(),
                name,
                kind: "supabase/branch".to_string(),
                location: region.to_string(),
                group: project_ref.to_string(),
                tags,
            })
        })
        .collect()
}

/// A JSON scalar as the tag text a person reads: `true`, `12`, `ACTIVE`.
fn scalar(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `orgs list -o json`, captured 2026-09-21 with the id and the name
    /// masked. The one thing worth reading twice is that `slug` repeats `id`:
    /// an organization has no second, friendlier name to fall back to.
    const ORGS: &str = r#"[
  {
    "id": "zyxwvutsrqponmlkjihg",
    "name": "Acme Inc",
    "slug": "zyxwvutsrqponmlkjihg"
  }
]"#;

    /// `projects list -o json`. The first project is captured the same day -
    /// key order, indentation, `linked`, the `id` that simply repeats `ref`,
    /// and a paused project's `INACTIVE` are all as the CLI printed them, with
    /// the refs and the name masked. The second is that answer's shape with an
    /// organization the `orgs list` above does not carry, which is the only way
    /// to exercise the fallback; no account here owns two organizations.
    const PROJECTS: &str = r#"[
  {
    "created_at": "2026-08-08T06:01:03.056763Z",
    "database": {
      "host": "db.abcdefghijklmnopqrst.supabase.co",
      "postgres_engine": "17",
      "release_channel": "ga",
      "version": "17.6.1.155"
    },
    "id": "abcdefghijklmnopqrst",
    "linked": false,
    "name": "shop",
    "organization_id": "zyxwvutsrqponmlkjihg",
    "organization_slug": "zyxwvutsrqponmlkjihg",
    "ref": "abcdefghijklmnopqrst",
    "region": "ap-southeast-2",
    "status": "INACTIVE"
  },
  {
    "created_at": "2026-08-09T01:02:03.000000Z",
    "database": {
      "host": "db.tsrqponmlkjihgfedcba.supabase.co",
      "postgres_engine": "15",
      "release_channel": "ga",
      "version": "15.8.1.085"
    },
    "id": "tsrqponmlkjihgfedcba",
    "linked": false,
    "name": "sandbox",
    "organization_id": "ghijklmnopqrstuvwxyz",
    "organization_slug": "ghijklmnopqrstuvwxyz",
    "ref": "tsrqponmlkjihgfedcba",
    "region": "us-east-1",
    "status": "ACTIVE_HEALTHY"
  }
]"#;

    /// What both listings really answer for this account, captured 2026-09-21:
    /// a project may hold neither, and the panel must still show its database.
    const NOTHING_LISTED: &str = "[]\n";

    /// `functions list -o json` with one function deployed, captured
    /// 2026-09-23 (CLI 2.116.0) with the ids masked. Three fields the OpenAPI
    /// document did not promise arrive too - `entrypoint_path`, `ezbr_sha256`,
    /// `import_map` - and `created_at` is epoch milliseconds, not a date.
    const FUNCTIONS: &str = r#"[
  {
    "created_at": 1790152939008,
    "entrypoint_path": "file:///tmp/user_fn_abcdefghijklmnopqrst_00000000-0000-0000-0000-000000000001_1/source/supabase/functions/resize/index.ts",
    "ezbr_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "id": "00000000-0000-0000-0000-000000000001",
    "import_map": false,
    "name": "resize",
    "slug": "resize",
    "status": "ACTIVE",
    "updated_at": 1790152939008,
    "verify_jwt": true,
    "version": 1
  }
]"#;

    /// `branches list -o json` after branching was tried once, captured
    /// 2026-09-23 with the ids masked: the default branch, which is the
    /// project itself. The second entry is a preview branch in the same
    /// shape - a real one needs the Pro plan, so its values are this entry's
    /// with what makes it a preview changed: its own ref and `is_default` false.
    const BRANCHES: &str = r#"[
  {
    "created_at": "2026-09-23T08:42:39.90582+00:00",
    "id": "00000000-0000-0000-0000-00000000000b",
    "is_default": true,
    "name": "main",
    "parent_project_ref": "abcdefghijklmnopqrst",
    "persistent": false,
    "preview_project_status": "ACTIVE_HEALTHY",
    "project_ref": "abcdefghijklmnopqrst",
    "status": "FUNCTIONS_DEPLOYED",
    "updated_at": "2026-09-23T08:42:39.90582+00:00",
    "with_data": false
  },
  {
    "created_at": "2026-09-23T08:42:39.90582+00:00",
    "id": "00000000-0000-0000-0000-00000000000c",
    "is_default": false,
    "name": "feature-login",
    "parent_project_ref": "abcdefghijklmnopqrst",
    "persistent": false,
    "preview_project_status": "ACTIVE_HEALTHY",
    "project_ref": "zyxwvutsrqponmlkjihg",
    "status": "FUNCTIONS_DEPLOYED",
    "updated_at": "2026-09-23T08:42:39.90582+00:00",
    "with_data": false
  }
]"#;

    fn organizations() -> BTreeMap<String, String> {
        organizations_in(ORGS)
    }

    #[test]
    fn projects_are_listed_under_the_organization_that_owns_them() {
        let projects = projects_in(PROJECTS, &organizations(), &sign_in_for("supabase"));
        assert_eq!(projects.len(), 2);
        let shop = &projects[0];
        assert_eq!(
            shop.id, "abcdefghijklmnopqrst",
            "the ref is what every command takes"
        );
        assert_eq!(shop.label, "shop");
        assert_eq!(
            shop.detail, "ap-southeast-2 · INACTIVE",
            "a paused project says so where a person will see it before opening it"
        );
        assert_eq!(shop.owner, "Acme Inc");
        assert_eq!(shop.sign_in, "supabase login --agent no");
        assert!(
            !shop.current,
            "the CLI links a project to a folder, not to the machine"
        );
        // A healthy project's second line is just its region, and an
        // organization the token cannot name falls back to `organization_slug`
        // - which the captured answer shows is the id over again.
        assert_eq!(projects[1].detail, "us-east-1");
        assert_eq!(projects[1].owner, "ghijklmnopqrstuvwxyz");
    }

    #[test]
    fn the_identity_is_the_first_organization_and_signed_out_is_a_refusal() {
        assert_eq!(
            organizations(),
            BTreeMap::from([("zyxwvutsrqponmlkjihg".to_string(), "Acme Inc".to_string())])
        );
        assert!(organizations_in("not json").is_empty());
    }

    #[test]
    fn a_project_is_its_database_its_functions_and_its_branches() {
        let project = project_in(PROJECTS, "abcdefghijklmnopqrst").expect("the project");
        let database = database_of(&project, "ap-southeast-2");
        assert_eq!(database.id, "supabase://abcdefghijklmnopqrst/database");
        assert_eq!(database.name, "db.abcdefghijklmnopqrst.supabase.co");
        assert_eq!(database.kind, "supabase/database");
        assert_eq!(database.group, "abcdefghijklmnopqrst");
        assert_eq!(database.tags.get("engine").map(String::as_str), Some("17"));
        assert_eq!(
            database.tags.get("version").map(String::as_str),
            Some("17.6.1.155")
        );
        assert_eq!(database.tags.get("status").map(String::as_str), Some("INACTIVE"));

        let functions = functions_in(FUNCTIONS, "abcdefghijklmnopqrst", "ap-southeast-1");
        assert_eq!(functions.len(), 1);
        assert_eq!(
            functions[0].id,
            "supabase://abcdefghijklmnopqrst/functions/resize"
        );
        assert_eq!(functions[0].name, "resize");
        assert_eq!(functions[0].kind, "supabase/function");
        assert_eq!(functions[0].tags.get("version").map(String::as_str), Some("1"));
        assert_eq!(
            functions[0].tags.get("verify_jwt").map(String::as_str),
            Some("true")
        );

        // The default branch is the project, already shown as its database.
        let branches = branches_in(BRANCHES, "abcdefghijklmnopqrst", "ap-southeast-1");
        assert_eq!(
            branches.len(),
            1,
            "only the preview branch is a resource of its own"
        );
        assert_eq!(
            branches[0].id,
            "supabase://abcdefghijklmnopqrst/branches/feature-login"
        );
        assert_eq!(branches[0].kind, "supabase/branch");
        assert_eq!(
            branches[0].tags.get("preview_project_status").map(String::as_str),
            Some("ACTIVE_HEALTHY")
        );

        assert!(project_in(PROJECTS, "nope").is_none());
    }

    /// The answer a fresh project really gives, and the one the panel has to
    /// survive: a database and nothing else. An empty listing is not a failure
    /// to report, it is the project saying it has none.
    #[test]
    fn a_project_with_no_function_and_no_branch_is_still_its_database() {
        assert!(functions_in(NOTHING_LISTED, "abcdefghijklmnopqrst", "ap-southeast-2").is_empty());
        assert!(branches_in(NOTHING_LISTED, "abcdefghijklmnopqrst", "ap-southeast-2").is_empty());
        let project = project_in(PROJECTS, "abcdefghijklmnopqrst").expect("the project");
        assert_eq!(
            database_of(&project, "ap-southeast-2").name,
            "db.abcdefghijklmnopqrst.supabase.co"
        );
    }

    /// The CLI's project folder goes where Aime says, or it goes into the
    /// working directory - which was the repository, measured, and a window
    /// that reloaded on every panel open.
    #[test]
    fn every_call_keeps_the_clis_project_folder_out_of_the_working_directory() {
        let flags = flags_for(Path::new("C:\\aime\\cloud-clis\\supabase-work"));
        assert_eq!(
            flags,
            [
                "--agent",
                "no",
                "--experimental",
                "--workdir",
                "C:\\aime\\cloud-clis\\supabase-work"
            ]
        );
    }

    #[test]
    fn nothing_here_panics_on_an_answer_that_is_not_the_expected_shape() {
        assert!(functions_in("", "r", "x").is_empty());
        assert!(
            functions_in("[{}]", "r", "x").is_empty(),
            "a function with no slug is nothing to list"
        );
        assert!(branches_in("{}", "r", "x").is_empty());
        assert!(projects_in("[]", &BTreeMap::new(), "supabase login").is_empty());
        let bare = database_of(&serde_json::json!({"ref": "r", "name": "bare"}), "");
        assert_eq!(
            bare.name, "bare",
            "a project with no database block is named by its name"
        );
        assert!(bare.tags.is_empty());
    }
}
