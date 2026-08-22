//! What every work tracker looks like from the rest of Aime.
//!
//! Same rule as the AI adapters (ARCHITECTURE §4): everything a service does
//! differently lives behind one trait, and the UI only ever sees the normalized
//! [`WorkItem`]. Adding Jira or ClickUp is then a new file in this folder plus
//! one line in [`super::connector_for`] — the panel, the store and the commands
//! stay untouched.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// A connection's settings, as the connect form filled them in.
pub type Settings = BTreeMap<String, String>;

/// How many items a refresh reads, whichever service answers.
///
/// Declared here rather than per connector because it is a promise to the person
/// reading the panel, not a property of an API: every service pages differently
/// (Azure DevOps hands over 200 work items per batch, Jira and ClickUp 100 per
/// page), and each connector walks its own pages up to this many. Three hundred
/// items assigned to one person is already a triage problem rather than a
/// display one - and a cap that differs per service would be a silent lie about
/// which board shows everything.
pub const MAX_WORK_ITEMS: usize = 300;

/// One field the connect form asks for. Declared by the connector because only
/// it knows what it needs; the frontend renders the list in this order.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionField {
    /// Key in [`Settings`], and the i18n lookup the frontend labels it with.
    pub name: &'static str,
    /// Shown greyed out inside the empty input — an example, not a label.
    pub placeholder: &'static str,
    /// A field the user may leave empty (it then falls back to a default).
    pub optional: bool,
}

/// Where a state sits in the flow — the one thing about a state that every
/// tracker agrees on, so the only thing the UI is allowed to group by. The
/// state's own name travels next to it, unchanged: renaming "Committed" to
/// "In progress" would hide the team's vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StateCategory {
    Todo,
    InProgress,
    Done,
    Removed,
    /// The service reported a category Aime does not know, or none at all.
    Unknown,
}

impl StateCategory {
    /// True for work that is over, which is what the panel hides by default.
    pub fn is_finished(self) -> bool {
        matches!(self, StateCategory::Done | StateCategory::Removed)
    }
}

/// What the panel is asking a board for.
///
/// A struct rather than two booleans because it will grow: every service can
/// narrow a query in its own ways, and the ones that are worth offering are
/// worth offering everywhere.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemQuery {
    /// Only what is assigned to whoever the credential belongs to. The default,
    /// because a board is usually somebody else's problem; `false` is the
    /// deliberate "show me everything here".
    pub mine_only: bool,
    /// Include work that is over. Left out until asked for: most boards carry
    /// years of it.
    pub include_finished: bool,
}

/// One labelled thing about an item, in the service's own words.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub label: String,
    pub value: String,
}

/// The item this one sits under, when it has one.
///
/// The title travels with the id because the parent is usually *not* in the list:
/// a story is assigned to whoever owns it and its tasks to whoever does them, so
/// a panel of "my work" is mostly children. A row that cannot say what it belongs
/// to is the thing that makes a board unreadable.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parent {
    pub id: String,
    pub title: String,
}

/// One item of work, in the shape the UI knows.
///
/// Deserialized as well as serialized: the panel hands an item back when it asks
/// what that item can do next, which saves every connector from looking up again
/// what the UI is already holding. Jira needs the key, Azure DevOps the type -
/// the item carries both.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    /// The service's own identifier, as text: Azure DevOps counts, Jira uses
    /// `PROJ-12`, and the UI only ever passes it back.
    pub id: String,
    /// What a person calls this item, when that is not its id. ClickUp addresses
    /// a task by an internal id (`86a1b2c3`) while the team reads and says
    /// `DEV-123`; the two other services show the id they are addressed by, and
    /// leave this empty.
    pub display_id: Option<String>,
    pub title: String,
    /// The service's word for this kind of work ("Bug", "User Story").
    pub item_type: String,
    /// The service's own state name.
    pub state: String,
    pub category: StateCategory,
    /// Where a person opens this item in their browser.
    pub web_url: String,
    /// What this item sits under, when the service says so.
    pub parent: Option<Parent>,
    /// The ways this item can be filed, each labelled in the service's own words:
    /// `[("Board", "Accounts"), ("Sprint", "Sprint 24")]`.
    ///
    /// A list rather than named fields, because teams organize differently and no
    /// fixed set is right: one shop lives by sprints, another by milestones, a
    /// third by boards per purpose. Each connector declares what it actually has,
    /// and the panel groups by whichever of them the reader picks - so a new way
    /// of organizing costs a line in a connector and nothing in the UI.
    pub dimensions: Vec<Fact>,
}

/// A state an item can be moved to.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateOption {
    pub name: String,
    pub category: StateCategory,
}

/// Everything too long for a row: what a person (or an agent) needs in order to
/// work on an item. Fetched per item, and *only* the parts a row does not
/// already carry - the panel asks for this while holding the item itself, so
/// sending the item back would be a second copy, and for Azure DevOps a second
/// request to normalize it with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemDetail {
    /// Description, acceptance criteria and repro steps, as plain text.
    pub description: String,
    /// The facts worth reading beside it, in the order they read best, each as
    /// the service labels it: who it is assigned to, which sprint, how urgent.
    /// A list rather than fields, because every service has a different set and
    /// the panel only ever renders them.
    pub facts: Vec<Fact>,
}

/// One entry of the conversation on an item.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// Who wrote it, as the service names them.
    pub author: String,
    /// When, exactly as the service reports it; the UI formats it.
    pub when: String,
    /// The text as words - every one of these services stores it as markup or as
    /// a document, and none of that belongs on screen.
    pub text: String,
}

impl Comment {
    /// The comment a service echoed after accepting one, with the text falling
    /// back to what was sent.
    ///
    /// Not every service echoes it: ClickUp answers a new comment with an id and
    /// a date and nothing else. The comment is on the item either way, so
    /// showing what was written beats showing a blank one.
    pub fn or_what_was_sent(mut self, sent: &str) -> Self {
        if self.text.trim().is_empty() {
            self.text = sent.to_string();
        }
        self
    }
}

/// One configured connection, with the secret it needs for this call only.
pub struct Connection {
    pub settings: Settings,
    pub token: String,
}

impl Connection {
    /// A setting, or the empty string — a missing optional field and an empty
    /// one mean the same thing to every connector.
    pub fn setting(&self, name: &str) -> &str {
        self.settings.get(name).map_or("", String::as_str)
    }

    /// A setting that must be there, refused by name when it is not. The
    /// connect form enforces this too; this is the guard for a hand-edited
    /// `trackers.json`.
    pub fn required(&self, name: &str) -> Result<&str, TrackerError> {
        let value = self.setting(name).trim();
        if value.is_empty() {
            return Err(TrackerError::Config(format!("'{name}' is missing")));
        }
        Ok(value)
    }
}

/// Why a tracker call failed, in the four kinds that need different words on
/// screen. The frontend maps the prefix to a localized message, the same way it
/// maps `CLI_MISSING::` from the AI providers.
#[derive(Debug)]
pub enum TrackerError {
    /// The service refused the credential — the everyday failure, because
    /// personal access tokens expire.
    Auth(String),
    /// The organization, project or item is not there (a typo, or no access).
    NotFound(String),
    /// The request never got an answer: offline, DNS, TLS, proxy.
    Network(String),
    /// The service answered, and said no.
    Api { status: u16, message: String },
    /// The stored connection cannot be used as it stands.
    Config(String),
}

impl fmt::Display for TrackerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TrackerError::Auth(detail) => write!(f, "TRACKER_AUTH::{detail}"),
            TrackerError::NotFound(detail) => write!(f, "TRACKER_NOT_FOUND::{detail}"),
            TrackerError::Network(detail) => write!(f, "TRACKER_NETWORK::{detail}"),
            TrackerError::Api { status, message } => write!(f, "TRACKER_API::{status}::{message}"),
            TrackerError::Config(detail) => write!(f, "TRACKER_CONFIG::{detail}"),
        }
    }
}

impl From<TrackerError> for String {
    fn from(error: TrackerError) -> Self {
        error.to_string()
    }
}

/// One work tracker Aime can talk to.
#[async_trait]
pub trait Connector: Send + Sync {
    /// Stable id, used in `trackers.json` and in the secret store.
    fn kind(&self) -> &'static str;

    /// Product name, shown as typed by its vendor.
    fn label(&self) -> &'static str;

    /// What the connect form asks for, in the order it shows the fields.
    fn fields(&self) -> &'static [ConnectionField];

    /// What the secret field is called on this service — "personal access
    /// token" and "API key" are not the same words to the person pasting one.
    fn secret_label(&self) -> &'static str;

    /// Page where the user creates that credential, as a template over the
    /// connect form's own fields (`{organization}`). The service knows the
    /// address; the form fills it in, and hides the link until it can.
    fn secret_help_url(&self) -> &'static str;

    /// Identity of a connection built from these settings. Two connections to
    /// the same project are the same connection, so reconnecting replaces
    /// rather than duplicates.
    fn connection_id(&self, settings: &Settings) -> String;

    /// One line naming the connection in the UI ("iodm / IODM").
    fn connection_label(&self, settings: &Settings) -> String;

    /// The work the panel is asking for (see [`WorkItemQuery`]).
    async fn work_items(
        &self,
        conn: &Connection,
        query: WorkItemQuery,
    ) -> Result<Vec<WorkItem>, TrackerError>;

    /// Everything needed to start work on one item, description included.
    async fn item_detail(&self, conn: &Connection, item: &WorkItem) -> Result<WorkItemDetail, TrackerError>;

    /// The states this item may be moved to, as its own service defines them.
    /// Asked for when the menu opens, never guessed - and asked about the *item*
    /// rather than its type, because the two services disagree about what
    /// decides the answer: Azure DevOps lists a work item type's states, Jira
    /// lists the transitions available from this issue's current status.
    async fn states(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<StateOption>, TrackerError>;

    /// The conversation on one item, oldest first. Read on demand: it is the
    /// second reason to open an item and never a reason to list one.
    async fn comments(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<Comment>, TrackerError>;

    /// Adds one comment, answering with it as the service stored it.
    async fn add_comment(
        &self,
        conn: &Connection,
        item: &WorkItem,
        text: &str,
    ) -> Result<Comment, TrackerError>;

    /// Moves one item, answering with the item as the service now reports it.
    async fn set_state(
        &self,
        conn: &Connection,
        item: &WorkItem,
        state: &str,
    ) -> Result<WorkItem, TrackerError>;
}
