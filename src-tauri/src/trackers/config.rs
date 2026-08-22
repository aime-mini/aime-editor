//! Where connections to work trackers are kept.
//!
//! Two files in Aime's own config folder, split along one line: `trackers.json`
//! holds what may be read back (which service, which project, which workspace
//! uses it), and the token goes into the secret store the AI providers already
//! use (`providers::keys`) - one place in this app holds secrets, and a
//! connection namespaces its entry with `tracker:` so it can never collide with
//! a provider's key.
//!
//! **A connection belongs to the person; the binding belongs to the workspace.**
//! A token is the same token whichever clone of a repository is open, and two
//! repositories of the same organization share it - so connections are stored
//! once. Which board a project shows is the project's own business, and that is
//! the `workspaces` map. Nothing about either is written into the user's
//! repository: `.aime/` ignores itself entirely, so a pointer left there would
//! reach no teammate anyway, and a token must never be a file in a project.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::connector::Settings;
use crate::providers::keys;

const FILE_NAME: &str = "trackers.json";

/// One connection, exactly as it is stored. Contains no secret.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    /// Derived by the connector from the identifying settings, so reconnecting
    /// to the same project replaces the entry instead of adding a second one.
    pub id: String,
    /// Which connector speaks for it (`azure-devops`).
    pub kind: String,
    pub settings: Settings,
}

/// The whole file.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub connections: Vec<StoredConnection>,
    /// Workspace path → connection id. Keyed by the path as the frontend reports
    /// it, which is the canonical one (both the CLI and the folder dialog
    /// canonicalize) - the same convention as the AI session store.
    #[serde(default)]
    pub workspaces: BTreeMap<String, String>,
}

fn file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

/// Everything stored. A missing file is the normal first-run state, and a
/// malformed one is reported and treated as empty - the same contract as
/// `providers::generic::load`, because a hand-edited file must never be able to
/// block the panel from opening.
pub fn load(config_dir: &Path) -> Store {
    let path = file_path(config_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Store::default();
    };
    match serde_json::from_str(&text) {
        Ok(store) => store,
        Err(err) => {
            eprintln!(
                "[trackers] {} is not valid JSON ({err}); ignoring it",
                path.display()
            );
            Store::default()
        }
    }
}

/// The connection this workspace shows, when it has one.
pub fn binding(config_dir: &Path, root_path: &str) -> Option<String> {
    load(config_dir).workspaces.remove(root_path)
}

/// Points one workspace at one connection.
pub fn bind(config_dir: &Path, root_path: &str, connection_id: &str) -> Result<(), String> {
    let mut store = load(config_dir);
    store
        .workspaces
        .insert(root_path.to_string(), connection_id.to_string());
    write(config_dir, &store)
}

/// Forgets which board a workspace uses, leaving the connection alone: the
/// project stops showing a board, every other project keeps its own.
pub fn unbind(config_dir: &Path, root_path: &str) -> Result<(), String> {
    let mut store = load(config_dir);
    store.workspaces.remove(root_path);
    write(config_dir, &store)
}

/// Adds a connection, or replaces the one with the same id.
pub fn upsert_connection(config_dir: &Path, connection: StoredConnection) -> Result<(), String> {
    let mut store = load(config_dir);
    match store
        .connections
        .iter_mut()
        .find(|stored| stored.id == connection.id)
    {
        Some(existing) => *existing = connection,
        None => store.connections.push(connection),
    }
    write(config_dir, &store)
}

/// Forgets a connection, the token that went with it, and every workspace that
/// pointed at it. The token goes first: a secret left behind after the
/// connection is gone is the worse leftover.
pub fn remove_connection(config_dir: &Path, id: &str) -> Result<(), String> {
    keys::set_api_key(config_dir, &secret_id(id), "")?;
    let mut store = load(config_dir);
    store.connections.retain(|stored| stored.id != id);
    // A workspace pointing at a connection that no longer exists would show the
    // panel asking for a credential nothing can supply.
    store.workspaces.retain(|_, bound| bound != id);
    write(config_dir, &store)
}

/// One connection by id, with the workspaces' pointer already resolved.
pub fn connection(config_dir: &Path, id: &str) -> Option<StoredConnection> {
    load(config_dir)
        .connections
        .into_iter()
        .find(|stored| stored.id == id)
}

fn write(config_dir: &Path, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("Could not create the config folder: {e}"))?;
    let path = file_path(config_dir);
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// The connection's entry in the shared secret store.
fn secret_id(connection_id: &str) -> String {
    format!("tracker:{connection_id}")
}

pub fn token(config_dir: &Path, connection_id: &str) -> Option<String> {
    keys::api_key(config_dir, &secret_id(connection_id))
}

pub fn set_token(config_dir: &Path, connection_id: &str, token: &str) -> Result<(), String> {
    keys::set_api_key(config_dir, &secret_id(connection_id), token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aime-trackers-config-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn stored(id: &str, project: &str) -> StoredConnection {
        let mut settings = Settings::new();
        settings.insert("organization".into(), "contoso".into());
        settings.insert("project".into(), project.into());
        StoredConnection {
            id: id.into(),
            kind: "azure-devops".into(),
            settings,
        }
    }

    #[test]
    fn reconnecting_replaces_the_entry_instead_of_adding_a_second() {
        let dir = scratch("upsert");
        upsert_connection(&dir, stored("azure-devops:contoso/web", "Web")).expect("first");
        upsert_connection(&dir, stored("azure-devops:contoso/web", "Web renamed")).expect("second");
        upsert_connection(&dir, stored("azure-devops:contoso/api", "Api")).expect("other project");

        let connections = load(&dir).connections;
        assert_eq!(connections.len(), 2, "the same project must not be stored twice");
        assert_eq!(
            connections[0].settings.get("project").map(String::as_str),
            Some("Web renamed"),
            "the newer settings must win"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_workspace_keeps_its_own_board() {
        let dir = scratch("bindings");
        upsert_connection(&dir, stored("azure-devops:contoso/web", "Web")).expect("web");
        upsert_connection(&dir, stored("azure-devops:contoso/api", "Api")).expect("api");

        bind(&dir, r"C:\work\site", "azure-devops:contoso/web").expect("bind site");
        bind(&dir, r"C:\work\service", "azure-devops:contoso/api").expect("bind service");

        assert_eq!(
            binding(&dir, r"C:\work\site").as_deref(),
            Some("azure-devops:contoso/web")
        );
        assert_eq!(
            binding(&dir, r"C:\work\service").as_deref(),
            Some("azure-devops:contoso/api"),
            "one workspace's board must not follow the user into another"
        );
        assert_eq!(
            binding(&dir, r"C:\work\elsewhere"),
            None,
            "a project nobody linked shows no board"
        );

        // Re-pointing a workspace replaces, never appends.
        bind(&dir, r"C:\work\site", "azure-devops:contoso/api").expect("rebind");
        assert_eq!(load(&dir).workspaces.len(), 2);
        assert_eq!(
            binding(&dir, r"C:\work\site").as_deref(),
            Some("azure-devops:contoso/api")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_project_can_stop_using_a_board_without_the_board_being_forgotten() {
        let dir = scratch("unbind");
        upsert_connection(&dir, stored("azure-devops:contoso/web", "Web")).expect("store");
        set_token(&dir, "azure-devops:contoso/web", "pat-secret").expect("token");
        bind(&dir, r"C:\work\site", "azure-devops:contoso/web").expect("bind site");
        bind(&dir, r"C:\work\other", "azure-devops:contoso/web").expect("bind other");

        unbind(&dir, r"C:\work\site").expect("unbind");

        assert_eq!(
            binding(&dir, r"C:\work\site"),
            None,
            "this project stops showing a board"
        );
        assert_eq!(
            binding(&dir, r"C:\work\other").as_deref(),
            Some("azure-devops:contoso/web"),
            "another project on the same board is none of its business"
        );
        assert_eq!(load(&dir).connections.len(), 1, "the connection itself stays");
        assert_eq!(
            token(&dir, "azure-devops:contoso/web"),
            Some("pat-secret".into()),
            "and so does the credential - this is not a disconnect"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disconnecting_takes_the_token_and_the_bindings_with_it() {
        let dir = scratch("remove");
        upsert_connection(&dir, stored("azure-devops:contoso/web", "Web")).expect("store");
        set_token(&dir, "azure-devops:contoso/web", "pat-secret").expect("store token");
        bind(&dir, r"C:\work\site", "azure-devops:contoso/web").expect("bind");
        bind(&dir, r"C:\work\other", "azure-devops:contoso/other").expect("bind another");

        remove_connection(&dir, "azure-devops:contoso/web").expect("remove");

        let store = load(&dir);
        assert!(store.connections.is_empty(), "the connection must be gone");
        assert_eq!(
            token(&dir, "azure-devops:contoso/web"),
            None,
            "a token left behind after a disconnect is a leaked secret"
        );
        assert_eq!(
            binding(&dir, r"C:\work\site"),
            None,
            "a workspace must not point at a connection that no longer exists"
        );
        assert_eq!(
            binding(&dir, r"C:\work\other").as_deref(),
            Some("azure-devops:contoso/other"),
            "another workspace's binding is none of this connection's business"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_and_is_recoverable() {
        let dir = scratch("corrupt");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(file_path(&dir), "{ not json").expect("corrupt it");
        assert!(
            load(&dir).connections.is_empty(),
            "corruption must not panic or block the panel"
        );

        upsert_connection(&dir, stored("azure-devops:contoso/web", "Web")).expect("write over it");
        assert_eq!(load(&dir).connections.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_connections_token_cannot_collide_with_a_providers_key() {
        let dir = scratch("namespace");
        keys::set_api_key(&dir, "azure-devops:contoso/web", "a provider key").expect("provider key");
        set_token(&dir, "azure-devops:contoso/web", "the tracker token").expect("tracker token");

        assert_eq!(
            token(&dir, "azure-devops:contoso/web"),
            Some("the tracker token".into())
        );
        assert_eq!(
            keys::api_key(&dir, "azure-devops:contoso/web"),
            Some("a provider key".into()),
            "the two stores share a file, so they must not share ids"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
