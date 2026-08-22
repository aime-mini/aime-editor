//! Azure Boards, over the Azure DevOps REST API (`api-version=7.1`).
//!
//! Four facts shaped this file, all measured against `dev.azure.com` on
//! 2026-08-18 or read out of Microsoft's own OpenAPI spec:
//!
//! 1. **A rejected token is a 302, not a 401.** With no credential, or a wrong
//!    one, the service answers `302` towards `…/_signin` with an HTML body. A
//!    client that follows redirects ends up parsing a login page, so redirects
//!    are off and any redirect - or any success that is not JSON - is reported
//!    as "sign in again". An unknown organization is a plain `404`.
//! 2. **State names belong to the process template, not to Azure.** Agile says
//!    "New/Active/Resolved/Closed", Scrum "New/Committed/Done", Basic
//!    "To Do/Doing/Done", and a customized template says whatever it likes. So
//!    nothing here hard-codes a state: `GET workitemtypes` returns every type
//!    with its states *and their categories*, and that vocabulary is what
//!    decides which work counts as finished.
//! 3. **The spec's collection shapes and the service's disagree.** The spec
//!    types these responses as bare arrays; the service wraps them in
//!    `{"count":n,"value":[…]}`. Both are read, so neither can break the panel.
//! 4. **The version is per resource.** Most of Work Item Tracking is stable at
//!    7.1, but comments are still preview and answer `400 … the -preview flag
//!    must be supplied` to that number - so a route asks for the version its own
//!    operation declares (see `COMMENTS_API_VERSION`).

use async_trait::async_trait;
use reqwest::{Method, Url};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use super::connector::{
    Comment, Connection, ConnectionField, Connector, Fact, Parent, Settings, StateCategory, StateOption,
    TrackerError, WorkItem, WorkItemDetail, WorkItemQuery, MAX_WORK_ITEMS,
};
use super::http::client;
use super::rich_text::html_to_markdown;

pub struct AzureDevOps;

/// Where the hosted service lives; the field exists for Azure DevOps Server
/// (on-premises), whose collections sit under a company URL.
const DEFAULT_SERVER: &str = "https://dev.azure.com";
const API_VERSION: &str = "7.1";

/// The version is *per resource*, not per service: a resource still in preview
/// refuses the plain number with `400 The requested version "7.1" of the
/// resource is under preview. The -preview flag must be supplied`. Comments are
/// such a resource, and the suffix carries a revision of its own - both read
/// from the official swagger (`vsts-rest-api-specs`, `wit/7.1`), where the
/// operation is marked `x-ms-preview` and names this exact string in
/// `x-ms-docs-override-version`. Every other route this connector calls (work
/// items, batch, types, states, WIQL, team field values) is stable at 7.1.
const COMMENTS_API_VERSION: &str = "7.1-preview.4";

/// `workitemsbatch` accepts at most 200 ids in one call, so that is the page it
/// is walked in - up to `MAX_WORK_ITEMS` (see `connector`).
const BATCH_SIZE: usize = 200;

/// Fields a row shows, no more. All of them are system fields every work item
/// type has, which is what keeps a batch from failing on an unusual type.
/// Recency needs no field: the query sorts by it.
///
/// `System.Parent` is what makes a task say which story it belongs to - and a
/// test suite which plan - because in this service the backlog hierarchy *is* a
/// parent link. `System.AreaPath` is what a board is: a team's board is the work
/// under its area path, which is also how Azure Boards itself decides.
const LIST_FIELDS: [&str; 6] = [
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.Parent",
    "System.AreaPath",
    "System.IterationPath",
];

/// Facts worth reading beside an opened item, with the label each carries in the
/// service. Anything a type does not define simply does not come back.
/// `System.IterationPath` is deliberately absent: the sprint is already one of
/// the item's dimensions, where it reads as "Sprint 24" rather than as the
/// backslash path it is stored under.
const DETAIL_FACTS: [(&str, &str); 4] = [
    ("System.AssignedTo", "Assigned to"),
    ("Microsoft.VSTS.Common.Priority", "Priority"),
    ("Microsoft.VSTS.Scheduling.RemainingWork", "Remaining"),
    ("System.ChangedDate", "Changed"),
];

/// The long text fields, in the order they read best. A type that does not
/// define one simply does not return it.
const DETAIL_SECTIONS: [(&str, &str); 3] = [
    ("System.Description", "Description"),
    ("Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance criteria"),
    ("Microsoft.VSTS.TCM.ReproSteps", "Repro steps"),
];

const CONNECT_FIELDS: [ConnectionField; 4] = [
    ConnectionField {
        name: "organization",
        placeholder: "contoso",
        optional: false,
    },
    ConnectionField {
        name: "project",
        placeholder: "Contoso Web",
        optional: false,
    },
    ConnectionField {
        // A project can carry several boards, one per team. Naming a team narrows
        // the panel to that team's board; leaving it empty shows the project.
        name: "team",
        placeholder: "Contoso Web Team",
        optional: true,
    },
    ConnectionField {
        name: "serverUrl",
        placeholder: DEFAULT_SERVER,
        optional: true,
    },
];

// ---------------------------------------------------------------- HTTP

/// A REST URL under the connection's organization and project.
///
/// Built segment by segment because both names are chosen by humans - "Contoso
/// Web" is a perfectly ordinary project - and a raw string would send a space.
fn api_url(conn: &Connection, tail: &[&str]) -> Result<Url, TrackerError> {
    api_url_at(conn, tail, API_VERSION)
}

/// The same URL, for a resource that speaks a version of its own (see
/// `COMMENTS_API_VERSION`).
fn api_url_at(conn: &Connection, tail: &[&str], api_version: &str) -> Result<Url, TrackerError> {
    let mut url = collection_url(conn)?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|()| TrackerError::Config("the server URL cannot hold a path".into()))?;
        path.extend(tail);
    }
    url.query_pairs_mut().append_pair("api-version", api_version);
    Ok(url)
}

/// The root every URL of this connection hangs off - which is *not* always
/// `{server}/{organization}`.
///
/// Azure DevOps has two URL forms for the same organization, and both are still
/// in use: `https://dev.azure.com/{organization}/…` and the older
/// `https://{organization}.visualstudio.com/…`, where the organization is the
/// host and must **not** appear in the path as well. Measured against a real
/// legacy organization on 2026-08-18: repeating it answers `404 The controller
/// for path '/IODM/IODM Accounts/_apis/wit/workitemtypes' was not found`, while
/// leaving it out answers the sign-in redirect that means "this route exists".
fn collection_url(conn: &Connection) -> Result<Url, TrackerError> {
    let server = match conn.setting("serverUrl").trim() {
        "" => DEFAULT_SERVER,
        given => given,
    };
    // A trailing slash would push an empty segment into every URL built here.
    let mut url = Url::parse(server.trim_end_matches('/'))
        .map_err(|e| TrackerError::Config(format!("'{server}' is not a URL: {e}")))?;
    let organization = conn.required("organization")?.to_string();
    if !organization_is_in_host(&url, &organization) {
        url.path_segments_mut()
            .map_err(|()| TrackerError::Config(format!("'{server}' cannot hold a path")))?
            .push(&organization);
    }
    Ok(url)
}

/// True for the legacy host that carries the organization itself. Narrowed to
/// `*.visualstudio.com` on purpose: on `dev.azure.com` the first label of the
/// host is "dev", and an organization may legitimately be called that.
fn organization_is_in_host(url: &Url, organization: &str) -> bool {
    let Some(host) = url.host_str().map(str::to_lowercase) else {
        return false;
    };
    host.ends_with(".visualstudio.com") && host.starts_with(&format!("{}.", organization.to_lowercase()))
}

/// Where a person opens one work item in their browser.
fn web_url(conn: &Connection, item_id: &str) -> Result<String, TrackerError> {
    let mut url = collection_url(conn)?;
    let project = conn.required("project")?.to_string();
    url.path_segments_mut()
        .map_err(|()| TrackerError::Config("the server URL cannot hold a path".into()))?
        .extend([project.as_str(), "_workitems", "edit", item_id]);
    Ok(url.to_string())
}

/// What a request carries. A work item update is a JSON Patch document and is
/// refused under any other content type, which is the whole reason this is not
/// simply an `Option<Value>`.
enum Payload {
    Empty,
    Json(Value),
    JsonPatch(Value),
}

/// A request with the token on it, answered as JSON or as a typed failure.
///
/// The token travels as HTTP basic auth with an empty user name, which is how
/// Azure DevOps takes a personal access token.
async fn call(conn: &Connection, method: Method, url: Url, payload: Payload) -> Result<Value, TrackerError> {
    let mut request = client()?
        .request(method, url.clone())
        .basic_auth("", Some(&conn.token));
    request = match payload {
        Payload::Empty => request,
        Payload::Json(body) => request.json(&body),
        Payload::JsonPatch(body) => request
            .header(reqwest::header::CONTENT_TYPE, "application/json-patch+json")
            .body(
                serde_json::to_vec(&body)
                    .map_err(|e| TrackerError::Config(format!("could not build the request body: {e}")))?,
            ),
    };
    let response = request
        .send()
        .await
        .map_err(|e| TrackerError::Network(format!("{}: {e}", url.host_str().unwrap_or("the server"))))?;

    let status = response.status();
    let json_body = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("json"));
    let body = response.bytes().await.unwrap_or_default();
    // The answers are UTF-8 JSON; anything else is a page, and reading it
    // loosely is enough to quote it back.
    let text = String::from_utf8_lossy(&body);

    // Anything that is not the JSON we asked for is the sign-in page, whatever
    // its status code says (measured: 302 for a wrong or expired token).
    if status.is_redirection() || (status.is_success() && !json_body) {
        return Err(TrackerError::Auth(
            "Azure DevOps answered with its sign-in page - the token is missing, wrong or expired".into(),
        ));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(TrackerError::Auth(api_message(&text, json_body)));
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(TrackerError::NotFound(api_message(&text, json_body)));
    }
    if !status.is_success() {
        return Err(TrackerError::Api {
            status: status.as_u16(),
            message: api_message(&text, json_body),
        });
    }
    serde_json::from_str(&text).map_err(|e| TrackerError::Api {
        status: status.as_u16(),
        message: format!("the answer was not the JSON it claimed to be: {e}"),
    })
}

/// Azure DevOps explains its refusals in a `message` field; anything else is
/// quoted back in short, because a page of HTML helps nobody.
fn api_message(body: &str, json_body: bool) -> String {
    if json_body {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(body) {
            if let Some(Value::String(message)) = map.get("message") {
                return message.clone();
            }
        }
    }
    if let Some(title) = html_title(body) {
        return title;
    }
    let summary: String = body.trim().chars().take(200).collect();
    if summary.is_empty() {
        "no explanation given".into()
    } else {
        summary
    }
}

/// The title of an error page, which is where IIS and ASP.NET put the sentence
/// worth reading - "The controller for path '…' was not found" names the very
/// path that was wrong. The rest of such a page is stylesheets.
fn html_title(body: &str) -> Option<String> {
    let opened = body.find("<title>")? + "<title>".len();
    let closed = body[opened..].find("</title>")?;
    let title = body[opened..opened + closed]
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
        .trim()
        .to_string();
    (!title.is_empty()).then_some(title)
}

/// The items of a collection, whichever of its two shapes arrived (see the
/// module note).
fn values(body: Value) -> Vec<Value> {
    match body {
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("value") {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

// ---------------------------------------------------- states and vocabulary

/// Azure's five state categories, in Aime's words. "Resolved" means fixed but
/// not yet accepted, which is still work in flight for whoever owns the item.
fn category_of(azure_category: &str) -> StateCategory {
    match azure_category {
        "Proposed" => StateCategory::Todo,
        "InProgress" | "Resolved" => StateCategory::InProgress,
        "Completed" => StateCategory::Done,
        "Removed" => StateCategory::Removed,
        _ => StateCategory::Unknown,
    }
}

/// Every state this project's process template defines, per work item type.
#[derive(Default)]
struct Vocabulary {
    by_type: BTreeMap<String, Vec<StateOption>>,
}

impl Vocabulary {
    fn from_types(types: Vec<Value>) -> Self {
        let mut by_type = BTreeMap::new();
        for item_type in types {
            let Some(name) = item_type.get("name").and_then(Value::as_str) else {
                continue;
            };
            by_type.insert(name.to_string(), state_options(item_type.get("states")));
        }
        Self { by_type }
    }

    fn category(&self, item_type: &str, state: &str) -> StateCategory {
        self.by_type
            .get(item_type)
            .and_then(|states| states.iter().find(|option| option.name == state))
            .map_or(StateCategory::Unknown, |option| option.category)
    }

    /// State names that mean "no longer being worked on" - the filter that
    /// keeps a decade of closed items out of the query.
    ///
    /// A name only counts when it is finished for *every* type that uses it: two
    /// types may share a name and disagree about it, and hiding another type's
    /// active work would be a silent lie.
    fn finished_states(&self) -> Vec<&str> {
        let mut names: Vec<&str> = Vec::new();
        for option in self.by_type.values().flatten() {
            let name = option.name.as_str();
            if names.contains(&name) {
                continue;
            }
            let finished_everywhere = self
                .by_type
                .values()
                .flatten()
                .filter(|other| other.name == option.name)
                .all(|other| other.category.is_finished());
            if finished_everywhere {
                names.push(name);
            }
        }
        // Sorted so the same template always produces the same query.
        names.sort_unstable();
        names
    }
}

fn state_options(states: Option<&Value>) -> Vec<StateOption> {
    values(states.cloned().unwrap_or(Value::Null))
        .into_iter()
        .filter_map(|state| {
            let name = state.get("name").and_then(Value::as_str)?.to_string();
            let category = category_of(state.get("category").and_then(Value::as_str).unwrap_or_default());
            Some(StateOption { name, category })
        })
        .collect()
}

/// The query behind the panel: the work asked for in this project, most recently
/// touched first.
///
/// The project is what keeps every version of this bounded, which is why "show
/// everyone's work" is still a query this service will answer. State names are
/// quoted the way WIQL quotes them (a `'` doubles), because they come from a
/// process template somebody else wrote.
fn wiql(finished_states: &[&str], asked: WorkItemQuery, board: Option<&str>) -> String {
    let mut query = String::from("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @Project");
    if asked.mine_only {
        query.push_str(" AND [System.AssignedTo] = @Me");
    }
    // One project can carry several boards; naming a team narrows the query to
    // the area paths that team's board is made of.
    if let Some(board) = board {
        query.push_str(&format!(" AND {board}"));
    }
    if !asked.include_finished && !finished_states.is_empty() {
        let quoted: Vec<String> = finished_states
            .iter()
            .map(|name| format!("'{}'", name.replace('\'', "''")))
            .collect();
        query.push_str(&format!(" AND [System.State] NOT IN ({})", quoted.join(", ")));
    }
    query.push_str(" ORDER BY [System.ChangedDate] DESC");
    query
}

// ------------------------------------------------------------- normalizing

/// One work item as the UI knows it, or nothing when the service returned a
/// stub instead (the `omit` error policy does that for an item this token may
/// not read).
fn work_item_from(item: &Value, vocabulary: &Vocabulary, conn: &Connection) -> Option<WorkItem> {
    let id = item.get("id").and_then(Value::as_i64)?.to_string();
    let fields = item.get("fields")?;
    let text = |name: &str| {
        fields
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    let item_type = text("System.WorkItemType");
    let state = text("System.State");
    Some(WorkItem {
        category: vocabulary.category(&item_type, &state),
        web_url: web_url(conn, &id).ok()?,
        // Addressed by the same id it is read by.
        display_id: None,
        id,
        title: text("System.Title"),
        item_type,
        state,
        // The id only: the parent's title takes another request, because the
        // parent is usually somebody else's item (see `name_the_parents`).
        parent: fields
            .get("System.Parent")
            .and_then(Value::as_i64)
            .map(|parent| Parent {
                id: parent.to_string(),
                title: String::new(),
            }),
        dimensions: dimensions_of(&text("System.AreaPath"), &text("System.IterationPath")),
    })
}

/// How this service files work: a team's board is an area path, a sprint is an
/// iteration. Both are paths, and what people say out loud is the last segment.
fn dimensions_of(area_path: &str, iteration_path: &str) -> Vec<Fact> {
    [("Board", area_path), ("Sprint", iteration_path)]
        .into_iter()
        .filter_map(|(label, path)| {
            Some(Fact {
                label: label.into(),
                value: leaf(path)?,
            })
        })
        .collect()
}

/// The last segment of a path. A path that is only the project name says nothing
/// a row does not already know, so it is left out rather than repeated on every
/// one of them.
fn leaf(path: &str) -> Option<String> {
    let leaf = path.rsplit_once('\\')?.1.trim();
    (!leaf.is_empty()).then(|| leaf.to_string())
}

/// One comment, as words. The service keeps the text as HTML, which is why this
/// goes through the same converter the description does.
fn comment_from(comment: &Value) -> Comment {
    let text = html_to_markdown(comment.get("text").and_then(Value::as_str).unwrap_or_default());
    Comment {
        author: comment
            .get("createdBy")
            .and_then(|person| person.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        when: comment
            .get("createdDate")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        text,
    }
}

/// The short facts of one item, labelled the way the service labels them.
fn facts_of(item: &Value) -> Vec<Fact> {
    let Some(fields) = item.get("fields") else {
        return Vec::new();
    };
    DETAIL_FACTS
        .into_iter()
        .filter_map(|(field, label)| {
            let raw = fields.get(field)?;
            // An identity is an object; everything else reads as it arrives.
            let value = match raw {
                Value::String(text) => text.clone(),
                Value::Object(_) => raw
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                other => other.to_string(),
            };
            (!value.is_empty()).then(|| Fact {
                label: label.into(),
                value,
            })
        })
        .collect()
}

/// The long fields of one item, as plain text an agent can read.
fn description_of(item: &Value) -> String {
    let Some(fields) = item.get("fields") else {
        return String::new();
    };
    let sections: Vec<(&str, String)> = DETAIL_SECTIONS
        .into_iter()
        .filter_map(|(field, heading)| {
            let text = html_to_markdown(fields.get(field).and_then(Value::as_str).unwrap_or_default());
            (!text.is_empty()).then_some((heading, text))
        })
        .collect();
    // A single section needs no heading: the view already calls it the
    // description, and "Description:" written over it reads as a stutter. Two or
    // three of them do, because then the reader has to tell them apart.
    match sections.as_slice() {
        [(_, only)] => only.clone(),
        several => several
            .iter()
            .map(|(heading, text)| format!("## {heading}\n\n{text}"))
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}

// --------------------------------------------------------------- connector

#[async_trait]
impl Connector for AzureDevOps {
    fn kind(&self) -> &'static str {
        "azure-devops"
    }

    fn label(&self) -> &'static str {
        "Azure DevOps"
    }

    fn fields(&self) -> &'static [ConnectionField] {
        &CONNECT_FIELDS
    }

    fn secret_label(&self) -> &'static str {
        "Personal access token"
    }

    fn secret_help_url(&self) -> &'static str {
        "https://dev.azure.com/{organization}/_usersSettings/tokens"
    }

    fn connection_id(&self, settings: &Settings) -> String {
        let value = |name: &str| {
            settings
                .get(name)
                .map_or("", String::as_str)
                .trim()
                .to_lowercase()
        };
        format!("azure-devops:{}/{}", value("organization"), value("project"))
    }

    fn connection_label(&self, settings: &Settings) -> String {
        let value = |name: &str| settings.get(name).map_or("", String::as_str).trim().to_string();
        format!("{} / {}", value("organization"), value("project"))
    }

    async fn work_items(
        &self,
        conn: &Connection,
        query: WorkItemQuery,
    ) -> Result<Vec<WorkItem>, TrackerError> {
        let vocabulary = self.vocabulary(conn).await?;
        let ids = self.query_ids(conn, &vocabulary, query).await?;

        // The query answers with ids only; the fields come in batches of 200,
        // walked until the cap is reached.
        let mut by_id: BTreeMap<String, WorkItem> = BTreeMap::new();
        for chunk in ids.chunks(BATCH_SIZE) {
            let body = call(
                conn,
                Method::POST,
                api_url(
                    conn,
                    &[conn.required("project")?, "_apis", "wit", "workitemsbatch"],
                )?,
                Payload::Json(json!({
                    "ids": chunk,
                    "fields": LIST_FIELDS,
                    // One item this token may not read must not cost the whole list.
                    "errorPolicy": "omit",
                })),
            )
            .await?;
            by_id.extend(
                values(body)
                    .iter()
                    .filter_map(|item| work_item_from(item, &vocabulary, conn))
                    .map(|item| (item.id.clone(), item)),
            );
        }

        // The batches answer in their own order; the query's order is the one the
        // user asked for, so the items are put back into it.
        let mut items: Vec<WorkItem> = ids
            .iter()
            .filter_map(|id| by_id.remove(&id.to_string()))
            .collect();
        self.name_the_parents(conn, &mut items).await?;
        Ok(items)
    }

    /// One request. Opening an item used to read the whole process template
    /// first - every type with every state - only to hand back an item the panel
    /// was already showing, which is what made the first click on a real
    /// organization take seconds.
    async fn item_detail(&self, conn: &Connection, item: &WorkItem) -> Result<WorkItemDetail, TrackerError> {
        let fetched = call(conn, Method::GET, self.item_url(conn, &item.id)?, Payload::Empty).await?;
        Ok(WorkItemDetail {
            description: description_of(&fetched),
            facts: facts_of(&fetched),
        })
    }

    /// Azure DevOps defines states per work item type, and every item of that
    /// type may be moved to any of them.
    async fn states(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<StateOption>, TrackerError> {
        let url = api_url(
            conn,
            &[
                conn.required("project")?,
                "_apis",
                "wit",
                "workitemtypes",
                &item.item_type,
                "states",
            ],
        )?;
        let body = call(conn, Method::GET, url, Payload::Empty).await?;
        Ok(state_options(Some(&body)))
    }

    async fn comments(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<Comment>, TrackerError> {
        let body = call(conn, Method::GET, self.comments_url(conn, item)?, Payload::Empty).await?;
        Ok(values(body.get("comments").cloned().unwrap_or(Value::Null))
            .iter()
            .map(comment_from)
            .collect())
    }

    async fn add_comment(
        &self,
        conn: &Connection,
        item: &WorkItem,
        text: &str,
    ) -> Result<Comment, TrackerError> {
        let posted = call(
            conn,
            Method::POST,
            self.comments_url(conn, item)?,
            Payload::Json(json!({ "text": text })),
        )
        .await?;
        Ok(comment_from(&posted).or_what_was_sent(text))
    }

    async fn set_state(
        &self,
        conn: &Connection,
        item: &WorkItem,
        state: &str,
    ) -> Result<WorkItem, TrackerError> {
        let vocabulary = self.vocabulary(conn).await?;
        let patch = json!([{ "op": "add", "path": "/fields/System.State", "value": state }]);
        let updated = call(
            conn,
            Method::PATCH,
            self.item_url(conn, &item.id)?,
            Payload::JsonPatch(patch),
        )
        .await?;
        work_item_from(&updated, &vocabulary, conn).ok_or_else(|| TrackerError::Api {
            status: 200,
            message: format!("work item {} came back without its fields", item.id),
        })
    }
}

impl AzureDevOps {
    /// Gives every parent a title.
    ///
    /// The list is mostly children: a story belongs to whoever owns it and its
    /// tasks to whoever does them, so "my work" is tasks whose parent is somebody
    /// else's item - and a row that cannot say what it belongs to is what makes a
    /// board unreadable. One batch answers all of them at once, and a parent that
    /// is already in the list needs no request at all.
    async fn name_the_parents(&self, conn: &Connection, items: &mut [WorkItem]) -> Result<(), TrackerError> {
        let known: BTreeMap<String, String> = items
            .iter()
            .map(|item| (item.id.clone(), item.title.clone()))
            .collect();
        let missing: Vec<i64> = items
            .iter()
            .filter_map(|item| item.parent.as_ref())
            .filter(|parent| !known.contains_key(&parent.id))
            .filter_map(|parent| parent.id.parse().ok())
            .collect::<std::collections::BTreeSet<i64>>()
            .into_iter()
            .take(BATCH_SIZE)
            .collect();

        let mut titles = known;
        if !missing.is_empty() {
            let body = call(
                conn,
                Method::POST,
                api_url(conn, &["_apis", "wit", "workitemsbatch"])?,
                Payload::Json(json!({
                    "ids": missing,
                    "fields": ["System.Title"],
                    "errorPolicy": "omit",
                })),
            )
            .await?;
            for parent in values(body) {
                let Some(id) = parent.get("id").and_then(Value::as_i64) else {
                    continue;
                };
                let title = parent
                    .get("fields")
                    .and_then(|fields| fields.get("System.Title"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                titles.insert(id.to_string(), title.to_string());
            }
        }

        for item in items {
            if let Some(parent) = item.parent.as_mut() {
                // A parent this token cannot read keeps its id, which is still
                // more than nothing to go on.
                parent.title = titles
                    .get(&parent.id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{}", parent.id));
            }
        }
        Ok(())
    }

    /// The area paths a team's board is made of, when a team was named.
    ///
    /// This is how Azure Boards itself decides what belongs on a board, which is
    /// why the panel asks the same question rather than inventing a filter: the
    /// team says which field and which values, and whether children count.
    async fn team_scope(&self, conn: &Connection) -> Result<Option<String>, TrackerError> {
        let team = conn.setting("team").trim().to_string();
        if team.is_empty() {
            return Ok(None);
        }
        let url = api_url(
            conn,
            &[
                conn.required("project")?,
                &team,
                "_apis",
                "work",
                "teamsettings",
                "teamfieldvalues",
            ],
        )?;
        let body = call(conn, Method::GET, url, Payload::Empty).await?;

        let field = body
            .get("field")
            .and_then(|field| field.get("referenceName"))
            .and_then(Value::as_str)
            .unwrap_or("System.AreaPath")
            .to_string();
        let clauses: Vec<String> = values(body.get("values").cloned().unwrap_or(Value::Null))
            .iter()
            .filter_map(|value| {
                let path = value.get("value")?.as_str()?;
                let quoted = format!("'{}'", path.replace('\'', "''"));
                Some(
                    if value.get("includeChildren").and_then(Value::as_bool) == Some(true) {
                        format!("[{field}] UNDER {quoted}")
                    } else {
                        format!("[{field}] = {quoted}")
                    },
                )
            })
            .collect();
        Ok((!clauses.is_empty()).then(|| format!("({})", clauses.join(" OR "))))
    }

    /// Every state this project defines, asked for on every refresh rather than
    /// cached: it is one request, and a cache here would answer with yesterday's
    /// process template after somebody edits it.
    async fn vocabulary(&self, conn: &Connection) -> Result<Vocabulary, TrackerError> {
        let url = api_url(
            conn,
            &[conn.required("project")?, "_apis", "wit", "workitemtypes"],
        )?;
        Ok(Vocabulary::from_types(values(
            call(conn, Method::GET, url, Payload::Empty).await?,
        )))
    }

    /// The ids the panel will show, in the order the query returned them.
    async fn query_ids(
        &self,
        conn: &Connection,
        vocabulary: &Vocabulary,
        asked: WorkItemQuery,
    ) -> Result<Vec<i64>, TrackerError> {
        let mut url = api_url(conn, &[conn.required("project")?, "_apis", "wit", "wiql"])?;
        url.query_pairs_mut()
            .append_pair("$top", &MAX_WORK_ITEMS.to_string());
        let board = self.team_scope(conn).await?;
        let query = wiql(&vocabulary.finished_states(), asked, board.as_deref());
        let body = call(conn, Method::POST, url, Payload::Json(json!({ "query": query }))).await?;
        Ok(values(body.get("workItems").cloned().unwrap_or(Value::Null))
            .iter()
            .filter_map(|reference| reference.get("id").and_then(Value::as_i64))
            .take(MAX_WORK_ITEMS)
            .collect())
    }

    /// Where one item's conversation lives. Note the capital I: the service
    /// spells this route `workItems` while the single-item route is `workitems`,
    /// and both are what its own document says.
    fn comments_url(&self, conn: &Connection, item: &WorkItem) -> Result<Url, TrackerError> {
        let id: u64 = item
            .id
            .parse()
            .map_err(|_| TrackerError::Config(format!("'{}' is not a work item id", item.id)))?;
        api_url_at(
            conn,
            &[
                conn.required("project")?,
                "_apis",
                "wit",
                "workItems",
                &id.to_string(),
                "comments",
            ],
            COMMENTS_API_VERSION,
        )
    }

    /// One item's REST URL. The id is parsed first: it arrives from the
    /// frontend, and Azure DevOps ids are numbers.
    fn item_url(&self, conn: &Connection, item_id: &str) -> Result<Url, TrackerError> {
        let id: u64 = item_id
            .parse()
            .map_err(|_| TrackerError::Config(format!("'{item_id}' is not a work item id")))?;
        api_url(
            conn,
            &[
                conn.required("project")?,
                "_apis",
                "wit",
                "workitems",
                &id.to_string(),
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The query the panel opens with, and the two it offers next to it.
    const MINE: WorkItemQuery = WorkItemQuery {
        mine_only: true,
        include_finished: false,
    };
    const MINE_AND_DONE: WorkItemQuery = WorkItemQuery {
        mine_only: true,
        include_finished: true,
    };
    #[allow(dead_code)]
    const EVERYONE: WorkItemQuery = WorkItemQuery {
        mine_only: false,
        include_finished: false,
    };

    use crate::trackers::test_service::{json_response, response, FakeService};

    /// A work item the way the panel hands one back to ask what it can do next.
    fn item(id: &str, item_type: &str, state: &str) -> WorkItem {
        WorkItem {
            id: id.into(),
            title: "Whatever".into(),
            item_type: item_type.into(),
            state: state.into(),
            category: StateCategory::InProgress,
            web_url: String::new(),
            display_id: None,
            parent: None,
            dimensions: Vec::new(),
        }
    }

    /// The connection every test here drives, pointed at the stand-in.
    fn connection(service: &FakeService, token: &str) -> Connection {
        let mut settings = Settings::new();
        settings.insert("organization".into(), "contoso".into());
        // A space in the project name is ordinary, and it must be encoded.
        settings.insert("project".into(), "Contoso Web".into());
        settings.insert("serverUrl".into(), service.base.clone());
        Connection {
            settings,
            token: token.into(),
        }
    }
    /// Two work item types, each with its own vocabulary - the Scrum-style
    /// "Committed" next to the Basic-style "Doing" - so nothing can pass by
    /// recognising Azure's default names.
    const WORK_ITEM_TYPES: &str = r#"{"count":2,"value":[
        {"name":"Bug","states":[
            {"name":"Committed","category":"InProgress"},
            {"name":"Shipped","category":"Completed"}]},
        {"name":"Task","states":[
            {"name":"Doing","category":"InProgress"},
            {"name":"Parked","category":"Proposed"},
            {"name":"Shipped","category":"Completed"},
            {"name":"Dropped","category":"Removed"}]}]}"#;

    /// The batch answers in its own order, and 7 comes back before 42.
    const BATCH: &str = r#"{"count":2,"value":[
        {"id":7,"fields":{"System.Title":"Second","System.State":"Doing",
            "System.WorkItemType":"Task","System.ChangedDate":"2026-08-17T09:00:00Z"}},
        {"id":42,"fields":{"System.Title":"First","System.State":"Committed",
            "System.WorkItemType":"Bug","System.ChangedDate":"2026-08-18T08:00:00Z",
            "System.AssignedTo":{"displayName":"Linh Pham","uniqueName":"linh@example.com"}}}]}"#;

    /// The same two items, filed on a board and in a sprint, and both sitting
    /// under something: 42 under a story outside the list, 7 under 42.
    const PARENTED_BATCH: &str = r#"{"count":2,"value":[
        {"id":42,"fields":{"System.Title":"First","System.State":"Committed",
            "System.WorkItemType":"Bug","System.Parent":100,
            "System.AreaPath":"Contoso Web\\Accounts",
            "System.IterationPath":"Contoso Web\\Sprint 24"}},
        {"id":7,"fields":{"System.Title":"Second","System.State":"Doing",
            "System.WorkItemType":"Task","System.Parent":42,
            "System.AreaPath":"Contoso Web"}}]}"#;

    /// What a team answers when asked which work is on its board: the field, and
    /// one path with its children and one without.
    const TEAM_FIELD_VALUES: &str = r#"{"field":{"referenceName":"System.AreaPath"},
        "defaultValue":"Contoso Web\\Accounts",
        "values":[
            {"value":"Contoso Web\\Accounts","includeChildren":true},
            {"value":"Contoso Web\\Shared","includeChildren":false}]}"#;

    /// One comment, as the service keeps it: HTML, with a non-breaking space.
    const COMMENTS: &str = r##"{"totalCount":1,"count":1,"comments":[
        {"id":1,"text":"<div>Reproduced on Firefox as well.<br>Since&nbsp;Monday.</div>",
         "createdBy":{"displayName":"Mai Tran"},"createdDate":"2026-08-17T09:00:00Z"}]}"##;

    fn azure_service() -> FakeService {
        FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else if request.target.contains("wiql") {
                json_response(r#"{"queryType":"flat","workItems":[{"id":42},{"id":7}]}"#)
            } else if request.target.contains("workitemsbatch") {
                json_response(BATCH)
            } else {
                json_response("{}")
            }
        })
    }

    #[tokio::test]
    async fn a_refresh_asks_the_real_questions_and_normalizes_the_answers() {
        let service = azure_service();
        let items = AzureDevOps
            .work_items(&connection(&service, "pat-1"), MINE)
            .await
            .expect("the list");

        // The query's order is the user's order, not the batch's.
        assert_eq!(
            items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["42", "7"],
            "items must come back in the order the query returned them"
        );

        let bug = &items[0];
        assert_eq!(bug.title, "First");
        assert_eq!(bug.item_type, "Bug");
        assert_eq!(
            bug.state, "Committed",
            "the team's own word for the state is kept"
        );
        assert_eq!(
            bug.category,
            StateCategory::InProgress,
            "the category must come from the project's process template"
        );
        assert!(
            bug.web_url.ends_with("/contoso/Contoso%20Web/_workitems/edit/42"),
            "a project name with a space must be encoded: {}",
            bug.web_url
        );

        // The token travels as basic auth with an empty user name, which is what
        // Azure DevOps accepts for a personal access token: base64(":pat-1").
        let wiql = service.request_for("wiql");
        assert_eq!(wiql.authorization, "Basic OnBhdC0x");
        assert_eq!(wiql.method, "POST");
        assert!(
            wiql.target.contains("api-version=7.1") && wiql.target.contains("%24top=300"),
            "the query must be capped and versioned: {}",
            wiql.target
        );
        // The finished states came from the template, not from a guess - and
        // "Parked" (Proposed) and "Doing" (InProgress) must not be in there.
        assert!(
            wiql.body.contains(r"NOT IN ('Dropped', 'Shipped')"),
            "the state filter must be built from the project's own vocabulary: {}",
            wiql.body
        );
        assert!(
            service
                .request_for("workitemsbatch")
                .body
                .contains("\"errorPolicy\":\"omit\""),
            "one unreadable item must not cost the whole list"
        );
    }

    #[tokio::test]
    async fn more_ids_than_one_batch_takes_are_fetched_in_batches() {
        // The query answers with ids and takes `$top`; the batch endpoint takes
        // 200 of them at a time, so 250 ids is two requests and not a silent 200.
        let service = FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                return json_response(WORK_ITEM_TYPES);
            }
            if request.target.contains("wiql") {
                let ids: Vec<String> = (1..=250).map(|id| format!(r#"{{"id":{id}}}"#)).collect();
                return json_response(&format!(r#"{{"workItems":[{}]}}"#, ids.join(",")));
            }
            // Answer with exactly the ids that were asked for, out of order.
            let asked: Value = serde_json::from_str(&request.body).expect("a batch body");
            let items: Vec<String> = asked["ids"]
                .as_array()
                .expect("ids")
                .iter()
                .rev()
                .map(|id| {
                    format!(
                        r#"{{"id":{id},"fields":{{"System.Title":"Item {id}","System.State":"Doing",
                            "System.WorkItemType":"Task"}}}}"#
                    )
                })
                .collect();
            json_response(&format!(
                r#"{{"count":{},"value":[{}]}}"#,
                items.len(),
                items.join(",")
            ))
        });

        let items = AzureDevOps
            .work_items(&connection(&service, "pat-1"), MINE)
            .await
            .expect("the list");

        assert_eq!(items.len(), 250, "the second batch was never asked for");
        assert_eq!(
            items.first().map(|item| item.id.as_str()),
            Some("1"),
            "the query's order has to survive being fetched in pieces"
        );
        assert_eq!(items.last().map(|item| item.id.as_str()), Some("250"));

        let batches: Vec<usize> = service
            .requests()
            .into_iter()
            .filter(|seen| seen.target.contains("workitemsbatch"))
            .map(|seen| {
                serde_json::from_str::<Value>(&seen.body).expect("a batch body")["ids"]
                    .as_array()
                    .expect("ids")
                    .len()
            })
            .collect();
        assert_eq!(
            batches,
            [BATCH_SIZE, 50],
            "the batch limit is what decides the pieces"
        );
    }

    #[tokio::test]
    async fn the_sign_in_redirect_is_reported_as_a_rejected_token() {
        // Measured against dev.azure.com on 2026-08-18: a wrong or expired token
        // is answered with 302 to …/_signin and an HTML body, never a 401.
        let service = FakeService::start(|_| {
            response(
                "302 Found",
                "text/html; charset=utf-8",
                "<html><head><title>Object moved</title></head>",
            )
        });

        let error = AzureDevOps
            .work_items(&connection(&service, "expired"), MINE)
            .await
            .expect_err("a sign-in page must never read as success");

        let message = error.to_string();
        assert!(
            message.starts_with("TRACKER_AUTH::"),
            "the panel needs to say 'sign in again', not 'unexpected answer': {message}"
        );
    }

    #[tokio::test]
    async fn a_success_that_is_not_json_is_also_a_rejected_token() {
        // The other shape of the same failure: 200 with the sign-in page.
        let service = FakeService::start(|_| response("200 OK", "text/html", "<html>"));

        let error = AzureDevOps
            .work_items(&connection(&service, "expired"), MINE)
            .await
            .expect_err("HTML is not a work item list");
        assert!(error.to_string().starts_with("TRACKER_AUTH::"));
    }

    #[tokio::test]
    async fn a_state_change_is_sent_as_a_json_patch_document() {
        let service = FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else {
                json_response(
                    r#"{"id":42,"rev":8,"fields":{"System.Title":"First","System.State":"Shipped",
                        "System.WorkItemType":"Bug"}}"#,
                )
            }
        });

        let item = AzureDevOps
            .set_state(
                &connection(&service, "pat-1"),
                &item("42", "Bug", "Committed"),
                "Shipped",
            )
            .await
            .expect("the update");

        assert_eq!(item.state, "Shipped");
        assert_eq!(
            item.category,
            StateCategory::Done,
            "the new state's category must be resolved too"
        );
        let patch = service.request_for("workitems/42");
        assert_eq!(patch.method, "PATCH");
        assert_eq!(
            patch.content_type, "application/json-patch+json",
            "Azure DevOps refuses a work item update sent as plain JSON"
        );
        assert_eq!(
            patch.body,
            r#"[{"op":"add","path":"/fields/System.State","value":"Shipped"}]"#
        );
    }

    #[tokio::test]
    async fn a_missing_item_is_told_apart_from_a_broken_one() {
        let service = FakeService::start(|_| {
            response(
                "404 Not Found",
                "application/json",
                r#"{"message":"TF401232: Work item 999 does not exist."}"#,
            )
        });

        let error = AzureDevOps
            .item_detail(&connection(&service, "pat-1"), &item("999", "Bug", "Committed"))
            .await
            .expect_err("a missing item is a failure")
            .to_string();
        assert!(error.starts_with("TRACKER_NOT_FOUND::"), "{error}");
        assert!(
            error.contains("TF401232"),
            "the service's own explanation is the useful half: {error}"
        );
    }

    #[tokio::test]
    async fn an_items_long_fields_arrive_as_readable_text() {
        let service = FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else {
                json_response(
                    r#"{"id":42,"fields":{"System.Title":"Login fails","System.State":"Committed",
                        "System.WorkItemType":"Bug",
                        "System.Description":"<div>Users can&#39;t sign in.<br>Since&nbsp;Monday.</div>",
                        "Microsoft.VSTS.TCM.ReproSteps":"<ol><li>Open /login</li><li>Submit</li></ol>"}}"#,
                )
            }
        });

        let detail = AzureDevOps
            .item_detail(&connection(&service, "pat-1"), &item("42", "Bug", "Committed"))
            .await
            .expect("the detail");

        assert_eq!(
            detail.description,
            "## Description\n\nUsers can't sign in.\nSince Monday.\n\n## Repro steps\n\n1. Open /login\n2. Submit",
            "the markup becomes Markdown: numbered steps stay numbered, and no raw entity survives"
        );
        assert_eq!(
            service.requests().len(),
            1,
            "opening an item must cost one request: {:?}",
            service
                .requests()
                .iter()
                .map(|seen| seen.target.clone())
                .collect::<Vec<_>>()
        );
    }

    /// The one thing a stand-in service cannot prove: that this client can
    /// complete a TLS handshake with the real Azure DevOps. rustls is built here
    /// without a bundled crypto provider (see Cargo.toml), so a missing
    /// `install_default` would fail every HTTPS request and nothing else in this
    /// file would notice.
    ///
    /// Ignored by default because it needs the network; run it with
    /// `cargo test -- --ignored real_azure`.
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn a_real_https_handshake_reaches_azure_devops() {
        let mut settings = Settings::new();
        // An organization nobody owns: measured 2026-08-18, dev.azure.com
        // answers 404 for it - which is an answer, and that is the point.
        settings.insert("organization".into(), "aime-no-such-org-xyz".into());
        settings.insert("project".into(), "None".into());
        let conn = Connection {
            settings,
            token: "not-a-real-token".into(),
        };

        let error = AzureDevOps
            .work_items(&conn, MINE)
            .await
            .expect_err("this organization must not exist")
            .to_string();
        assert!(
            error.starts_with("TRACKER_NOT_FOUND::") || error.starts_with("TRACKER_AUTH::"),
            "the handshake itself failed, so the client never got an answer: {error}"
        );
    }

    #[test]
    fn everyones_work_drops_the_assignee_clause_and_stays_bounded() {
        let mine = wiql(&["Shipped"], MINE, None);
        assert!(mine.contains("[System.AssignedTo] = @Me"), "{mine}");

        let everyone = wiql(&["Shipped"], EVERYONE, None);
        assert!(
            !everyone.contains("AssignedTo"),
            "'all' means the assignee is not part of the question: {everyone}"
        );
        assert!(
            everyone.contains("[System.TeamProject] = @Project"),
            "the project is what keeps it a query the service will answer: {everyone}"
        );
    }

    #[test]
    fn asking_for_finished_work_drops_the_state_filter() {
        let with_filter = wiql(&["Shipped"], MINE, None);
        assert!(with_filter.contains("NOT IN ('Shipped')"));
        assert!(with_filter.contains("ORDER BY [System.ChangedDate] DESC"));
        assert!(
            !wiql(&["Shipped"], MINE_AND_DONE, None).contains("NOT IN"),
            "'include finished' means the query must not filter states at all"
        );
        assert!(
            !wiql(&[], MINE, None).contains("NOT IN"),
            "a template with no finished states must not produce an empty IN list"
        );
    }

    #[test]
    fn a_state_name_two_types_disagree_about_stays_in_the_query() {
        // "Done" is finished for Task and active for Approval - excluding it by
        // name would hide half the board.
        let vocabulary = Vocabulary::from_types(values(
            serde_json::from_str(
                r#"[{"name":"Task","states":[{"name":"Done","category":"Completed"},
                                             {"name":"Doing","category":"InProgress"}]},
                    {"name":"Approval","states":[{"name":"Done","category":"InProgress"}]}]"#,
            )
            .expect("valid test JSON"),
        ));

        assert!(
            vocabulary.finished_states().is_empty(),
            "a name is only finished when every type that uses it agrees"
        );
        assert_eq!(vocabulary.category("Task", "Done"), StateCategory::Done);
        assert_eq!(vocabulary.category("Approval", "Done"), StateCategory::InProgress);
        assert_eq!(
            vocabulary.category("Task", "Invented"),
            StateCategory::Unknown,
            "a state the template does not define must not be guessed at"
        );
    }

    #[test]
    fn a_state_name_with_a_quote_cannot_break_the_query() {
        assert!(wiql(&["Won't do"], MINE, None).contains("NOT IN ('Won''t do')"));
    }

    #[test]
    fn both_collection_shapes_are_read() {
        let wrapped: Value = serde_json::from_str(r#"{"count":1,"value":[{"id":1}]}"#).expect("json");
        let bare: Value = serde_json::from_str(r#"[{"id":1}]"#).expect("json");
        assert_eq!(values(wrapped).len(), 1, "the shape the service sends");
        assert_eq!(values(bare).len(), 1, "the shape the spec documents");
        assert!(values(Value::Null).is_empty());
    }

    /// The exact organization, project and error page of a real legacy
    /// organization, measured on 2026-08-18. Both URL forms serve it.
    #[test]
    fn the_legacy_host_carries_the_organization_and_must_not_repeat_it_in_the_path() {
        let url_for = |server: &str| {
            let mut settings = Settings::new();
            settings.insert("organization".into(), "IODM".into());
            settings.insert("project".into(), "IODM Accounts".into());
            settings.insert("serverUrl".into(), server.into());
            let conn = Connection {
                settings,
                token: "pat".into(),
            };
            api_url(&conn, &["IODM Accounts", "_apis", "wit", "workitemtypes"]).map(String::from)
        };

        // Measured: with the organization repeated, this very path answered 404
        // "The controller for path '/IODM/IODM Accounts/…' was not found".
        assert_eq!(
            url_for("https://iodm.visualstudio.com").expect("the legacy host"),
            "https://iodm.visualstudio.com/IODM%20Accounts/_apis/wit/workitemtypes?api-version=7.1"
        );
        // The modern host serves the same organization, and there it belongs in
        // the path.
        assert_eq!(
            url_for("").expect("the default host"),
            "https://dev.azure.com/IODM/IODM%20Accounts/_apis/wit/workitemtypes?api-version=7.1"
        );
        // An on-premises collection is a path too, whatever the host is called.
        assert_eq!(
            url_for("https://tfs.iodm.local/tfs").expect("on-premises"),
            "https://tfs.iodm.local/tfs/IODM/IODM%20Accounts/_apis/wit/workitemtypes?api-version=7.1"
        );
        // A host whose first label happens to match must not lose the path: an
        // organization really can be called "dev".
        let mut settings = Settings::new();
        settings.insert("organization".into(), "dev".into());
        settings.insert("project".into(), "Web".into());
        let conn = Connection {
            settings,
            token: "pat".into(),
        };
        assert_eq!(
            String::from(api_url(&conn, &["Web"]).expect("dev.azure.com")),
            "https://dev.azure.com/dev/Web?api-version=7.1"
        );
    }

    #[test]
    fn an_error_page_is_reported_by_its_title_rather_than_its_markup() {
        // The page a real organization answered with, cut to what matters.
        let page = concat!(
            "<!DOCTYPE html >
<html>
  <head>
    <title>The controller for path ",
            "&#39;/IODM/IODM Accounts/_apis/wit/workitemtypes&#39; was not found or does not ",
            "implement IController.</title>
    <style type=\"text/css\">html { height: 100%; }"
        );
        assert_eq!(
            api_message(page, false),
            "The controller for path '/IODM/IODM Accounts/_apis/wit/workitemtypes' was not found or does not implement IController.",
            "the one useful line of an error page must not be lost in its stylesheets"
        );
        // JSON still wins where there is JSON.
        assert_eq!(
            api_message(r#"{"message":"TF401232: not there"}"#, true),
            "TF401232: not there"
        );
        assert_eq!(api_message("", false), "no explanation given");
    }

    #[test]
    fn a_connection_is_identified_by_its_project_however_it_was_typed() {
        let mut settings = Settings::new();
        settings.insert("organization".into(), "Contoso".into());
        settings.insert("project".into(), "Contoso Web".into());
        assert_eq!(
            AzureDevOps.connection_id(&settings),
            "azure-devops:contoso/contoso web",
            "reconnecting with different capitals must replace the connection, not add one"
        );
        assert_eq!(AzureDevOps.connection_label(&settings), "Contoso / Contoso Web");
    }

    #[test]
    fn an_item_id_that_is_not_a_number_is_refused_before_it_reaches_a_url() {
        let mut settings = Settings::new();
        settings.insert("organization".into(), "contoso".into());
        settings.insert("project".into(), "web".into());
        let conn = Connection {
            settings,
            token: "pat".into(),
        };

        let error = AzureDevOps
            .item_url(&conn, "42/../../_apis/wit/workitems/1")
            .expect_err("an id from the frontend must not build its own path")
            .to_string();
        assert!(error.starts_with("TRACKER_CONFIG::"), "{error}");
        assert!(AzureDevOps.item_url(&conn, "42").is_ok());
    }

    /// A board's items are a tree, and the panel needs the names of the branches
    /// above them. The list itself already holds most of those names.
    #[tokio::test]
    async fn a_parent_already_in_the_list_costs_nothing_and_one_outside_it_costs_one_request() {
        let service = FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else if request.target.contains("wiql") {
                json_response(r#"{"queryType":"flat","workItems":[{"id":42},{"id":7}]}"#)
            } else if request.target.contains("workitemsbatch") {
                // The batch asking about the parents is the one that names 100.
                if request.body.contains("100") {
                    json_response(
                        r#"{"count":1,"value":[
                            {"id":100,"fields":{"System.Title":"Make the login screen behave"}}]}"#,
                    )
                } else {
                    json_response(PARENTED_BATCH)
                }
            } else {
                json_response("{}")
            }
        });

        let items = AzureDevOps
            .work_items(&connection(&service, "pat-1"), MINE)
            .await
            .expect("the list");

        assert_eq!(
            items[0].parent.as_ref().map(|parent| parent.title.as_str()),
            Some("Make the login screen behave"),
            "a parent outside the list must be named by asking the service"
        );
        assert_eq!(
            items[1].parent.as_ref().map(|parent| parent.title.as_str()),
            Some("First"),
            "a parent the list already holds must be named from the list"
        );

        let batches: Vec<_> = service
            .requests()
            .into_iter()
            .filter(|seen| seen.target.contains("workitemsbatch"))
            .collect();
        assert_eq!(
            batches.len(),
            2,
            "naming the parents must cost exactly one extra request"
        );
        assert!(
            batches[1].body.contains(r#""ids":[100]"#),
            "only the unknown parent should have been asked about: {}",
            batches[1].body
        );
        assert!(
            batches[1].body.contains(r#""fields":["System.Title"]"#),
            "a name is all that is wanted here: {}",
            batches[1].body
        );
    }

    /// Reading an item is a permission of its own: a parent in another project can
    /// be invisible to the same token.
    #[tokio::test]
    async fn a_parent_this_token_cannot_read_keeps_its_id_rather_than_disappearing() {
        let service = FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else if request.target.contains("wiql") {
                json_response(r#"{"queryType":"flat","workItems":[{"id":42}]}"#)
            } else if request.target.contains("workitemsbatch") {
                if request.body.contains("100") {
                    // `errorPolicy: omit` is what leaves it out of the answer.
                    json_response(r#"{"count":0,"value":[]}"#)
                } else {
                    json_response(PARENTED_BATCH)
                }
            } else {
                json_response("{}")
            }
        });

        let items = AzureDevOps
            .work_items(&connection(&service, "pat-1"), MINE)
            .await
            .expect("the list");
        assert_eq!(
            items[0].parent.as_ref().map(|parent| parent.title.as_str()),
            Some("#100"),
            "an unreadable parent must still say which item it is"
        );
    }

    /// What a board files work under is what the panel groups by, and it is the
    /// leaf of the path: the project name in front of it is on every item and so
    /// says nothing.
    #[tokio::test]
    async fn the_board_and_the_sprint_arrive_as_the_leaves_of_the_paths_the_service_keeps() {
        let service = FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else if request.target.contains("wiql") {
                json_response(r#"{"queryType":"flat","workItems":[{"id":42},{"id":7}]}"#)
            } else if request.target.contains("workitemsbatch") {
                json_response(PARENTED_BATCH)
            } else {
                json_response("{}")
            }
        });

        let items = AzureDevOps
            .work_items(&connection(&service, "pat-1"), MINE)
            .await
            .expect("the list");

        assert_eq!(
            items[0]
                .dimensions
                .iter()
                .map(|fact| (fact.label.as_str(), fact.value.as_str()))
                .collect::<Vec<_>>(),
            [("Board", "Accounts"), ("Sprint", "Sprint 24")],
            "the item's own board and sprint must reach the panel"
        );
        assert!(
            items[1].dimensions.is_empty(),
            "an item filed at the project root has nothing to group by: {:?}",
            items[1].dimensions
        );
        assert!(
            service
                .request_for("workitemsbatch")
                .body
                .contains("System.AreaPath"),
            "the paths have to be asked for, or there is nothing to group by"
        );
    }

    /// A project can hold several boards, and Azure Boards decides what is on one
    /// by asking the team. The panel asks the same question rather than inventing
    /// a filter of its own.
    #[tokio::test]
    async fn a_team_becomes_the_board_filter_that_team_itself_defines() {
        let service = FakeService::start(|request| {
            if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else if request.target.contains("teamfieldvalues") {
                json_response(TEAM_FIELD_VALUES)
            } else if request.target.contains("wiql") {
                json_response(r#"{"queryType":"flat","workItems":[]}"#)
            } else {
                json_response("{}")
            }
        });
        let mut conn = connection(&service, "pat-1");
        conn.settings.insert("team".into(), "Accounts Team".into());

        AzureDevOps.work_items(&conn, MINE).await.expect("the list");

        let query = service.request_for("wiql").body;
        assert!(
            query.contains(r"([System.AreaPath] UNDER 'Contoso Web\\Accounts'"),
            "the board's own area path must filter the query: {query}"
        );
        assert!(
            query.contains(r"OR [System.AreaPath] = 'Contoso Web\\Shared')"),
            "a value that excludes its children must be matched exactly: {query}"
        );
        assert!(
            service
                .request_for("teamfieldvalues")
                .target
                .contains("Accounts%20Team"),
            "the team name has to survive its space"
        );
    }

    /// Without a team there is one board, and asking about it would be a request
    /// with nothing to do.
    #[tokio::test]
    async fn no_team_means_no_board_question_and_no_board_filter() {
        let service = azure_service();
        AzureDevOps
            .work_items(&connection(&service, "pat-1"), MINE)
            .await
            .expect("the list");

        assert!(
            !service
                .requests()
                .iter()
                .any(|seen| seen.target.contains("teamfieldvalues")),
            "a connection with no team must not ask which board it is"
        );
        let query = service.request_for("wiql").body;
        assert!(
            !query.contains("AreaPath"),
            "there is no board to filter by: {query}"
        );
    }

    /// The conversation, both ways. Note the route: the service spells this one
    /// `workItems` and the single-item route `workitems`, and a comment posted to
    /// the wrong spelling is a 404.
    #[tokio::test]
    async fn the_conversation_is_read_as_words_and_added_to_where_the_service_keeps_it() {
        let service = FakeService::start(|request| {
            if request.method == "POST" {
                json_response(r#"{"id":8,"text":"<div>Fixed on the language branch.</div>"}"#)
            } else {
                json_response(COMMENTS)
            }
        });
        let conn = connection(&service, "pat-1");
        let subject = item("42", "Bug", "Committed");

        let thread = AzureDevOps.comments(&conn, &subject).await.expect("the comments");
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].author, "Mai Tran");
        assert_eq!(
            thread[0].text, "Reproduced on Firefox as well.\nSince Monday.",
            "a comment must arrive as words, not as markup"
        );

        let posted = AzureDevOps
            .add_comment(&conn, &subject, "Fixed on the language branch.")
            .await
            .expect("the new comment");
        assert_eq!(posted.text, "Fixed on the language branch.");

        let sent = service
            .requests()
            .into_iter()
            .find(|seen| seen.method == "POST")
            .expect("the comment was never sent");
        assert!(
            sent.target.contains("/_apis/wit/workItems/42/comments"),
            "the comment went to the wrong route: {}",
            sent.target
        );
        assert_eq!(sent.body, r#"{"text":"Fixed on the language branch."}"#);
    }

    /// Comments are still a preview resource, and Azure DevOps versions each
    /// resource on its own: asked with the plain `7.1` every other route here
    /// uses, it answers `400 The requested version "7.1" of the resource is
    /// under preview. The -preview flag must be supplied` - which is exactly
    /// what opening an item on a real organization produced. Reading the item
    /// itself, on the other hand, must stay on the stable version.
    #[tokio::test]
    async fn the_conversation_asks_for_the_preview_version_that_resource_is_pinned_to() {
        let service = FakeService::start(|request| {
            if request.target.contains("comments") {
                json_response(COMMENTS)
            } else if request.target.contains("workitemtypes") {
                json_response(WORK_ITEM_TYPES)
            } else {
                json_response(
                    r#"{"id":42,"fields":{"System.Title":"First","System.State":"Committed",
                        "System.WorkItemType":"Bug"}}"#,
                )
            }
        });
        let conn = connection(&service, "pat-1");
        let subject = item("42", "Bug", "Committed");

        AzureDevOps.comments(&conn, &subject).await.expect("the comments");
        AzureDevOps
            .item_detail(&conn, &subject)
            .await
            .expect("the item itself");

        for seen in service.requests() {
            let expected = if seen.target.contains("comments") {
                "api-version=7.1-preview.4"
            } else {
                "api-version=7.1"
            };
            assert!(
                seen.target.contains(expected),
                "{} was asked with the wrong api-version (wanted {expected})",
                seen.target
            );
        }
    }

    /// A service that accepts a comment and echoes only an id still leaves the
    /// panel with something true to show.
    #[tokio::test]
    async fn a_comment_the_service_does_not_echo_keeps_the_words_that_were_sent() {
        let service = FakeService::start(|_| json_response(r#"{"id":9}"#));
        let posted = AzureDevOps
            .add_comment(
                &connection(&service, "pat-1"),
                &item("42", "Bug", "Committed"),
                "Shipped it.",
            )
            .await
            .expect("the new comment");
        assert_eq!(posted.text, "Shipped it.");
    }
}
