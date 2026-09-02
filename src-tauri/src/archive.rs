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

/// Downloads an archive whose payload is one executable rather than a folder.
///
/// The sibling of `fetch_and_unpack`, and separate because the "already here?"
/// test differs: a release that unpacks to a bare binary has no folder to look
/// for, and treating a file as a directory would re-download it every time.
///
/// The expected file name is checked after unpacking rather than assumed. Only
/// the Windows archive of the Supabase CLI was opened by hand (it holds
/// `supabase.exe` and `supabase-go.exe` at the root, no folder), so on the other
/// platforms this is the assertion that turns a wrong guess into one clear
/// sentence instead of a CLI that silently never appears.
pub async fn fetch_binary(
    url: &str,
    dir: &Path,
    binary: &str,
    label: &str,
    mut report: impl FnMut(String),
) -> Result<std::path::PathBuf, String> {
    let target = dir.join(binary);
    if target.is_file() {
        return Ok(target);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

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

    report(format!("$ tar -xf {label}"));
    let extracted = run(
        &unpacker(),
        &["-xf", &partial.to_string_lossy(), "-C", &dir.to_string_lossy()],
    )
    .await;
    let _ = std::fs::remove_file(&partial);
    extracted.map_err(|e| format!("Could not unpack {label}: {e}"))?;

    if !target.is_file() {
        return Err(format!(
            "The {label} archive did not contain {binary} - it unpacked into {}",
            dir.display()
        ));
    }
    // tar carries the mode, but an archive built without it would leave a file
    // nothing can execute, and the failure then arrives much later as "command
    // not found" from a shell.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut mode = std::fs::metadata(&target)
            .map_err(|e| format!("Could not read {}: {e}", target.display()))?
            .permissions();
        mode.set_mode(0o755);
        std::fs::set_permissions(&target, mode)
            .map_err(|e| format!("Could not make {} executable: {e}", target.display()))?;
    }
    report(format!("{label} is ready"));
    Ok(target)
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
