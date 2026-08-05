//! Fetching a tool that has no package to install.
//!
//! Some things Aime needs are published only as release archives: js-debug is a
//! Node script in a tarball, netcoredbg is a per-platform zip, the Roslyn
//! language server is a NuGet package (which is a zip with a different name). So
//! Aime downloads them into its own data folder rather than asking someone to
//! place a binary on PATH by hand.
//!
//! Written once, here, because the interesting parts are traps rather than code:
//! `curl` and `tar` ship with Windows 10+, macOS and every Linux Aime targets, so
//! one archive does not pull an HTTP stack and an unpacker into the binary — and
//! on Windows *which* tar matters (see `unpacker`).

use std::path::Path;

/// Downloads and unpacks an archive, unless it is already there.
///
/// `unpacks_to` is the folder the archive creates, and the only way to tell
/// "already downloaded" from "not yet". Every line of progress goes to `report`,
/// because Aime never changes a machine silently.
pub async fn fetch_and_unpack(
    url: &str,
    dir: &Path,
    unpacks_to: &str,
    label: &str,
    mut report: impl FnMut(String),
) -> Result<(), String> {
    if dir.join(unpacks_to).is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    // Into a temporary name first: an interrupted download that left a
    // half-written archive behind would look downloaded forever.
    let partial = dir.join(format!("{label}.part"));
    report(format!("$ curl --fail --location {url}"));
    run(
        "curl",
        &[
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--output",
            &partial.to_string_lossy(),
            url,
        ],
    )
    .await
    .map_err(|e| format!("Could not download {label}: {e}"))?;

    // `-xf`, not `-xzf`: one flag set reads both .tar.gz and .zip, and Aime
    // needs both. The tool matters more than the flags — see `unpacker`.
    report(format!("$ tar -xf {label}"));
    let extracted = run(
        &unpacker(),
        &["-xf", &partial.to_string_lossy(), "-C", &dir.to_string_lossy()],
    )
    .await;
    let _ = std::fs::remove_file(&partial);
    extracted.map_err(|e| format!("Could not unpack {label}: {e}"))?;

    if !dir.join(unpacks_to).is_dir() {
        return Err(format!("The {label} archive did not contain {unpacks_to}"));
    }
    report(format!("{label} is ready"));
    Ok(())
}

/// The archiver to unpack with.
///
/// Windows ships bsdtar as the `tar.exe` in its System32 folder, and bsdtar
/// reads zip as happily as tar.gz. Plain `tar` on PATH is not necessarily that
/// one: Git for Windows puts GNU tar there, and GNU tar cannot read a zip at
/// all ("This does not look like a tar archive" — measured against netcoredbg's
/// own asset). So on Windows the system copy is named outright; elsewhere `tar`
/// is bsdtar on macOS and GNU tar on Linux, and every asset Aime fetches for
/// those is a tarball.
fn unpacker() -> String {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        format!(r"{root}\System32\tar.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        "tar".to_string()
    }
}

/// Runs a helper program, turning a non-zero exit into its own message —
/// `curl` and `tar` both explain themselves on stderr.
async fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = crate::dap::adapter_command(program, args)
        .output()
        .await
        .map_err(|e| format!("{program} is not available: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if reason.is_empty() {
        format!("{program} failed")
    } else {
        reason
    })
}
