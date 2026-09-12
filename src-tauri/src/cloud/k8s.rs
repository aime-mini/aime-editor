//! Deploying to Kubernetes - the part of Google Cloud `gcloud` cannot deploy.
//!
//! `gcloud` creates a GKE cluster and nothing inside one: there is no `gcloud`
//! command that applies a Deployment, and `kubectl` is how every Kubernetes
//! workload has ever been shipped. Measured 2026-09-12, before this existed:
//! given a repository that is plainly Kubernetes - a Dockerfile, a two-replica
//! Deployment, a LoadBalancer Service and a README saying `kubectl apply` - the
//! AI planned Cloud Run instead, because a step could only ever be `gcloud`. It
//! said what it had substituted and why, which was the right answer to a
//! question it should not have had to guess at.
//!
//! So a step names the program it runs under, exactly as a read does
//! (`reads::PlannedRead::program`, added for `bq`), and this module is the
//! gate: `kubectl` is accepted for Google Cloud and refused everywhere else,
//! and only for the commands that put a workload on a cluster. The gate is what
//! keeps the promise that a model's answer cannot widen what Aime will run.
//!
//! What was measured here rather than recalled (kubectl v1.29.2):
//!
//! - **`kubectl <words> --help` exits 0 for a real command and 1 for one it
//!   does not have** - `kubectl shwo --help` answers *error: unknown command
//!   "shwo" for "kubectl"* in 43 bytes. That is the same shape `gcloud` has
//!   (exit 2 there), so `StepLine::words_exist` walks both the same way.
//! - **A command can be one word or two** - `apply`, and `rollout status`.
//! - **`kubectl delete` exists and its help exits 0**, so nothing about the CLI
//!   stops a deploy deleting a cluster's workloads; `REFUSED_WORDS` does, as it
//!   does for `gcloud`.

/// The one command this module is the gate for.
pub(super) const PROGRAM: &str = "kubectl";

/// The cloud whose clusters Aime deploys to.
const KUBERNETES_CLOUD: &str = "gcp";

/// The plugin `kubectl` needs before it can authenticate to a GKE cluster.
///
/// Not optional and not bundled: a kubeconfig written by `gcloud container
/// clusters get-credentials` names this binary as its auth provider, and
/// without it every `kubectl` call against the cluster fails on the exec step
/// before it reaches the network. It ships as a Cloud SDK component, so the
/// machine that has `gcloud` can have it without downloading anything.
pub(super) const AUTH_PLUGIN: &str = "gke-gcloud-auth-plugin";

/// The two binaries a `kubectl` step needs, in the order they are checked.
///
/// Both ship as Cloud SDK components, so a machine with `gcloud` can have them
/// without downloading anything of its own. `kubectl` is often already here
/// from somewhere else - Docker Desktop puts one on the PATH, measured on this
/// machine - and then only the plugin is fetched.
pub(super) const NEEDED: [&str; 2] = [PROGRAM, AUTH_PLUGIN];

/// The command that installs one missing component, as Aime runs it.
pub(super) fn install(component: &str) -> [&str; 4] {
    ["components", "install", component, "--quiet"]
}

/// The command that answers where the Cloud SDK keeps a Python it can update
/// itself with, printed on the last line of its output.
///
/// Windows only, and measured 2026-09-12 in the app rather than recalled. The
/// Cloud SDK there runs on a Python it ships inside itself, and it will not
/// update itself while running on it: `gcloud components install
/// gke-gcloud-auth-plugin --quiet` answers *ERROR: Cannot use bundled Python
/// installation to update Google Cloud CLI in non-interactive mode* and exits,
/// so a deploy that needs `kubectl` stops one step before it. The CLI prints
/// the way out in that same message - copy the bundled Python, point
/// `CLOUDSDK_PYTHON` at the copy, install again - and that is what this is for.
/// Measured: exit 0, last line `c:\python312\python.exe`, and the install then
/// runs to *Update done!* with no prompt.
pub(super) const BUNDLED_PYTHON: [&str; 2] = ["components", "copy-bundled-python"];

/// The environment variable that tells the Cloud SDK which Python to run on.
pub(super) const PYTHON_ENV: &str = "CLOUDSDK_PYTHON";

/// The first words a deploy step may say to `kubectl`.
///
/// A deployment puts a workload on a cluster and watches it come up. Everything
/// outside that is refused by name rather than by a rule about names, because
/// the dangerous ones here are not the ones that sound dangerous: `exec` and
/// `debug` are a shell on somebody's production pod, `port-forward` and `proxy`
/// open a tunnel out of the cluster, and `cp` moves files across it. None of
/// them is a deployment, and `delete` is already refused for every program
/// Aime runs (`REFUSED_WORDS`).
const DEPLOY_COMMANDS: [&str; 11] = [
    "apply", "create", "expose", "scale", "set", "rollout", "annotate", "label", "patch", "wait", "get",
];

/// The first words a deploy READ may say to `kubectl`.
///
/// A read answers and changes nothing, so this is narrower than
/// `DEPLOY_COMMANDS` and narrower on purpose: `rollout` is absent because
/// `rollout undo` and `rollout restart` are changes wearing the same first
/// word, and a read that can change something is not a read.
///
/// Measured 2026-09-12 in the app: when a `kubectl apply` failed, the AI asked
/// for `kubectl get pods`, `kubectl get events` and four more to diagnose it -
/// and every one of them ran as `gcloud get pods`, because only a STEP could
/// name its program. Six refusals in a row, then *The AI could not say how to
/// go on*, on a deploy that was one fixable error from working.
const READ_COMMANDS: [&str; 8] = [
    "get",
    "describe",
    "logs",
    "top",
    "explain",
    "cluster-info",
    "api-resources",
    "version",
];

/// How `kubectl` is asked for JSON; `gcloud` spells the same thing `--format`.
pub(super) fn json_flags() -> [&'static str; 2] {
    ["--output", "json"]
}

/// The refusal for a read that named `kubectl` where it does not belong, or a
/// `kubectl` command that would not merely read.
pub(super) fn refuse_unless_reading(cloud_id: &str, command: &str) -> Result<(), String> {
    if !serves(cloud_id) {
        return Err(format!(
            "`{PROGRAM}` is for Google Cloud's clusters; {cloud_id} has no deploy that runs it"
        ));
    }
    if !READ_COMMANDS.contains(&command) {
        return Err(format!(
            "`{PROGRAM} {command}` is not a read. The commands a deploy may read with are {}",
            READ_COMMANDS.join(", ")
        ));
    }
    Ok(())
}

/// Whether this cloud's deploys may use `kubectl` at all.
pub(super) fn serves(cloud_id: &str) -> bool {
    cloud_id == KUBERNETES_CLOUD
}

/// The refusal for a step that named `kubectl` where it does not belong, or a
/// `kubectl` command that is not a deployment.
///
/// `Ok(())` means the step may run under `kubectl`.
pub(super) fn refuse_unless_deploying(cloud_id: &str, command: &str) -> Result<(), String> {
    if !serves(cloud_id) {
        return Err(format!(
            "`{PROGRAM}` is for Google Cloud's clusters; {cloud_id} has no deploy that runs it"
        ));
    }
    if !DEPLOY_COMMANDS.contains(&command) {
        return Err(format!(
            "`{PROGRAM} {command}` is not a deployment. The commands a deploy may run are {}",
            DEPLOY_COMMANDS.join(", ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubectl_belongs_to_google_clouds_clusters_and_to_no_other_cloud() {
        assert!(serves("gcp"));
        for elsewhere in ["aws", "azure", "supabase"] {
            assert!(!serves(elsewhere));
            let refused = refuse_unless_deploying(elsewhere, "apply").expect_err("not this cloud");
            assert!(refused.contains(elsewhere), "unhelpful: {refused}");
        }
    }

    #[test]
    fn a_workload_may_be_applied_and_watched_and_nothing_else() {
        for deploying in ["apply", "rollout", "wait", "scale", "get"] {
            assert!(refuse_unless_deploying("gcp", deploying).is_ok(), "{deploying}");
        }
        // Not a deployment: a shell on a pod, a tunnel out of the cluster, a
        // file copy, an editor. `delete` is refused a step earlier, by the
        // words no deployment may say whatever program runs them.
        for refused in [
            "exec",
            "debug",
            "attach",
            "port-forward",
            "proxy",
            "cp",
            "edit",
            "drain",
        ] {
            let said = refuse_unless_deploying("gcp", refused).expect_err("{refused} is not a deploy");
            assert!(said.contains(refused), "unhelpful: {said}");
            assert!(
                said.contains("apply"),
                "the refusal does not say what IS allowed: {said}"
            );
        }
    }

    #[test]
    fn a_read_may_look_and_may_not_touch() {
        for looking in ["get", "describe", "logs", "events"].iter().take(3) {
            assert!(refuse_unless_reading("gcp", looking).is_ok(), "{looking}");
        }
        // `apply` and `rollout` are steps, not reads - `rollout undo` is a
        // change behind a word that sounds like a question.
        for changing in ["apply", "rollout", "scale", "patch", "delete", "exec"] {
            let said = refuse_unless_reading("gcp", changing).expect_err("not a read");
            assert!(said.contains(changing), "unhelpful: {said}");
            assert!(
                said.contains("get"),
                "the refusal does not say what IS read: {said}"
            );
        }
        assert!(
            refuse_unless_reading("aws", "get").is_err(),
            "kubectl is Google Cloud's here"
        );
    }

    #[test]
    fn kubectl_is_asked_for_json_its_own_way() {
        // `gcloud` takes `--format json`; asking kubectl that way is an error,
        // so the two are kept apart rather than shared.
        assert_eq!(json_flags(), ["--output", "json"]);
    }

    #[test]
    fn the_bundled_python_is_asked_for_by_the_clis_own_prescription() {
        assert_eq!(BUNDLED_PYTHON, ["components", "copy-bundled-python"]);
        assert_eq!(PYTHON_ENV, "CLOUDSDK_PYTHON");
    }

    #[test]
    fn what_kubectl_needs_is_installed_as_cloud_sdk_components() {
        assert_eq!(
            NEEDED,
            [PROGRAM, AUTH_PLUGIN],
            "the plugin is useless without kubectl"
        );
        for component in NEEDED {
            let command = install(component);
            assert_eq!(command[0], "components", "it is a `gcloud components` install");
            assert!(command.contains(&component));
            // Silent: this runs inside a deploy the person already confirmed,
            // and a prompt there is a wait nobody is watching for.
            assert!(command.contains(&"--quiet"));
        }
    }
}
