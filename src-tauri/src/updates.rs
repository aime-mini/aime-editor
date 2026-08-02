//! Update checks, on the channel the user chose.
//!
//! The JavaScript side of the updater plugin can only ask the endpoints baked
//! into the config, so a second channel has to be built here, where the
//! updater's own builder accepts endpoints. Everything else stays the plugin's
//! job - signature checks included, which is the reason this goes through the
//! plugin at all rather than fetching a manifest by hand.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Where each channel publishes its manifest. Both are GitHub release assets:
/// stable rides the newest release, beta a release marked as pre-release and
/// tagged `beta`, so a beta never becomes "latest" for anyone else.
const STABLE_MANIFEST: &str = "https://github.com/aime-mini/aime-editor/releases/latest/download/latest.json";
const BETA_MANIFEST: &str = "https://github.com/aime-mini/aime-editor/releases/download/beta/latest.json";

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    /// Pre-releases: newer, and correspondingly less proven.
    Beta,
}

impl Channel {
    fn manifest(self) -> &'static str {
        match self {
            Channel::Stable => STABLE_MANIFEST,
            Channel::Beta => BETA_MANIFEST,
        }
    }
}

/// What the UI needs to describe an update it has not downloaded yet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSummary {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Looks for a newer version on `channel`. `None` = already up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle, channel: Channel) -> Result<Option<UpdateSummary>, String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![channel
            .manifest()
            .parse()
            .map_err(|e| format!("bad update endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let found = updater.check().await.map_err(|e| e.to_string())?;
    Ok(found.map(|update| UpdateSummary {
        version: update.version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    }))
}

/// Downloads and installs the update on `channel`, then restarts the app.
///
/// Checked again rather than carrying the previous result across the command
/// boundary: an `Update` holds an open download plan, and a user who left the
/// notice on screen overnight should get today's release, not yesterday's.
#[tauri::command]
pub async fn update_install(app: AppHandle, channel: Channel) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![channel
            .manifest()
            .parse()
            .map_err(|e| format!("bad update endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the update is no longer available")?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::{Channel, BETA_MANIFEST, STABLE_MANIFEST};

    #[test]
    fn each_channel_has_its_own_manifest() {
        assert_eq!(Channel::Stable.manifest(), STABLE_MANIFEST);
        assert_eq!(Channel::Beta.manifest(), BETA_MANIFEST);
        assert_ne!(Channel::Stable.manifest(), Channel::Beta.manifest());
    }

    /// A beta published as "latest" would reach everyone; the tag keeps it apart.
    #[test]
    fn the_beta_manifest_is_not_the_latest_release() {
        assert!(!BETA_MANIFEST.contains("releases/latest"));
        assert!(BETA_MANIFEST.contains("/beta/"));
    }

    #[test]
    fn manifests_are_parseable_urls() {
        for manifest in [STABLE_MANIFEST, BETA_MANIFEST] {
            assert!(manifest.parse::<tauri::Url>().is_ok(), "{manifest} is not a URL");
        }
    }
}
