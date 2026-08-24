//! ClickUp, over API v2.
//!
//! Measured against `api.clickup.com` on 2026-08-18, and read out of ClickUp's
//! own OpenAPI 3.1 document. Four of those findings are why this file differs
//! from its neighbours:
//!
//! 1. **The token is the whole `Authorization` header, raw.** Measured: a
//!    personal token sent as-is answers `401 {"err":"Token invalid",…}` for a
//!    wrong token, while the *same* token behind `Bearer ` answers
//!    `"Oauth token not found"` - the prefix belongs to OAuth access tokens, not
//!    to personal ones.
//! 2. **A missing credential is a `400`, not a `401`**
//!    (`{"err":"Authorization header required","ECODE":"OAUTH_017"}`). So what
//!    decides "sign in again" here is the `OAUTH_` code, not the status.
//! 3. **A status is a name inside its list, not a global one.** The statuses a
//!    task may take are the ones its List defines, so the menu reads the task's
//!    list first. `status.type` is what places a status in the flow, and
//!    `custom` is ClickUp's word for "anything between the first and the last".
//! 4. **Descriptions can be asked for as Markdown**
//!    (`include_markdown_description=true`), which is already text - no markup
//!    to strip, unlike the other two services.

use async_trait::async_trait;
use reqwest::{Method, Url};
use serde_json::{json, Value};

use super::connector::{
    Comment, Connection, ConnectionField, Connector, Fact, Parent, Settings, StateCategory, StateOption,
    TrackerError, WorkItem, WorkItemDetail, WorkItemQuery, MAX_WORK_ITEMS,
};
use super::http::client;

pub struct ClickUp;

const DEFAULT_API: &str = "https://api.clickup.com/api/v2";

/// What one page holds, whatever is asked for (measured: 250 requested, 100
/// returned).
const PAGE_SIZE: usize = 100;

/// How many pages a refresh walks: enough for `MAX_WORK_ITEMS` (see
/// `connector`). Walking pages matters more here than elsewhere because the order
/// the service pages in is *not* documented - `reverse` is described only as
/// "reverse order", with no base direction - so trusting page 0 to hold the most
/// recent work would be a guess. Reading the pages and sorting them here is not.
const MAX_PAGES: usize = MAX_WORK_ITEMS.div_ceil(PAGE_SIZE);

const CONNECT_FIELDS: [ConnectionField; 1] = [ConnectionField {
    // ClickUp calls it a Workspace; the API still calls it a team. Optional
    // because most people have one, and one is not a choice worth typing.
    name: "workspace",
    placeholder: "My Workspace",
    optional: true,
}];

// ---------------------------------------------------------------- HTTP

/// Where the API lives. Not a form field, because ClickUp is hosted and there is
/// no second address a person could legitimately be asked for; it exists so the
/// tests can stand a service up on a real socket, and so anyone stuck behind a
/// gateway can point `trackers.json` at it by hand.
fn api_url(conn: &Connection, tail: &[&str]) -> Result<Url, TrackerError> {
    let base = match conn.setting("apiBase").trim() {
        "" => DEFAULT_API,
        given => given,
    };
    let mut url = Url::parse(base.trim_end_matches('/'))
        .map_err(|e| TrackerError::Config(format!("'{base}' is not a URL: {e}")))?;
    url.path_segments_mut()
        .map_err(|()| TrackerError::Config("the API URL cannot hold a path".into()))?
        .extend(tail);
    Ok(url)
}

/// A request carrying the token, answered as JSON or as a typed failure.
async fn call(
    conn: &Connection,
    method: Method,
    url: Url,
    body: Option<Value>,
) -> Result<Value, TrackerError> {
    let mut request = client()?
        .request(method, url.clone())
        // Raw, with no scheme in front of it (see the module note).
        .header(reqwest::header::AUTHORIZATION, conn.token.trim());
    if let Some(payload) = body {
        request = request.json(&payload);
    }
    let response = request
        .send()
        .await
        .map_err(|e| TrackerError::Network(format!("{}: {e}", url.host_str().unwrap_or("the API"))))?;

    let status = response.status();
    let bytes = response.bytes().await.unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);

    if status.is_success() {
        return serde_json::from_str(&text).map_err(|e| TrackerError::Api {
            status: status.as_u16(),
            // Unlike Azure DevOps, this service does not answer a wrong
            // credential with a page - so a page arriving here is more likely
            // something between Aime and it, and saying so beats guessing.
            message: format!(
                "the answer was not JSON, so something other than the API may have replied: {e}"
            ),
        });
    }

    let refusal: Option<Value> = serde_json::from_str(&text).ok();
    let code = refusal
        .as_ref()
        .and_then(|body| body.get("ECODE"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let message = api_message(refusal.as_ref(), &text);
    // The credential is what `OAUTH_…` is about, whatever status carried it -
    // and a missing header carries a 400 (measured).
    if code.starts_with("OAUTH_") || status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(TrackerError::Auth(message));
    }
    Err(match status.as_u16() {
        403 => TrackerError::Auth(message),
        404 => TrackerError::NotFound(message),
        other => TrackerError::Api {
            status: other,
            message,
        },
    })
}

/// ClickUp says what went wrong in `err`, with a code worth keeping: it is what
/// its own support answers questions about.
fn api_message(refusal: Option<&Value>, body: &str) -> String {
    if let Some(Value::Object(map)) = refusal {
        if let Some(err) = map.get("err").and_then(Value::as_str) {
            return match map.get("ECODE").and_then(Value::as_str) {
                Some(code) if !code.is_empty() => format!("{err} ({code})"),
                _ => err.to_string(),
            };
        }
    }
    let summary: String = body.trim().chars().take(200).collect();
    if summary.is_empty() {
        "no explanation given".into()
    } else {
        summary
    }
}

// ------------------------------------------------------------- normalizing

/// ClickUp's status types, in Aime's words. `custom` covers every status a
/// workspace invents between its first and its last, which is work in flight.
fn category_of(status_type: &str) -> StateCategory {
    match status_type {
        "open" => StateCategory::Todo,
        "custom" => StateCategory::InProgress,
        "done" | "closed" => StateCategory::Done,
        _ => StateCategory::Unknown,
    }
}

fn state_option(status: &Value) -> Option<StateOption> {
    Some(StateOption {
        name: status.get("status")?.as_str()?.to_string(),
        category: category_of(status.get("type").and_then(Value::as_str).unwrap_or_default()),
    })
}

/// One task as the UI knows it. A task with no id cannot be acted on, so it is
/// skipped rather than shown as a row that does nothing.
fn work_item_from(task: &Value) -> Option<WorkItem> {
    let status = task.get("status");
    Some(WorkItem {
        id: task.get("id")?.as_str()?.to_string(),
        title: task
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // ClickUp has one kind of thing, and calls a custom one a task too.
        item_type: "Task".into(),
        state: status
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        category: category_of(
            status
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        // The task carries its own address, so there is nothing to build.
        web_url: task
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // A subtask names its parent by id only. The title is filled in from the
        // list when the parent is in it - `subtasks=true` usually brings both -
        // and otherwise stays the id, which still places the row.
        parent: task
            .get("parent")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(|id| Parent {
                id: id.to_string(),
                title: String::new(),
            }),
        // A ClickUp list *is* a board, and a space is what holds several of them.
        dimensions: [("Board", "list"), ("Space", "space")]
            .into_iter()
            .filter_map(|(label, field)| {
                Some(Fact {
                    label: label.into(),
                    value: task.get(field)?.get("name")?.as_str()?.to_string(),
                })
            })
            .collect(),
        // One connection is one ClickUp workspace: nothing narrower to remember.
        scope: None,
        // A workspace with custom task ids on reads and says `DEV-123`; the API
        // still only answers to the internal id, so both travel.
        display_id: task
            .get("custom_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|custom| !custom.is_empty())
            .map(str::to_string),
    })
}

/// When a task was last touched. ClickUp sends this as a string of milliseconds,
/// which sorts correctly only as a number.
fn updated_at(task: &Value) -> i64 {
    task.get("date_updated")
        .and_then(Value::as_str)
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

/// One comment. ClickUp keeps the text plain, and also as a list of fragments -
/// the plain one is what a reader wants.
fn comment_from(comment: &Value) -> Comment {
    Comment {
        author: comment
            .get("user")
            .and_then(|user| user.get("username"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        when: comment
            .get("date")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        text: comment
            .get("comment_text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

/// The short facts of one task, in ClickUp's own words.
fn facts_of(task: &Value) -> Vec<Fact> {
    let mut facts = Vec::new();
    let assignees: Vec<String> = task
        .get("assignees")
        .and_then(Value::as_array)
        .map(|people| {
            people
                .iter()
                .filter_map(|person| person.get("username")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !assignees.is_empty() {
        facts.push(Fact {
            label: "Assignees".into(),
            value: assignees.join(", "),
        });
    }
    for (field, label) in [
        ("priority", "Priority"),
        ("due_date", "Due"),
        ("time_estimate", "Estimate"),
    ] {
        let value = match task.get(field) {
            // Priority is an object with a name; the rest are plain values.
            Some(Value::Object(map)) => map
                .get("priority")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            Some(Value::String(text)) => text.clone(),
            Some(Value::Number(number)) => number.to_string(),
            _ => String::new(),
        };
        if !value.is_empty() {
            facts.push(Fact {
                label: label.into(),
                value,
            });
        }
    }
    facts
}

/// A task id from the UI, checked before it becomes part of a path.
fn task_id(item: &WorkItem) -> Result<&str, TrackerError> {
    let id = item.id.trim();
    // `.` and `..` are not encoded but *resolved* by the URL crate (measured:
    // `/task/..` becomes `/task`), which would quietly call another endpoint.
    let addressable = !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.chars().any(char::is_whitespace);
    if !addressable {
        return Err(TrackerError::Config(format!("'{}' is not a task id", item.id)));
    }
    Ok(id)
}

// --------------------------------------------------------------- connector

#[async_trait]
impl Connector for ClickUp {
    fn kind(&self) -> &'static str {
        "clickup"
    }

    fn label(&self) -> &'static str {
        "ClickUp"
    }

    fn fields(&self) -> &'static [ConnectionField] {
        &CONNECT_FIELDS
    }

    fn secret_label(&self) -> &'static str {
        "API token"
    }

    fn secret_help_url(&self) -> &'static str {
        "https://app.clickup.com/settings/apps"
    }

    fn connection_id(&self, settings: &Settings) -> String {
        let workspace = settings
            .get("workspace")
            .map_or("", String::as_str)
            .trim()
            .to_lowercase();
        match workspace.as_str() {
            "" => "clickup".into(),
            named => format!("clickup:{named}"),
        }
    }

    fn connection_label(&self, settings: &Settings) -> String {
        match settings.get("workspace").map_or("", String::as_str).trim() {
            "" => "ClickUp".into(),
            named => format!("ClickUp / {named}"),
        }
    }

    async fn work_items(
        &self,
        conn: &Connection,
        asked: WorkItemQuery,
    ) -> Result<Vec<WorkItem>, TrackerError> {
        // Nobody's login is needed to list everybody's work.
        let user = if asked.mine_only {
            Some(self.user_id(conn).await?)
        } else {
            None
        };
        let workspace = self.workspace_id(conn).await?;

        let mut tasks: Vec<Value> = Vec::new();
        for page in 0..MAX_PAGES {
            let mut url = api_url(conn, &["team", &workspace, "task"])?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs
                    .append_pair("include_closed", &asked.include_finished.to_string())
                    .append_pair("subtasks", "true")
                    .append_pair("order_by", "updated")
                    .append_pair("reverse", "true")
                    .append_pair("page", &page.to_string());
                if let Some(user) = user.as_deref() {
                    pairs.append_pair("assignees[]", user);
                }
            }
            let body = call(conn, Method::GET, url, None).await?;

            let found = match body.get("tasks").and_then(Value::as_array) {
                Some(found) => found.clone(),
                None => break,
            };
            let complete_page = found.len() >= PAGE_SIZE;
            tasks.extend(found);
            if !complete_page {
                break;
            }
        }

        // Most recently touched first, decided here rather than hoped for from
        // the query (see MAX_PAGES). A task with no timestamp sorts last instead
        // of jumping to the top.
        tasks.sort_by_key(|task| std::cmp::Reverse(updated_at(task)));

        let items = tasks.iter().filter_map(work_item_from).take(MAX_WORK_ITEMS);
        Ok(if asked.include_finished {
            items.collect()
        } else {
            // `include_closed` speaks about closed statuses; a workspace can also
            // mark a status "done" without closing it, and that is finished work
            // the panel was not asked for.
            items.filter(|item| !item.category.is_finished()).collect()
        })
    }

    async fn item_detail(&self, conn: &Connection, item: &WorkItem) -> Result<WorkItemDetail, TrackerError> {
        let task = self.task(conn, item, true).await?;
        // Markdown is text already; the plain description is the fallback for a
        // task written before the field existed.
        let description = ["markdown_description", "description"]
            .into_iter()
            .filter_map(|field| task.get(field).and_then(Value::as_str))
            .map(str::trim)
            .find(|text| !text.is_empty())
            .unwrap_or_default()
            .to_string();
        Ok(WorkItemDetail {
            description,
            facts: facts_of(&task),
        })
    }

    /// The statuses this task's List defines - which is where a ClickUp status
    /// lives, so the task is read first to learn which list it is in.
    async fn states(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<StateOption>, TrackerError> {
        let task = self.task(conn, item, false).await?;
        let list_id = task
            .get("list")
            .and_then(|list| list.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| TrackerError::NotFound(format!("the list task {} is in", item.id)))?
            .to_string();

        let list = call(conn, Method::GET, api_url(conn, &["list", &list_id])?, None).await?;
        Ok(list
            .get("statuses")
            .and_then(Value::as_array)
            .map(|statuses| statuses.iter().filter_map(state_option).collect())
            .unwrap_or_else(Vec::new))
    }

    async fn comments(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<Comment>, TrackerError> {
        let url = api_url(conn, &["task", task_id(item)?, "comment"])?;
        let body = call(conn, Method::GET, url, None).await?;
        Ok(body
            .get("comments")
            .and_then(Value::as_array)
            .map(|comments| comments.iter().map(comment_from).collect())
            .unwrap_or_default())
    }

    async fn add_comment(
        &self,
        conn: &Connection,
        item: &WorkItem,
        text: &str,
    ) -> Result<Comment, TrackerError> {
        let url = api_url(conn, &["task", task_id(item)?, "comment"])?;
        let posted = call(
            conn,
            Method::POST,
            url,
            // `notify_all` says whether the workspace gets an email about it;
            // saying no is the quieter default for a comment from an editor.
            Some(json!({ "comment_text": text, "notify_all": false })),
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
        // A task is updated by name of status, and the answer is the task as it
        // now is - so nothing has to be read back.
        let updated = call(
            conn,
            Method::PUT,
            api_url(conn, &["task", task_id(item)?])?,
            Some(json!({ "status": state })),
        )
        .await?;
        work_item_from(&updated).ok_or_else(|| TrackerError::Api {
            status: 200,
            message: format!("task {} came back without its fields", item.id),
        })
    }
}

impl ClickUp {
    /// Who this token belongs to. Read per refresh rather than stored: a token
    /// replaced with somebody else's would otherwise keep listing the first
    /// person's work.
    async fn user_id(&self, conn: &Connection) -> Result<String, TrackerError> {
        let body = call(conn, Method::GET, api_url(conn, &["user"])?, None).await?;
        // Documented as a number, but a number and a string must both end up as
        // `183` in the query rather than as `"183"` with the quotes in it.
        body.get("user")
            .and_then(|user| user.get("id"))
            .and_then(|id| match id {
                Value::String(text) => Some(text.clone()),
                Value::Number(number) => Some(number.to_string()),
                _ => None,
            })
            .ok_or_else(|| TrackerError::Auth("ClickUp did not say who this token belongs to".into()))
    }

    /// The workspace to list from: the id if one was given, the named one if a
    /// name was, and the only one when nothing was.
    async fn workspace_id(&self, conn: &Connection) -> Result<String, TrackerError> {
        let wanted = conn.setting("workspace").trim().to_string();
        if wanted.chars().all(|character| character.is_ascii_digit()) && !wanted.is_empty() {
            return Ok(wanted);
        }

        let body = call(conn, Method::GET, api_url(conn, &["team"])?, None).await?;
        let workspaces: Vec<(String, String)> = body
            .get("teams")
            .and_then(Value::as_array)
            .map(|teams| {
                teams
                    .iter()
                    .filter_map(|team| {
                        Some((
                            team.get("id")?.as_str()?.to_string(),
                            team.get("name")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_else(Vec::new);

        if wanted.is_empty() {
            return match workspaces.as_slice() {
                [(id, _)] => Ok(id.clone()),
                [] => Err(TrackerError::NotFound(
                    "this token can see no ClickUp workspace".into(),
                )),
                many => Err(TrackerError::Config(format!(
                    "this token can see several workspaces, so name one: {}",
                    many.iter()
                        .map(|(_, name)| name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))),
            };
        }
        workspaces
            .iter()
            .find(|(_, name)| name.eq_ignore_ascii_case(&wanted))
            .map(|(id, _)| id.clone())
            .ok_or_else(|| TrackerError::NotFound(format!("no ClickUp workspace called '{wanted}'")))
    }

    /// One task, with its Markdown description when that is what is wanted.
    async fn task(&self, conn: &Connection, item: &WorkItem, markdown: bool) -> Result<Value, TrackerError> {
        let mut url = api_url(conn, &["task", task_id(item)?])?;
        if markdown {
            url.query_pairs_mut()
                .append_pair("include_markdown_description", "true");
        }
        call(conn, Method::GET, url, None).await
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

    /// The connection every test here drives, pointed at the stand-in.
    fn connection(service: &FakeService, workspace: &str) -> Connection {
        let mut settings = Settings::new();
        settings.insert("workspace".into(), workspace.into());
        settings.insert("apiBase".into(), service.base.clone());
        Connection {
            settings,
            token: "pk_12345_TOKEN".into(),
        }
    }

    /// One comment as ClickUp answers it: the words are in `comment_text`, and the
    /// date is a string of milliseconds.
    const COMMENTS: &str = r#"{"comments":[
        {"id":"457","comment_text":"Reproduced on Firefox as well.",
         "user":{"id":183,"username":"Mai"},"date":"1755500000000"}]}"#;

    fn item(id: &str, state: &str) -> WorkItem {
        WorkItem {
            id: id.into(),
            title: "Whatever".into(),
            item_type: "Task".into(),
            state: state.into(),
            category: StateCategory::InProgress,
            web_url: String::new(),
            display_id: None,
            parent: None,
            dimensions: Vec::new(),
            scope: None,
        }
    }

    const USER: &str = r#"{"user":{"id":183,"username":"Linh","email":"linh@example.com"}}"#;
    const TEAMS: &str =
        r##"{"teams":[{"id":"9007","name":"IODM","color":"#000","avatar":null,"members":[]}]}"##;

    /// Three statuses across the flow, in the shape ClickUp's own document gives:
    /// the first is `open`, anything in between is `custom`, the last is `closed`.
    const TASKS: &str = r##"{"tasks":[
        {"id":"86a1b2c4","custom_id":null,"name":"Write the release note","date_updated":"1755500000000",
         "status":{"id":"p0","status":"to do","color":"#d3d3d3","orderindex":0,"type":"open"},
         "url":"https://app.clickup.com/t/86a1b2c4","list":{"id":"901","name":"Sprint 4"}},
        {"id":"86a1b2c3","custom_id":"DEV-123","name":"Ship the login screen","date_updated":"1755599999000",
         "status":{"id":"p1","status":"in progress","color":"#d3d3d3","orderindex":1,"type":"custom"},
         "url":"https://app.clickup.com/t/86a1b2c3","list":{"id":"901","name":"Sprint 4"}},
        {"id":"86a1b2c5","custom_id":null,"name":"Old thing","date_updated":"1750000000000",
         "status":{"id":"p9","status":"complete","color":"#6bc950","orderindex":9,"type":"closed"},
         "url":"https://app.clickup.com/t/86a1b2c5","list":{"id":"901","name":"Sprint 4"}}]}"##;

    const LIST: &str = r#"{"id":"901","name":"Sprint 4","statuses":[
        {"id":"p0","status":"to do","orderindex":0,"type":"open"},
        {"id":"p1","status":"in progress","orderindex":1,"type":"custom"},
        {"id":"p9","status":"complete","orderindex":9,"type":"closed"}]}"#;

    /// One task on its own, which is what `/task/{id}` answers - and the only
    /// place the task's list appears, which is what the status menu needs.
    const ONE_TASK: &str = r##"{"id":"86a1b2c3","name":"Ship the login screen",
        "status":{"id":"p1","status":"in progress","color":"#d3d3d3","orderindex":1,"type":"custom"},
        "url":"https://app.clickup.com/t/86a1b2c3","list":{"id":"901","name":"Sprint 4"}}"##;

    /// Answers what a refresh and a status menu ask for. `/team/{id}/task` and
    /// `/task/{id}` are different endpoints answering different shapes, so the
    /// routing here tells them apart the way the service does.
    fn clickup_service() -> FakeService {
        FakeService::start(|request| {
            if request.target.contains("/user") {
                json_response(USER)
            } else if request.target.ends_with("/team") {
                json_response(TEAMS)
            } else if request.target.contains("/list/") {
                json_response(LIST)
            } else if request.target.contains("/team/") {
                json_response(TASKS)
            } else {
                json_response(ONE_TASK)
            }
        })
    }

    #[tokio::test]
    async fn a_refresh_asks_for_this_person_s_work_and_normalizes_it() {
        let service = clickup_service();
        let items = ClickUp
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect("the list");

        // The closed one is finished work nobody asked for, and the fixture
        // arrives out of order on purpose: the order on screen is decided here,
        // not hoped for from the query.
        assert_eq!(
            items.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(),
            ["86a1b2c3", "86a1b2c4"],
            "tasks must be sorted by when they were last touched, newest first"
        );
        assert_eq!(
            items[0].display_id.as_deref(),
            Some("DEV-123"),
            "a workspace with custom task ids must see the id its team says out loud"
        );
        assert_eq!(
            items[1].display_id, None,
            "a task without one keeps nothing to display but its own id"
        );
        assert_eq!(items[0].title, "Ship the login screen");
        assert_eq!(
            items[0].state, "in progress",
            "the workspace's own status name is kept"
        );
        assert_eq!(
            items[0].category,
            StateCategory::InProgress,
            "'custom' is work in flight"
        );
        assert_eq!(
            items[1].category,
            StateCategory::Todo,
            "the first status is 'open'"
        );
        assert_eq!(
            items[0].web_url, "https://app.clickup.com/t/86a1b2c3",
            "the task carries its own address, so none is built"
        );

        // Measured: a personal token is the whole header, with no scheme.
        let tasks = service.request_for("/task");
        assert_eq!(tasks.authorization, "pk_12345_TOKEN");
        // The workspace was not given, so the only one was found and used.
        assert!(
            tasks.target.contains("/team/9007/task"),
            "the single workspace was not resolved: {}",
            tasks.target
        );
        assert!(
            tasks.target.contains("assignees%5B%5D=183"),
            "the query must ask for this person's work: {}",
            tasks.target
        );
        assert!(tasks.target.contains("include_closed=false"), "{}", tasks.target);
    }

    #[tokio::test]
    async fn a_full_page_is_followed_by_the_next_one() {
        let service = FakeService::start(|request| {
            if request.target.contains("/user") {
                return json_response(USER);
            }
            if request.target.ends_with("/team") {
                return json_response(TEAMS);
            }
            // A page that is full means there may be more; a short one ends it.
            let full = request.target.contains("page=0");
            let count = if full { PAGE_SIZE } else { 1 };
            let tasks: Vec<String> = (0..count)
                .map(|index| {
                    format!(
                        r#"{{"id":"task-{page}-{index}","custom_id":null,"name":"Task {index}",
                            "date_updated":"{stamp}",
                            "status":{{"status":"to do","type":"open"}},
                            "url":"https://app.clickup.com/t/task-{page}-{index}"}}"#,
                        page = if full { 0 } else { 1 },
                        stamp = 1_700_000_000_000_u64 + index as u64,
                    )
                })
                .collect();
            json_response(&format!(r#"{{"tasks":[{}]}}"#, tasks.join(",")))
        });

        let items = ClickUp
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect("the list");

        assert_eq!(
            items.len(),
            PAGE_SIZE + 1,
            "a full page must be followed up, or the rest of the board is invisible"
        );
        let pages: Vec<String> = service
            .requests()
            .into_iter()
            .filter(|seen| seen.target.contains("/task"))
            .filter_map(|seen| {
                seen.target
                    .split("page=")
                    .nth(1)
                    .map(|tail| tail.chars().take_while(char::is_ascii_digit).collect())
            })
            .collect();
        assert_eq!(pages, ["0", "1"], "the short page must end the walk: {pages:?}");
    }

    #[tokio::test]
    async fn asking_for_finished_work_asks_the_service_for_it_too() {
        let service = clickup_service();
        let items = ClickUp
            .work_items(&connection(&service, ""), MINE_AND_DONE)
            .await
            .expect("the list");

        assert_eq!(items.len(), 3, "'include finished' must keep the closed task");
        assert!(service
            .request_for("/task")
            .target
            .contains("include_closed=true"));
    }

    #[tokio::test]
    async fn a_workspace_named_in_the_form_is_looked_up_by_name() {
        let service = clickup_service();
        ClickUp
            .work_items(&connection(&service, "iodm"), MINE)
            .await
            .expect("the list");
        assert!(
            service.request_for("/task").target.contains("/team/9007/task"),
            "a name typed in any case must find its workspace"
        );

        // A name nobody has is a mistake worth naming, not an empty panel.
        let error = ClickUp
            .work_items(&connection(&service, "Nope"), MINE)
            .await
            .expect_err("an unknown workspace is a failure")
            .to_string();
        assert!(error.starts_with("TRACKER_NOT_FOUND::"), "{error}");
        assert!(error.contains("'Nope'"), "{error}");
    }

    #[tokio::test]
    async fn several_workspaces_and_no_choice_is_asked_about_rather_than_guessed() {
        let service = FakeService::start(|request| {
            if request.target.contains("/user") {
                return json_response(USER);
            }
            json_response(r#"{"teams":[{"id":"1","name":"IODM"},{"id":"2","name":"Side project"}]}"#)
        });

        let error = ClickUp
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect_err("picking one of two workspaces is not Aime's decision")
            .to_string();
        assert!(error.starts_with("TRACKER_CONFIG::"), "{error}");
        assert!(
            error.contains("IODM") && error.contains("Side project"),
            "the message must name what to choose between: {error}"
        );
    }

    #[tokio::test]
    async fn a_missing_credential_is_a_credential_problem_even_at_status_400() {
        // Measured on the real API: no Authorization header answers 400, not 401.
        let service = FakeService::start(|_| {
            response(
                "400 Bad Request",
                "application/json",
                r#"{"err":"Authorization header required","ECODE":"OAUTH_017"}"#,
            )
        });

        let error = ClickUp
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect_err("a refused request is not an empty board")
            .to_string();
        assert!(
            error.starts_with("TRACKER_AUTH::"),
            "a 400 carrying an OAUTH code is still about the token: {error}"
        );
        assert!(
            error.contains("OAUTH_017"),
            "the code ClickUp support asks for is kept: {error}"
        );
    }

    #[tokio::test]
    async fn a_wrong_token_is_reported_as_one() {
        let service = FakeService::start(|_| {
            response(
                "401 Unauthorized",
                "application/json",
                r#"{"err":"Token invalid","ECODE":"OAUTH_025"}"#,
            )
        });

        let error = ClickUp
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect_err("a rejected token is a failure")
            .to_string();
        assert!(error.starts_with("TRACKER_AUTH::"), "{error}");
        assert!(error.contains("Token invalid (OAUTH_025)"), "{error}");
    }

    #[tokio::test]
    async fn the_states_offered_are_the_ones_this_task_s_list_defines() {
        let service = clickup_service();
        let states = ClickUp
            .states(&connection(&service, ""), &item("86a1b2c3", "in progress"))
            .await
            .expect("the states");

        assert_eq!(
            states
                .iter()
                .map(|state| (state.name.as_str(), state.category))
                .collect::<Vec<_>>(),
            [
                ("to do", StateCategory::Todo),
                ("in progress", StateCategory::InProgress),
                ("complete", StateCategory::Done),
            ],
            "a ClickUp status belongs to a list, and the whole list is what can be picked"
        );
        // The task is read first only to learn which list it is in.
        assert!(service.request_for("/list/901").target.contains("/list/901"));
    }

    #[tokio::test]
    async fn a_move_sends_the_status_by_name_and_keeps_the_answer() {
        let service = FakeService::start(|request| {
            if request.method == "PUT" {
                return json_response(
                    r#"{"id":"86a1b2c3","name":"Ship the login screen",
                        "status":{"status":"complete","type":"closed"},
                        "url":"https://app.clickup.com/t/86a1b2c3"}"#,
                );
            }
            json_response("{}")
        });

        let moved = ClickUp
            .set_state(
                &connection(&service, ""),
                &item("86a1b2c3", "in progress"),
                "complete",
            )
            .await
            .expect("the move");

        assert_eq!(moved.state, "complete");
        assert_eq!(
            moved.category,
            StateCategory::Done,
            "the update answers with the task, so nothing has to be read back"
        );
        let update = service.request_for("/task/86a1b2c3");
        assert_eq!(update.method, "PUT");
        assert_eq!(update.body, r#"{"status":"complete"}"#);
    }

    #[tokio::test]
    async fn a_description_is_asked_for_as_markdown_because_that_is_already_text() {
        let service = FakeService::start(|_| {
            json_response(
                // Three hashes: this fixture contains `"##` (the Markdown
                // heading), which would close a shorter raw string.
                r###"{"id":"86a1b2c3","name":"Ship the login screen",
                    "status":{"status":"in progress","type":"custom"},
                    "url":"https://app.clickup.com/t/86a1b2c3",
                    "description":"plain fallback",
                    "markdown_description":"## Steps\n1. Open the app"}"###,
            )
        });

        let detail = ClickUp
            .item_detail(&connection(&service, ""), &item("86a1b2c3", "in progress"))
            .await
            .expect("the detail");

        assert_eq!(detail.description, "## Steps\n1. Open the app");
        assert!(
            service
                .request_for("/task/86a1b2c3")
                .target
                .contains("include_markdown_description=true"),
            "without asking, the description arrives as ClickUp's own rendering"
        );
    }

    #[tokio::test]
    async fn a_task_written_before_markdown_existed_still_reads() {
        let service = FakeService::start(|_| {
            json_response(
                r#"{"id":"86a1b2c3","name":"Old task","status":{"status":"to do","type":"open"},
                    "url":"https://app.clickup.com/t/86a1b2c3","description":"plain fallback",
                    "markdown_description":""}"#,
            )
        });

        let detail = ClickUp
            .item_detail(&connection(&service, ""), &item("86a1b2c3", "to do"))
            .await
            .expect("the detail");
        assert_eq!(detail.description, "plain fallback");
    }

    #[test]
    fn every_status_type_clickup_has_maps_to_one_of_ours() {
        assert_eq!(category_of("open"), StateCategory::Todo);
        assert_eq!(category_of("custom"), StateCategory::InProgress);
        assert_eq!(category_of("done"), StateCategory::Done);
        assert_eq!(category_of("closed"), StateCategory::Done);
        assert_eq!(
            category_of("something-new"),
            StateCategory::Unknown,
            "a type Aime does not know is not a guess worth making"
        );
    }

    #[test]
    fn a_task_id_that_could_walk_out_of_its_path_is_refused() {
        assert!(task_id(&item("86a1b2c3", "to do")).is_ok());
        assert!(task_id(&item("86a1b2c3/../../team", "to do")).is_err());
        assert!(task_id(&item("86a1 b2c3", "to do")).is_err());
        assert!(task_id(&item("", "to do")).is_err());
        // Measured: the URL crate resolves these away rather than encoding them,
        // so `/task/..` would become `/task` - a different endpoint entirely.
        assert!(task_id(&item("..", "to do")).is_err());
        assert!(task_id(&item(".", "to do")).is_err());
    }

    #[test]
    fn a_workspace_is_part_of_what_identifies_the_connection() {
        let mut settings = Settings::new();
        assert_eq!(
            ClickUp.connection_id(&settings),
            "clickup",
            "the whole account is one connection when no workspace was named"
        );
        assert_eq!(ClickUp.connection_label(&settings), "ClickUp");

        settings.insert("workspace".into(), " IODM ".into());
        assert_eq!(ClickUp.connection_id(&settings), "clickup:iodm");
        assert_eq!(ClickUp.connection_label(&settings), "ClickUp / IODM");
    }

    /// The conversation, both ways.
    ///
    /// The half that can only be wrong at runtime is the answer to a new comment:
    /// ClickUp replies with an id and a date and no text at all, so the panel has
    /// to keep the words it just sent.
    #[tokio::test]
    async fn the_conversation_is_read_and_a_new_comment_survives_an_answer_without_words() {
        let service = FakeService::start(|request| {
            if request.method == "POST" {
                // Measured shape of ClickUp's answer to a new comment.
                json_response(r#"{"id":"458","hist_id":"26508","date":1755600000000}"#)
            } else {
                json_response(COMMENTS)
            }
        });
        let conn = connection(&service, "IODM");
        let subject = item("86a1b2c3", "in progress");

        let thread = ClickUp.comments(&conn, &subject).await.expect("the comments");
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].author, "Mai");
        assert_eq!(thread[0].text, "Reproduced on Firefox as well.");
        assert!(
            service
                .request_for("comment")
                .target
                .contains("/task/86a1b2c3/comment"),
            "the conversation lives on the task: {}",
            service.request_for("comment").target
        );

        let posted = ClickUp
            .add_comment(&conn, &subject, "Fixed on the branch.")
            .await
            .expect("the new comment");
        assert_eq!(
            posted.text, "Fixed on the branch.",
            "the words sent are the words to show when the service echoes none"
        );

        let sent = service
            .requests()
            .into_iter()
            .find(|seen| seen.method == "POST")
            .expect("the comment was never sent");
        assert_eq!(
            sent.body, r#"{"comment_text":"Fixed on the branch.","notify_all":false}"#,
            "a comment from an editor must not mail the whole workspace"
        );
    }
}
