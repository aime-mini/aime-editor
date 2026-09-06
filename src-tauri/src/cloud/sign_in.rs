//! Signing into a cloud without the browser vanishing behind the editor.
//!
//! `az login` opens the browser from a process several steps down from Aime -
//! a PTY, a shell, a batch shim, Python - and Windows lets only the foreground
//! process, or one it started directly, bring a window to the front. Reported
//! by the user 2026-09-03: the sign-in page appeared BEHIND Aime and was found
//! only by minimising the editor. Having the CLI print the page instead of
//! opening it fixes that at the root: Aime opens the page ITSELF from the
//! foreground process so it lands in front, and Aime never sees a credential -
//! only a one-time public code. Two CLIs offer such a flow, in opposite
//! directions:
//!
//! - **Azure** (`az login --use-device-code`, measured 2026-09-03) writes one
//!   line to stderr and the person types the code INTO the page:
//!
//!   ```text
//!   To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code XXXXXXXXX to authenticate.
//!   ```
//!
//! - **Google Cloud** (`gcloud auth login --no-launch-browser`, measured
//!   2026-09-05 against 583.0.0 and 502.0.0) writes the page to stderr and then
//!   waits on stdin for the code the page shows AFTER consent, which the person
//!   pastes back:
//!
//!   ```text
//!   Go to the following link in your browser, and complete the sign-in prompts:
//!
//!       https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=…
//!
//!   Once finished, enter the verification code provided in your browser:
//!   ```
//!
//!   The last line is the prompt, on stdout without a newline; closing stdin
//!   instead of answering crashes the CLI with `EOFError`, measured. So the
//!   panel shows a box for the code and hands it to the CLI's stdin.
//!
//! AWS stays in the terminal, for a measured reason: on this machine 27 of 28
//! profiles are static keys in the credentials file and 10 are roles assumed
//! from one of those; none is SSO. Re-entering a key is `aws configure
//! --profile <name>`, an interactive prompt that belongs in a real shell where
//! Aime never sees what is typed. An SSO profile - one whose config section
//! carries `sso_session` or `sso_start_url` - is offered `aws sso login`, and
//! that runs in the terminal with the CLI's own browser handling: its output
//! could not be measured here, and a parse written from memory of it is the
//! guess this project does not make.

use super::CloudAccount;
use crate::providers::cli_command;
use serde::Serialize;
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};

/// The event the frontend follows a sign-in through.
const EVENT: &str = "cloud:sign-in";

/// The longest verification code Aime will hand to a CLI's stdin.
const CODE_LIMIT: usize = 512;

/// One sign-in the CLI is still running.
struct Running {
    child: Child,
    /// Open only for a CLI that waits for the code to be pasted back.
    stdin: Option<ChildStdin>,
}

/// The sign-ins in flight, one at most per cloud, so a second click on the
/// button cancels the first instead of starting a race for the same token.
#[derive(Default)]
pub struct SignInState(Mutex<HashMap<String, Running>>);

impl SignInState {
    /// A poisoned lock still holds valid data - recover it instead of panicking.
    fn running(&self) -> MutexGuard<'_, HashMap<String, Running>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// One step of a sign-in, as the frontend sees it.
///
/// `rename_all` on the enum renames the VARIANTS; the fields inside each need
/// their own, or `cloud_id` reaches the frontend in snake case and the
/// listener comparing `payload.cloudId` drops every event - which is exactly
/// how the first run of this sat on "starting" forever.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "stage")]
pub enum SignInEvent {
    /// The CLI has issued a code: open `url`, type `code` there.
    #[serde(rename_all = "camelCase")]
    Code {
        cloud_id: String,
        url: String,
        code: String,
    },
    /// The CLI has named its page: open `url`, then paste back the code the
    /// page shows, through `cloud_sign_in_code`.
    #[serde(rename_all = "camelCase")]
    Page { cloud_id: String, url: String },
    /// The CLI exited. `ok` is its own verdict; `message` its last words.
    #[serde(rename_all = "camelCase")]
    Done {
        cloud_id: String,
        ok: bool,
        message: String,
    },
}

/// What one stderr line of a sign-in announces, before it is addressed to a cloud.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Code { url: String, code: String },
    Page { url: String },
}

/// How one cloud's CLI signs in with its browser handling turned off.
struct Flow {
    program: &'static str,
    args: Vec<String>,
    /// Whether the CLI waits for the page's code to be pasted back (Google
    /// Cloud) rather than receiving its token on its own (Azure).
    awaits_code: bool,
    /// Reads one stderr line for the step it announces, if it announces one.
    step: fn(&str) -> Option<Step>,
}

impl Flow {
    /// The flow for one account of one cloud, or why there is none.
    fn for_account(cloud_id: &str, account: &CloudAccount) -> Result<Self, String> {
        match cloud_id {
            "azure" => {
                let mut args = vec!["login".to_string(), "--use-device-code".to_string()];
                if !account.tenant.is_empty() {
                    args.extend(["--tenant".to_string(), account.tenant.clone()]);
                }
                Ok(Self {
                    program: "az",
                    args,
                    awaits_code: false,
                    step: device_code_in,
                })
            }
            "gcp" => {
                let mut args = vec!["auth".to_string(), "login".to_string()];
                if !account.owner.is_empty() {
                    args.push(account.owner.clone());
                }
                args.push("--no-launch-browser".to_string());
                Ok(Self {
                    program: "gcloud",
                    args,
                    awaits_code: true,
                    step: google_page_in,
                })
            }
            other => Err(format!("Aime has no measured browser-free sign-in for {other}")),
        }
    }
}

/// Starts a browser-free sign-in for one account and follows it to the end.
///
/// Returns as soon as the CLI is running; the page, the code and the outcome
/// arrive as `cloud:sign-in` events, because the whole point is that a person
/// completes this in a browser on their own time. Only Azure and Google Cloud
/// have a measured flow; see the module comment for why AWS does not come
/// through here.
#[tauri::command]
pub async fn cloud_sign_in(
    app: AppHandle,
    state: State<'_, SignInState>,
    cloud_id: String,
    account: CloudAccount,
) -> Result<(), String> {
    let flow = Flow::for_account(&cloud_id, &account)?;
    let mut command = cli_command(flow.program, &flow.args);
    command
        .stdin(if flow.awaits_code {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start `{} {}`: {e}", flow.program, flow.args.join(" ")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("`{}` started without a stderr to read", flow.program))?;
    let stdin = child.stdin.take();
    if let Some(previous) = state.running().insert(cloud_id.clone(), Running { child, stdin }) {
        // The user clicked again: the earlier attempt's code is dead the
        // moment a new one is issued, so it is not left waiting for nobody.
        stop(previous);
    }

    let mut lines = BufReader::new(stderr).lines();
    let mut last_words = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        match (flow.step)(&line) {
            Some(Step::Code { url, code }) => {
                let event = SignInEvent::Code {
                    cloud_id: cloud_id.clone(),
                    url,
                    code,
                };
                app.emit(EVENT, event).map_err(|e| e.to_string())?;
            }
            Some(Step::Page { url }) => {
                let event = SignInEvent::Page {
                    cloud_id: cloud_id.clone(),
                    url,
                };
                app.emit(EVENT, event).map_err(|e| e.to_string())?;
            }
            None if !line.trim().is_empty() => last_words = line.trim().to_string(),
            None => {}
        }
    }

    let running = state.running().remove(&cloud_id);
    let ok = match running {
        Some(mut running) => running.child.wait().await.is_ok_and(|status| status.success()),
        // Cancelled from the panel: the entry is gone, and so is the process.
        None => false,
    };
    app.emit(
        EVENT,
        SignInEvent::Done {
            cloud_id,
            ok,
            message: last_words,
        },
    )
    .map_err(|e| e.to_string())
}

/// Hands the code the sign-in page showed to the CLI that is waiting for it.
///
/// The code is a one-time authorization code, not a credential Aime keeps: it
/// goes to the CLI's stdin and nowhere else. It is checked for shape first -
/// a code is letters, digits and the `/`, `_`, `-` Google's carry - because a
/// line pasted by mistake is better refused here than fed to a CLI that will
/// exchange it and fail with a message about something else.
#[tauri::command]
pub async fn cloud_sign_in_code(
    state: State<'_, SignInState>,
    cloud_id: String,
    code: String,
) -> Result<(), String> {
    let code = code.trim();
    if !is_verification_code(code) {
        return Err("That does not look like a verification code".into());
    }
    let mut stdin = state
        .running()
        .get_mut(&cloud_id)
        .and_then(|running| running.stdin.take())
        .ok_or("No sign-in is waiting for a code")?;
    stdin
        .write_all(format!("{code}\n").as_bytes())
        .await
        .map_err(|e| format!("Could not hand the code to the CLI: {e}"))?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    // Dropped here: the CLI has its line, and holding the pipe open would only
    // keep it from noticing if it ever wanted to read to the end.
    Ok(())
}

/// Stops a sign-in the user gave up on, so the CLI is not left polling for a
/// code nobody will type.
#[tauri::command]
pub fn cloud_sign_in_cancel(state: State<'_, SignInState>, cloud_id: String) {
    if let Some(running) = state.running().remove(&cloud_id) {
        stop(running);
    }
}

/// Ends a sign-in and everything it started.
///
/// On Windows `az` and `gcloud` are batch shims, so what Aime spawned is
/// `cmd.exe`, and killing that leaves the Python process underneath polling for
/// a code nobody will type - measured 2026-09-03, the first cancel did exactly
/// that. The tree has to go, and `taskkill /T` is what Windows offers for a
/// tree. Elsewhere the CLI is the process itself, and a plain kill is the whole
/// job.
fn stop(mut running: Running) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = running.child.id() {
        let mut taskkill = std::process::Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        taskkill.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        if taskkill.status().is_ok_and(|status| status.success()) {
            return;
        }
    }
    let _ = running.child.start_kill();
}

/// The page and the code, out of the one line the Azure CLI prints them on.
///
/// Anchored on the CLI's own words rather than on "a URL and a capital
/// word", so a warning line that happens to contain an address is not read as
/// a code.
fn device_code_in(line: &str) -> Option<Step> {
    let after_page = line.split_once("open the page ")?.1;
    let (url, after_url) = after_page.split_once(" and enter the code ")?;
    let code = after_url.split_once(" to authenticate")?.0;
    let code_shaped = !code.is_empty() && code.chars().all(|ch| ch.is_ascii_alphanumeric());
    (url.starts_with("https://") && code_shaped).then(|| Step::Code {
        url: url.to_string(),
        code: code.to_string(),
    })
}

/// The consent page, out of the line `gcloud auth login --no-launch-browser`
/// prints it on: indented, alone, and always Google's OAuth endpoint.
///
/// Anchored on that host rather than on "a line that is a URL": the CLI's
/// stderr also carries update notices with links in them.
fn google_page_in(line: &str) -> Option<Step> {
    let url = line.trim();
    url.starts_with("https://accounts.google.com/o/oauth2/")
        .then(|| Step::Page { url: url.to_string() })
}

/// Whether a pasted line has the shape of an OAuth authorization code.
fn is_verification_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= CODE_LIMIT
        && code
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-'))
}

/// The command that signs into one AWS profile, read from the CLI's own config.
///
/// Three shapes of profile exist in `~/.aws/config` and each is signed into
/// differently: an SSO profile (`sso_session` or `sso_start_url`) through
/// `aws sso login`, a role profile (`source_profile`) by fixing the keys of the
/// profile it assumes from, and a plain profile by entering its own keys. All
/// three are facts in that file, so none is guessed - and a profile that is not
/// in the config file at all lives in the credentials file, which holds only
/// keys.
pub(super) fn aws_sign_in_for(profile: &str) -> String {
    let config = super::credentials::aws_config_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    aws_sign_in_from(profile, &config)
}

/// The decision itself, apart from where the config file is.
fn aws_sign_in_from(profile: &str, config: &str) -> String {
    let section = aws_profile_section(profile, config);
    let value_of = |key: &str| -> Option<&str> {
        section
            .iter()
            .find_map(|(name, value)| (*name == key).then_some(*value))
    };
    if value_of("sso_session").is_some() || value_of("sso_start_url").is_some() {
        return format!("aws sso login --profile {profile}");
    }
    let keys_live_in = value_of("source_profile").unwrap_or(profile);
    format!("aws configure --profile {keys_live_in}")
}

/// The `key = value` pairs of one profile's section, empty when it has none.
///
/// The config file names every profile but the default as `[profile <name>]`
/// and the default as `[default]` - the AWS CLI's own convention, and the one
/// place the two files differ in shape.
fn aws_profile_section<'a>(profile: &str, config: &'a str) -> Vec<(&'a str, &'a str)> {
    let heading = if profile == "default" {
        "[default]".to_string()
    } else {
        format!("[profile {profile}]")
    };
    config
        .lines()
        .map(str::trim)
        .skip_while(|line| *line != heading)
        .skip(1)
        .take_while(|line| !line.starts_with('['))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(owner: &str, tenant: &str) -> CloudAccount {
        CloudAccount {
            id: String::new(),
            label: String::new(),
            detail: String::new(),
            current: false,
            owner: owner.into(),
            tenant: tenant.into(),
            sign_in: String::new(),
        }
    }

    /// The exact line `az login --use-device-code` wrote to stderr on this
    /// machine (2026-09-03), code replaced. Nothing else it prints looks like it.
    #[test]
    fn the_page_and_the_code_are_read_off_the_azure_clis_own_line() {
        let line = "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code ABCDEFGHI to authenticate.";
        assert_eq!(
            device_code_in(line),
            Some(Step::Code {
                url: "https://login.microsoft.com/device".into(),
                code: "ABCDEFGHI".into(),
            })
        );
        assert_eq!(
            device_code_in("WARNING: A web browser has been opened at https://login.microsoftonline.com"),
            None
        );
        assert_eq!(device_code_in(""), None);
        // The same words with something that is not a code where the code goes.
        assert_eq!(
            device_code_in("open the page https://x and enter the code $(rm -rf) to authenticate"),
            None
        );
    }

    /// The lines `gcloud auth login --no-launch-browser` wrote to stderr on
    /// this machine (2026-09-05), query string shortened: only the indented URL
    /// line is the page, and the CLI's other links are not.
    #[test]
    fn the_page_is_read_off_the_google_clis_own_line() {
        assert_eq!(
            google_page_in("Go to the following link in your browser, and complete the sign-in prompts:"),
            None
        );
        assert_eq!(google_page_in(""), None);
        assert_eq!(
            google_page_in(
                "    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com"
            ),
            Some(Step::Page {
                url: "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com".into(),
            })
        );
        assert_eq!(
            google_page_in("Updates are available for some Google Cloud CLI components. See https://cloud.google.com/sdk/docs/components"),
            None
        );
    }

    /// The code goes to the CLI's stdin, so this is a shape check and not a
    /// shell-safety one: a pasted URL or sentence is refused with a plain word.
    #[test]
    fn a_verification_code_is_letters_digits_slash_underscore_dash() {
        assert!(is_verification_code("4/0AX4XfWh-abcDEF_ghi123"));
        assert!(!is_verification_code(""));
        assert!(!is_verification_code("https://accounts.google.com/"));
        assert!(!is_verification_code("enter the code"));
        assert!(!is_verification_code(&"a".repeat(CODE_LIMIT + 1)));
    }

    /// Each cloud's flow is built from its account: Azure names the tenant,
    /// Google the account, and a fresh account names neither.
    #[test]
    fn each_cloud_signs_in_with_its_own_command() {
        let azure = Flow::for_account("azure", &account("", "tenant-1")).expect("azure flow");
        assert_eq!(azure.program, "az");
        assert_eq!(azure.args, ["login", "--use-device-code", "--tenant", "tenant-1"]);
        assert!(!azure.awaits_code);

        let fresh = Flow::for_account("azure", &account("", "")).expect("azure flow");
        assert_eq!(fresh.args, ["login", "--use-device-code"]);

        let google = Flow::for_account("gcp", &account("dev@example.com", "")).expect("gcp flow");
        assert_eq!(google.program, "gcloud");
        assert_eq!(
            google.args,
            ["auth", "login", "dev@example.com", "--no-launch-browser"]
        );
        assert!(google.awaits_code, "gcloud waits for the code to be pasted back");

        let first = Flow::for_account("gcp", &account("", "")).expect("gcp flow");
        assert_eq!(first.args, ["auth", "login", "--no-launch-browser"]);

        assert!(Flow::for_account("aws", &account("", "")).is_err());
        assert!(Flow::for_account("supabase", &account("", "")).is_err());
    }

    /// The shape of `~/.aws/config` on this machine (2026-09-03), values
    /// replaced: a default, plain named profiles, and roles assumed from one of
    /// them. The SSO section is the documented shape, added so the third arm is
    /// checked too.
    const CONFIG: &str = "[default]\nregion = ap-southeast-2\noutput = json\n[profile shared]\nregion = ap-southeast-2\n\n[profile shop-dev-admin]\nrole_arn = arn:aws:iam::000000000000:role/Admin\nsource_profile = shared\nregion = ap-southeast-2\nrole_session_name = dev\n\n[profile corp]\nsso_session = corp\nsso_account_id = 000000000000\nsso_role_name = Dev\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = us-east-1\n";

    /// The frontend reads `cloudId`; a snake-case field here is an event it
    /// silently ignores.
    #[test]
    fn events_reach_the_frontend_in_its_own_spelling() {
        let event = SignInEvent::Code {
            cloud_id: "azure".into(),
            url: "https://login.microsoft.com/device".into(),
            code: "ABCDEFGHI".into(),
        };
        assert_eq!(
            serde_json::to_string(&event).expect("serialises"),
            r#"{"stage":"code","cloudId":"azure","url":"https://login.microsoft.com/device","code":"ABCDEFGHI"}"#
        );
        let page = SignInEvent::Page {
            cloud_id: "gcp".into(),
            url: "https://accounts.google.com/o/oauth2/auth?x=y".into(),
        };
        assert_eq!(
            serde_json::to_string(&page).expect("serialises"),
            r#"{"stage":"page","cloudId":"gcp","url":"https://accounts.google.com/o/oauth2/auth?x=y"}"#
        );
        let done = SignInEvent::Done {
            cloud_id: "azure".into(),
            ok: true,
            message: String::new(),
        };
        assert_eq!(
            serde_json::to_string(&done).expect("serialises"),
            r#"{"stage":"done","cloudId":"azure","ok":true,"message":""}"#
        );
    }

    #[test]
    fn each_shape_of_profile_gets_the_sign_in_that_fits_it() {
        assert_eq!(
            aws_sign_in_from("default", CONFIG),
            "aws configure --profile default"
        );
        assert_eq!(
            aws_sign_in_from("shared", CONFIG),
            "aws configure --profile shared"
        );
        // A role has no keys of its own; the profile it assumes from does.
        assert_eq!(
            aws_sign_in_from("shop-dev-admin", CONFIG),
            "aws configure --profile shared"
        );
        assert_eq!(aws_sign_in_from("corp", CONFIG), "aws sso login --profile corp");
        // A profile only the credentials file knows is a plain one.
        assert_eq!(aws_sign_in_from("mfa", CONFIG), "aws configure --profile mfa");
    }
}
