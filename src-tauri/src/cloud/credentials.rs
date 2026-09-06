//! Noticing a sign-in the panel did not perform itself.
//!
//! A sign-in leaves a mark on disk. Measured on this machine, 2026-09-04:
//! `az login` rewrote `~/.azure/msal_token_cache.bin` and, 1.6 s later,
//! `~/.azure/azureProfile.json`; `aws configure` rewrote `~/.aws/credentials`.
//! Reported the same day: the CLI said the sign-in had succeeded, and the panel
//! kept its red dot and its "sign in first" until "Try again" was clicked by
//! hand. The panel had no way to know - an AWS sign-in runs in a terminal tab
//! on purpose (keys typed at a prompt belong in a shell Aime never reads), and
//! a sign-in typed into any other shell is invisible to it altogether.
//!
//! `gcloud auth login` was read from the CLI's own source rather than timed
//! (2026-09-05, no Google account to sign in with here): `Store` writes the
//! refresh token into `credentials.db` and a legacy copy under
//! `legacy_credentials/<account>/`, then `PersistProperty(core.account)`
//! rewrites the active configuration under `configurations/`. The config
//! directory is `CLOUDSDK_CONFIG`, else `%APPDATA%\gcloud` on Windows and
//! `~/.config/gcloud` elsewhere (`core/config.py`).
//!
//! Those files are the one signal every sign-in gives, whoever performed it, so
//! the panel watches them. It watches the directories rather than the files
//! because the CLIs write by replacing, and a watch on a path that is about to
//! be replaced is a watch on nothing. A directory that does not exist yet (a
//! machine that has never run the CLI) is watched through its parent, so the
//! first `aws configure` on a fresh machine is noticed too.

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// The event the frontend re-reads a cloud on. Payload: which cloud.
const EVENT: &str = "cloud:credentials-changed";

/// `az login` writes its two files 1.6 s apart (measured, see the module
/// comment); one event for the pair beats re-reading the account twice.
const DEBOUNCE: Duration = Duration::from_secs(2);

/// The one watcher over every cloud's state directory, replaced whole when the
/// frontend asks again - which it does after every event, so a directory that
/// came into being since is picked up.
#[derive(Default)]
pub struct CredentialWatch(Mutex<Option<Debouncer<RecommendedWatcher>>>);

impl CredentialWatch {
    /// A poisoned lock still holds a valid watcher - recover it instead of panicking.
    fn slot(&self) -> MutexGuard<'_, Option<Debouncer<RecommendedWatcher>>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CredentialsChanged {
    cloud_id: &'static str,
}

/// Where one CLI keeps what a sign-in writes, and which paths in there mean one.
struct StateDir {
    cloud_id: &'static str,
    dir: PathBuf,
    is_sign_in_mark: fn(&Path) -> bool,
}

impl StateDir {
    /// Whether a changed path says this cloud was signed into: one of the
    /// CLI's sign-in files, or the directory itself appearing on a machine
    /// that never had it.
    fn is_touched_by(&self, path: &Path) -> bool {
        path == self.dir
            || path
                .strip_prefix(&self.dir)
                .is_ok_and(|inside| (self.is_sign_in_mark)(inside))
    }
}

/// Starts (or restarts) watching every cloud CLI's state directory for a
/// sign-in, reporting each as a `cloud:credentials-changed` event.
#[tauri::command]
pub fn cloud_watch_credentials(app: AppHandle, state: State<'_, CredentialWatch>) -> Result<(), String> {
    let dirs = state_dirs();
    let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| match result {
        Ok(events) => {
            let touched: BTreeSet<&str> = events
                .iter()
                .flat_map(|event| dirs.iter().filter(|dir| dir.is_touched_by(&event.path)))
                .map(|dir| dir.cloud_id)
                .collect();
            for cloud_id in touched {
                if let Err(err) = app.emit(EVENT, CredentialsChanged { cloud_id }) {
                    eprintln!("[cloud] failed to emit {EVENT}: {err}");
                }
            }
        }
        Err(err) => eprintln!("[cloud] credential watcher error: {err}"),
    })
    .map_err(|e| e.to_string())?;

    for (root, mode) in watch_roots(&state_dirs()) {
        debouncer
            .watcher()
            .watch(&root, mode)
            .map_err(|e| format!("could not watch {}: {e}", root.display()))?;
    }
    *state.slot() = Some(debouncer);
    Ok(())
}

/// What to hand the OS: each state directory that exists, whole (`aws sso
/// login` writes two levels down), and the parent of each that does not, so
/// its creation is seen - but only that one level. A recursive watch on a
/// home folder would have inotify index every directory under it, which on a
/// developer's Linux box is a project tree or ten. Deduplicated, because two
/// missing directories usually share the home folder.
fn watch_roots(dirs: &[StateDir]) -> BTreeSet<(PathBuf, RecursiveMode)> {
    dirs.iter()
        .filter_map(|state| {
            if state.dir.is_dir() {
                Some((state.dir.clone(), RecursiveMode::Recursive))
            } else {
                let parent = state.dir.parent().filter(|parent| parent.is_dir())?;
                Some((parent.to_path_buf(), RecursiveMode::NonRecursive))
            }
        })
        .collect()
}

/// The three CLIs whose sign-in files are known.
fn state_dirs() -> Vec<StateDir> {
    let mut dirs = Vec::new();
    if let Some(dir) = azure_config_dir() {
        dirs.push(StateDir {
            cloud_id: "azure",
            dir,
            is_sign_in_mark: is_azure_sign_in_mark,
        });
    }
    if let Some(dir) = aws_dir() {
        dirs.push(StateDir {
            cloud_id: "aws",
            dir,
            is_sign_in_mark: is_aws_sign_in_mark,
        });
    }
    if let Some(dir) = gcloud_config_dir() {
        dirs.push(StateDir {
            cloud_id: "gcp",
            dir,
            is_sign_in_mark: is_gcloud_sign_in_mark,
        });
    }
    dirs
}

/// The Azure CLI's sign-in files, relative to its config directory: the
/// account list it answers `az account list` from, and the token cache -
/// `.bin` where the CLI can encrypt it (Windows), `.json` where it cannot.
fn is_azure_sign_in_mark(inside: &Path) -> bool {
    let Some(name) = inside.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    inside.parent() == Some(Path::new(""))
        && (name == "azureProfile.json"
            || Path::new(name)
                .file_stem()
                .is_some_and(|stem| stem == "msal_token_cache"))
}

/// The AWS CLI's sign-in files, relative to `~/.aws`: the two files `aws
/// configure` writes, and the token an `aws sso login` leaves under
/// `sso/cache/`. Everything else in there - the assumed-role cache under
/// `cli/`, backups a person keeps beside the real file - is not a sign-in.
fn is_aws_sign_in_mark(inside: &Path) -> bool {
    let sso_token = inside.parent() == Some(Path::new("sso/cache"))
        && inside.extension().is_some_and(|extension| extension == "json");
    inside == Path::new("credentials") || inside == Path::new("config") || sso_token
}

/// The Google Cloud CLI's sign-in files, relative to its config directory: the
/// credential store (and the journal SQLite writes beside it while it is
/// being written), the legacy copy it keeps per account, and the configurations
/// that record which account is active. `access_tokens.db` is not one: it is
/// rewritten every time a token is refreshed, which is every command.
fn is_gcloud_sign_in_mark(inside: &Path) -> bool {
    let mut parts = inside.components().filter_map(|part| part.as_os_str().to_str());
    let Some(first) = parts.next() else {
        return false;
    };
    let at_root = parts.next().is_none();
    match first {
        "active_config" => at_root,
        "configurations" | "legacy_credentials" => !at_root,
        file => {
            at_root
                && Path::new(file)
                    .file_stem()
                    .is_some_and(|stem| stem == "credentials")
        }
    }
}

/// Where the Google Cloud CLI keeps its state, as `core/config.py` decides it:
/// the override it honours, else `%APPDATA%\gcloud` on Windows (falling back
/// to the Unix path when APPDATA is unset, as the CLI does), else
/// `~/.config/gcloud`.
fn gcloud_config_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("CLOUDSDK_CONFIG") {
        return Some(PathBuf::from(explicit));
    }
    if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Some(PathBuf::from(appdata).join("gcloud"));
        }
    }
    Some(home_dir()?.join(".config").join("gcloud"))
}

/// Where the Azure CLI keeps its state: the override it honours, or `~/.azure`.
fn azure_config_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("AZURE_CONFIG_DIR") {
        return Some(PathBuf::from(explicit));
    }
    Some(home_dir()?.join(".azure"))
}

/// Where the AWS CLI keeps its state: the folder of its config file, which is
/// where `credentials` and `sso/cache` live as well.
fn aws_dir() -> Option<PathBuf> {
    aws_config_path()?.parent().map(Path::to_path_buf)
}

/// Where the AWS CLI reads its config: the override it honours, or the default.
pub(super) fn aws_config_path() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("AWS_CONFIG_FILE") {
        return Some(PathBuf::from(explicit));
    }
    Some(home_dir()?.join(".aws").join("config"))
}

/// The user's home, by the variable each platform actually sets.
fn home_dir() -> Option<PathBuf> {
    let variable = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    std::env::var_os(variable).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn azure() -> StateDir {
        StateDir {
            cloud_id: "azure",
            dir: PathBuf::from("home").join(".azure"),
            is_sign_in_mark: is_azure_sign_in_mark,
        }
    }

    fn aws() -> StateDir {
        StateDir {
            cloud_id: "aws",
            dir: PathBuf::from("home").join(".aws"),
            is_sign_in_mark: is_aws_sign_in_mark,
        }
    }

    /// The files `az login` rewrote on this machine (2026-09-04), and the ones
    /// beside them that every `az` command touches and must not count.
    #[test]
    fn an_azure_sign_in_is_its_profile_or_its_token_cache() {
        let dir = azure();
        for mark in [
            "azureProfile.json",
            "msal_token_cache.bin",
            "msal_token_cache.json",
        ] {
            assert!(dir.is_touched_by(&dir.dir.join(mark)), "{mark}");
        }
        for noise in [
            "msal_http_cache.bin",
            "config",
            "commands/2026-09-04.log",
            "telemetry.txt",
        ] {
            assert!(!dir.is_touched_by(&dir.dir.join(noise)), "{noise}");
        }
        // The same file name in the other CLI's folder is the other CLI's business.
        assert!(!dir.is_touched_by(&PathBuf::from("home").join(".aws").join("azureProfile.json")));
    }

    /// `aws configure` writes `credentials` and `config`; `aws sso login`
    /// writes a token under `sso/cache`. The assumed-role cache under `cli/`
    /// changes on every role call and is not a sign-in, and neither are the
    /// dated backups found beside the real file on this machine.
    #[test]
    fn an_aws_sign_in_is_its_credentials_config_or_sso_token() {
        let dir = aws();
        for mark in ["credentials", "config", "sso/cache/abc123.json"] {
            assert!(dir.is_touched_by(&dir.dir.join(mark)), "{mark}");
        }
        for noise in [
            "credentials.backup",
            "credentials 35",
            "config_8_04_2025",
            "cli/cache/role.json",
            "sso/cache/botocore-client-id.lock",
        ] {
            assert!(!dir.is_touched_by(&dir.dir.join(noise)), "{noise}");
        }
    }

    fn gcloud() -> StateDir {
        StateDir {
            cloud_id: "gcp",
            dir: PathBuf::from("home").join(".config").join("gcloud"),
            is_sign_in_mark: is_gcloud_sign_in_mark,
        }
    }

    /// The files `gcloud auth login` writes, per the CLI's own `store.py` and
    /// `config.py` (2026-09-05), and the ones beside them that every `gcloud`
    /// command touches and must not count - `access_tokens.db` above all, which
    /// changes on every token refresh.
    #[test]
    fn a_google_sign_in_is_its_credential_store_its_legacy_copy_or_its_configuration() {
        let dir = gcloud();
        for mark in [
            "credentials.db",
            "credentials.db-journal",
            "active_config",
            "configurations/config_default",
            "legacy_credentials/dev@example.com/adc.json",
        ] {
            assert!(dir.is_touched_by(&dir.dir.join(mark)), "{mark}");
        }
        for noise in [
            "access_tokens.db",
            "access_tokens.db-journal",
            "default_configs.db",
            "config_sentinel",
            "logs/2026.09.05/10.00.00.000000.log",
            ".last_update_check.json",
            "gce",
        ] {
            assert!(!dir.is_touched_by(&dir.dir.join(noise)), "{noise}");
        }
        assert!(!dir.is_touched_by(&PathBuf::from("home").join(".azure").join("credentials.db")));
    }

    /// The config directory follows the CLI's own rule per platform, and the
    /// override wins everywhere.
    #[test]
    fn the_gcloud_config_dir_is_where_the_cli_itself_looks() {
        let found = gcloud_config_dir().expect("a config dir");
        if let Some(explicit) = std::env::var_os("CLOUDSDK_CONFIG") {
            assert_eq!(found, PathBuf::from(explicit));
        } else if cfg!(target_os = "windows") {
            let appdata = std::env::var_os("APPDATA").expect("Windows sets APPDATA");
            assert_eq!(found, PathBuf::from(appdata).join("gcloud"));
        } else {
            assert_eq!(found, home_dir().expect("a home").join(".config").join("gcloud"));
        }
    }

    /// A CLI's folder appearing at all is the first sign-in on a fresh machine.
    #[test]
    fn the_directory_appearing_counts_as_a_sign_in() {
        assert!(aws().is_touched_by(&PathBuf::from("home").join(".aws")));
        assert!(!aws().is_touched_by(&PathBuf::from("home").join(".azure")));
    }

    /// A missing directory is watched through its parent, and two missing
    /// directories in the same home are one watch, not two.
    #[test]
    fn a_missing_directory_is_watched_through_its_parent() {
        let home = std::env::temp_dir().join(format!("aime-cred-watch-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".azure")).expect("test home");
        let dirs = vec![
            StateDir {
                cloud_id: "azure",
                dir: home.join(".azure"),
                is_sign_in_mark: is_azure_sign_in_mark,
            },
            StateDir {
                cloud_id: "aws",
                dir: home.join(".aws"),
                is_sign_in_mark: is_aws_sign_in_mark,
            },
            StateDir {
                cloud_id: "gcp",
                dir: home.join(".config").join("gcloud"),
                is_sign_in_mark: is_gcloud_sign_in_mark,
            },
        ];
        let roots = watch_roots(&dirs);
        std::fs::remove_dir_all(&home).expect("cleanup");
        // `.azure` exists and is watched itself, whole; `.aws` does not and
        // falls back to the home folder, one level only; `gcloud`'s parent is
        // missing too, so nothing at all is watched for it rather than a folder
        // that would fail to open.
        assert_eq!(
            roots,
            BTreeSet::from([
                (home.join(".azure"), RecursiveMode::Recursive),
                (home.clone(), RecursiveMode::NonRecursive),
            ])
        );
    }

    /// Each platform names the home folder in its own variable; the wrong one
    /// is an empty answer and a panel that never notices a sign-in.
    #[test]
    fn home_is_read_from_this_platforms_own_variable() {
        let expected = if cfg!(target_os = "windows") {
            std::env::var_os("USERPROFILE")
        } else {
            std::env::var_os("HOME")
        };
        assert_eq!(home_dir(), expected.map(PathBuf::from));
        assert!(home_dir().is_some(), "the test runner itself has a home");
    }

    #[test]
    fn the_event_reaches_the_frontend_in_its_own_spelling() {
        assert_eq!(
            serde_json::to_string(&CredentialsChanged { cloud_id: "aws" }).expect("serialises"),
            r#"{"cloudId":"aws"}"#
        );
    }
}
