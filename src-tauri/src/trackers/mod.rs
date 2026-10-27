//! Work trackers: the boards where the work being done in this editor is
//! tracked (Azure Boards today, one file per service after that).
//!
//! The commands here are thin on purpose. Everything a service does its own way
//! sits behind [`connector::Connector`], the credential never leaves this
//! process, and what crosses to the frontend is already normalized - so the
//! panel is written once and every later service arrives without touching it.
//!
//! Every command that reads work takes the open workspace with it: a board is
//! bound to a project (`config`), so opening a repository shows that
//! repository's board and nothing else.

pub mod azure_devops;
pub mod clickup;
pub mod config;
pub mod connector;
pub mod github;
pub(crate) mod http;
pub mod jira;
mod rich_text;
#[cfg(test)]
mod test_service;

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use connector::{
    Comment, Connection, ConnectionField, Connector, Settings, StateOption, TrackerError, WorkItem,
    WorkItemDetail, WorkItemQuery,
};

static AZURE_DEVOPS: azure_devops::AzureDevOps = azure_devops::AzureDevOps;
/// Jira is two products with one name, so it is two connectors: they share every
/// line of `jira.rs` except what the deployment decides (see `jira::Deployment`).
static JIRA_CLOUD: jira::Jira = jira::Jira {
    deployment: jira::Deployment::Cloud,
};
static JIRA_SELF_HOSTED: jira::Jira = jira::Jira {
    deployment: jira::Deployment::SelfHosted,
};
static CLICKUP: clickup::ClickUp = clickup::ClickUp;
static GITHUB: github::GitHub = github::GitHub;

/// Every service Aime can connect to. One line per connector, and that is the
/// whole registration: the UI builds its connect form from what they declare.
static CONNECTORS: [&dyn Connector; 5] = [&AZURE_DEVOPS, &JIRA_CLOUD, &JIRA_SELF_HOSTED, &CLICKUP, &GITHUB];

fn connector_for(kind: &str) -> Result<&'static dyn Connector, String> {
    CONNECTORS
        .iter()
        .copied()
        .find(|connector| connector.kind() == kind)
        .ok_or_else(|| format!("Aime has no connector for '{kind}'"))
}

/// Aime's own config folder, where `trackers.json` and the secret store live.
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("Could not locate the config folder: {e}"))
}

/// A service the user can connect to, and what connecting to it asks for.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerKind {
    pub kind: &'static str,
    pub label: &'static str,
    /// What this service calls its credential, in its own words.
    pub secret_label: &'static str,
    /// Where that credential is created, as a `{field}` template.
    pub secret_help_url: &'static str,
    pub fields: &'static [ConnectionField],
}

/// One configured connection, as the UI lists it. Never carries the token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String,
    pub kind: String,
    /// One line naming it on screen, built by its connector.
    pub label: String,
    pub settings: Settings,
    /// Whether a credential is stored for it. A connection without one can only
    /// ask the user to reconnect.
    pub has_token: bool,
}

#[tauri::command]
pub fn tracker_kinds() -> Vec<TrackerKind> {
    CONNECTORS
        .iter()
        .map(|connector| TrackerKind {
            kind: connector.kind(),
            label: connector.label(),
            secret_label: connector.secret_label(),
            secret_help_url: connector.secret_help_url(),
            fields: connector.fields(),
        })
        .collect()
}

/// Every connection this machine has, skipping any whose service Aime no longer
/// knows - a file from a newer version must not empty the panel.
#[tauri::command]
pub fn tracker_connections(app: AppHandle) -> Result<Vec<ConnectionSummary>, String> {
    let dir = config_dir(&app)?;
    Ok(config::load(&dir)
        .connections
        .into_iter()
        .filter_map(|stored| {
            let connector = connector_for(&stored.kind).ok()?;
            Some(ConnectionSummary {
                label: connector.connection_label(&stored.settings),
                has_token: config::token(&dir, &stored.id).is_some(),
                id: stored.id,
                kind: stored.kind,
                settings: stored.settings,
            })
        })
        .collect())
}

/// The board this workspace shows, if it has been pointed at one.
#[tauri::command]
pub fn tracker_binding(app: AppHandle, root_path: String) -> Result<Option<String>, String> {
    Ok(config::binding(&config_dir(&app)?, &root_path))
}

/// Points the open workspace at a connection it already has - the move behind
/// the board picker. Refused for a connection that is not there, because a
/// binding nothing answers is how the panel ends up asking for a credential
/// that cannot exist.
#[tauri::command]
pub fn tracker_bind(app: AppHandle, root_path: String, connection_id: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    if config::connection(&dir, &connection_id).is_none() {
        return Err(TrackerError::Config(format!("no connection '{connection_id}'")).to_string());
    }
    config::bind(&dir, &root_path, &connection_id)
}

/// Stops this workspace from using any board, leaving the connection - and every
/// other workspace on it - alone. The board picker asks again from here.
#[tauri::command]
pub fn tracker_unbind(app: AppHandle, root_path: String) -> Result<(), String> {
    config::unbind(&config_dir(&app)?, &root_path)
}

/// Connects to a service, by using it, and points this workspace at it.
///
/// The credential is stored only after a real query has come back, because the
/// alternative is a panel that says "connected" and a list that is empty for a
/// reason nobody can see. Nothing is written when the query fails.
#[tauri::command]
pub async fn tracker_connect(
    app: AppHandle,
    root_path: String,
    kind: String,
    settings: Settings,
    token: String,
) -> Result<ConnectionSummary, String> {
    let connector = connector_for(&kind)?;
    let settings: Settings = settings
        .into_iter()
        .map(|(name, value)| (name, value.trim().to_string()))
        .collect();
    for field in connector.fields() {
        if !field.optional && settings.get(field.name).is_none_or(String::is_empty) {
            return Err(TrackerError::Config(format!("'{}' is missing", field.name)).to_string());
        }
    }
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(TrackerError::Auth(format!("{} is required", connector.secret_label())).to_string());
    }

    let id = connector.connection_id(&settings);
    let connection = Connection {
        settings: settings.clone(),
        token: token.clone(),
    };
    // Verified with the query the panel opens with, so "connected" means the
    // first thing the user will see actually works.
    connector
        .work_items(
            &connection,
            WorkItemQuery {
                mine_only: true,
                include_finished: false,
            },
        )
        .await?;

    let dir = config_dir(&app)?;
    config::upsert_connection(
        &dir,
        config::StoredConnection {
            id: id.clone(),
            kind: kind.clone(),
            settings: settings.clone(),
        },
    )?;
    config::set_token(&dir, &id, &token)?;
    config::bind(&dir, &root_path, &id)?;

    Ok(ConnectionSummary {
        label: connector.connection_label(&settings),
        has_token: true,
        id,
        kind,
        settings,
    })
}

/// Forgets a connection everywhere: its token, and every workspace bound to it.
#[tauri::command]
pub fn tracker_disconnect(app: AppHandle, connection_id: String) -> Result<(), String> {
    config::remove_connection(&config_dir(&app)?, &connection_id)
}

#[tauri::command]
pub async fn tracker_work_items(
    app: AppHandle,
    connection_id: String,
    query: WorkItemQuery,
) -> Result<Vec<WorkItem>, String> {
    let (connector, connection) = open_connection(&app, &connection_id)?;
    Ok(connector.work_items(&connection, query).await?)
}

#[tauri::command]
pub async fn tracker_item_detail(
    app: AppHandle,
    connection_id: String,
    item: WorkItem,
) -> Result<WorkItemDetail, String> {
    let (connector, connection) = open_connection(&app, &connection_id)?;
    Ok(connector.item_detail(&connection, &item).await?)
}

#[tauri::command]
pub async fn tracker_states(
    app: AppHandle,
    connection_id: String,
    item: WorkItem,
) -> Result<Vec<StateOption>, String> {
    let (connector, connection) = open_connection(&app, &connection_id)?;
    Ok(connector.states(&connection, &item).await?)
}

/// The conversation on one item.
#[tauri::command]
pub async fn tracker_comments(
    app: AppHandle,
    connection_id: String,
    item: WorkItem,
) -> Result<Vec<Comment>, String> {
    let (connector, connection) = open_connection(&app, &connection_id)?;
    Ok(connector.comments(&connection, &item).await?)
}

/// Says something on one item, in the person's own name.
#[tauri::command]
pub async fn tracker_add_comment(
    app: AppHandle,
    connection_id: String,
    item: WorkItem,
    text: String,
) -> Result<Comment, String> {
    let (connector, connection) = open_connection(&app, &connection_id)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(TrackerError::Config("a comment with nothing in it".into()).to_string());
    }
    Ok(connector.add_comment(&connection, &item, text).await?)
}

#[tauri::command]
pub async fn tracker_set_state(
    app: AppHandle,
    connection_id: String,
    item: WorkItem,
    state: String,
) -> Result<WorkItem, String> {
    let (connector, connection) = open_connection(&app, &connection_id)?;
    Ok(connector.set_state(&connection, &item, &state).await?)
}

/// A stored connection, with its token, ready for one call.
///
/// The token is read per call rather than held in memory: it can be revoked or
/// replaced while Aime runs, and this way the next call uses what is stored now.
fn open_connection(
    app: &AppHandle,
    connection_id: &str,
) -> Result<(&'static dyn Connector, Connection), String> {
    let dir = config_dir(app)?;
    let stored = config::connection(&dir, connection_id)
        .ok_or_else(|| TrackerError::Config(format!("no connection '{connection_id}'")).to_string())?;
    let connector = connector_for(&stored.kind)?;
    let token = config::token(&dir, connection_id)
        .ok_or_else(|| TrackerError::Auth(format!("{} is missing", connector.secret_label())).to_string())?;
    Ok((
        connector,
        Connection {
            settings: stored.settings,
            token,
        },
    ))
}
