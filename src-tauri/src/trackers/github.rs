//! GitHub issues, over the REST API.
//!
//! Measured against `api.github.com` on 2026-08-18 (public repositories answer
//! anonymously, so the shapes below are real ones):
//!
//! 1. **`/issues` hands back pull requests too.** The first item of
//!    `rust-lang/rust` was a PR: same shape, plus a `pull_request` object, and an
//!    `html_url` under `/pull/`. A board that lists them is a board nobody asked
//!    for, so anything carrying that key is skipped.
//! 2. **A collection is a bare JSON array**, not an envelope - unlike every other
//!    service here - and paging is `?page=`, counted from one.
//! 3. **An issue's state is `open`/`closed` plus a `state_reason`**, and the
//!    reasons that actually arrive include `completed` *and* `duplicate` (not only
//!    the documented `not_planned`). So closing is not one move but two kinds of
//!    move, and the menu says which: work that got done, and work that will not
//!    be done.
//! 4. **The body is Markdown**, which is text already: nothing to strip, the same
//!    as ClickUp and unlike Jira or Azure DevOps.
//! 5. Refusals are plain JSON with a `message`: `Requires authentication` with no
//!    credential, `Bad credentials` with a wrong one - both `401`.
//!
//! The API URL is a field because GitHub Enterprise Server exists: it answers the
//! same API under a company host at `/api/v3`.

use async_trait::async_trait;
use reqwest::{Method, Url};
use serde_json::{json, Value};

use super::connector::{
    Comment, Connection, ConnectionField, Connector, Fact, Settings, StateCategory, StateOption,
    TrackerError, WorkItem, WorkItemDetail, WorkItemQuery, MAX_WORK_ITEMS,
};
use super::http::client;

pub struct GitHub;

const DEFAULT_API: &str = "https://api.github.com";

/// The most a page holds on this API.
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = MAX_WORK_ITEMS.div_ceil(PAGE_SIZE);

/// What Aime shows as an issue's state, in GitHub's own words. The reason is part
/// of it because "closed" alone loses the difference between finished and
/// abandoned - the same difference Azure DevOps draws with a Removed category.
const OPEN: &str = "Open";
const CLOSED: &str = "Closed";
const NOT_PLANNED: &str = "Closed as not planned";

const CONNECT_FIELDS: [ConnectionField; 2] = [
    ConnectionField {
        // Optional: with nothing here the panel lists what is assigned to you
        // everywhere this token can see, which is what `/issues` answers.
        name: "repository",
        placeholder: "owner/name",
        optional: true,
    },
    ConnectionField {
        // GitHub Enterprise Server answers the same API under a company host.
        name: "apiUrl",
        placeholder: DEFAULT_API,
        optional: true,
    },
];

// ---------------------------------------------------------------- HTTP

fn api_url(conn: &Connection, tail: &[&str]) -> Result<Url, TrackerError> {
    let base = match conn.setting("apiUrl").trim() {
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
        .bearer_auth(conn.token.trim())
        // Asking for a version keeps a future change to the API from arriving
        // unannounced, which is what GitHub asks clients to do.
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json");
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
            message: format!("the answer was not the JSON it claimed to be: {e}"),
        });
    }
    let message = api_message(&text);
    Err(match status.as_u16() {
        401 => TrackerError::Auth(message),
        // A token without the right scope, and a rate limit, are both 403 here;
        // the message is the half that tells them apart.
        403 => TrackerError::Auth(message),
        404 => TrackerError::NotFound(message),
        other => TrackerError::Api {
            status: other,
            message,
        },
    })
}

/// GitHub says what went wrong in `message`, always as JSON.
fn api_message(body: &str) -> String {
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(body) {
        if let Some(message) = map.get("message").and_then(Value::as_str) {
            return message.to_string();
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

/// One issue, addressed the way this connector addresses it: `owner/name#number`.
struct IssueRef {
    owner: String,
    repository: String,
    number: u64,
}

impl IssueRef {
    /// Read out of the item id the panel hands back.
    fn parse(id: &str) -> Result<Self, TrackerError> {
        let refused = || TrackerError::Config(format!("'{id}' is not an issue"));
        let (path, number) = id.split_once('#').ok_or_else(refused)?;
        let (owner, repository) = path.split_once('/').ok_or_else(refused)?;
        let number: u64 = number.parse().map_err(|_| refused())?;
        if owner.is_empty() || repository.is_empty() || repository.contains('/') {
            return Err(refused());
        }
        Ok(Self {
            owner: owner.to_string(),
            repository: repository.to_string(),
            number,
        })
    }

    /// Read out of an issue's own web address, which every answer carries:
    /// `https://github.com/owner/name/issues/7`.
    fn from_web_url(html_url: &str) -> Option<Self> {
        let url = Url::parse(html_url).ok()?;
        let segments: Vec<&str> = url.path_segments()?.collect();
        let [owner, repository, _, number] = segments[..] else {
            return None;
        };
        Some(Self {
            owner: owner.to_string(),
            repository: repository.to_string(),
            number: number.parse().ok()?,
        })
    }

    fn id(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repository, self.number)
    }

    /// What a person says: the repository nobody needs the owner of, and the
    /// number they would type.
    fn display(&self) -> String {
        format!("{}#{}", self.repository, self.number)
    }

    /// The path as segments. Owner and repository are two of them: pushed as one
    /// string, the slash between them is percent-encoded (`iodm%2Fportal`) and
    /// the request 404s.
    fn api_path(&self) -> [String; 4] {
        [
            self.owner.clone(),
            self.repository.clone(),
            "issues".into(),
            self.number.to_string(),
        ]
    }
}

/// GitHub's state and reason, as one name and one category. `duplicate` and
/// `not_planned` are both work that will not be done, which is what Removed says.
fn state_of(issue: &Value) -> (String, StateCategory) {
    let closed = issue.get("state").and_then(Value::as_str) == Some("closed");
    if !closed {
        return (OPEN.into(), StateCategory::Todo);
    }
    match issue.get("state_reason").and_then(Value::as_str) {
        Some("not_planned" | "duplicate") => (NOT_PLANNED.into(), StateCategory::Removed),
        _ => (CLOSED.into(), StateCategory::Done),
    }
}

/// One issue as the UI knows it, or nothing when it is really a pull request or
/// carries no address to work from.
fn work_item_from(issue: &Value) -> Option<WorkItem> {
    if issue.get("pull_request").is_some() {
        return None;
    }
    let html_url = issue.get("html_url").and_then(Value::as_str)?;
    let reference = IssueRef::from_web_url(html_url)?;
    let (state, category) = state_of(issue);
    Some(WorkItem {
        id: reference.id(),
        display_id: Some(reference.display()),
        title: issue
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        item_type: "Issue".into(),
        state,
        category,
        web_url: html_url.to_string(),
        // Measured: an issue payload carries `sub_issues_summary` (how many
        // children it has) but nothing about its own parent, so nesting here
        // would cost one request per parent. Left out rather than half-done.
        parent: None,
        // A repository is the board; a milestone is how GitHub says "phase".
        dimensions: [
            Some(Fact {
                label: "Repository".into(),
                value: reference.repository.clone(),
            }),
            issue
                .get("milestone")
                .and_then(|milestone| milestone.get("title"))
                .and_then(Value::as_str)
                .map(|title| Fact {
                    label: "Milestone".into(),
                    value: title.to_string(),
                }),
        ]
        .into_iter()
        .flatten()
        .collect(),
        // The repository an issue belongs to already travels as a dimension and
        // inside its own URL, so there is nothing extra to carry.
        scope: None,
    })
}

/// The short facts of one issue, in GitHub's own words.
fn facts_of(issue: &Value) -> Vec<Fact> {
    let names = |field: &str, key: &str| {
        issue
            .get(field)
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|entry| entry.get(key)?.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default()
    };
    [
        ("Assignees", names("assignees", "login")),
        ("Labels", names("labels", "name")),
        (
            "Comments",
            issue
                .get("comments")
                .and_then(Value::as_u64)
                .map(|count| count.to_string())
                .unwrap_or_default(),
        ),
        (
            "Updated",
            issue
                .get("updated_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    ]
    .into_iter()
    .filter(|(_, value)| !value.is_empty())
    .map(|(label, value)| Fact {
        label: label.into(),
        value,
    })
    .collect()
}

/// One comment. The body is Markdown, which is text already.
fn comment_from(comment: &Value) -> Comment {
    Comment {
        author: comment
            .get("user")
            .and_then(|user| user.get("login"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        when: comment
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        text: comment
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

/// The move behind a state name: what to write, and why.
fn update_for(state: &str) -> Option<Value> {
    match state {
        OPEN => Some(json!({ "state": "open" })),
        CLOSED => Some(json!({ "state": "closed", "state_reason": "completed" })),
        NOT_PLANNED => Some(json!({ "state": "closed", "state_reason": "not_planned" })),
        _ => None,
    }
}

// --------------------------------------------------------------- connector

#[async_trait]
impl Connector for GitHub {
    fn kind(&self) -> &'static str {
        "github"
    }

    fn label(&self) -> &'static str {
        "GitHub"
    }

    fn fields(&self) -> &'static [ConnectionField] {
        &CONNECT_FIELDS
    }

    fn secret_label(&self) -> &'static str {
        "Personal access token"
    }

    fn secret_help_url(&self) -> &'static str {
        "https://github.com/settings/tokens"
    }

    fn connection_id(&self, settings: &Settings) -> String {
        let repository = settings
            .get("repository")
            .map_or("", String::as_str)
            .trim()
            .to_lowercase();
        match repository.as_str() {
            "" => "github".into(),
            named => format!("github:{named}"),
        }
    }

    fn connection_label(&self, settings: &Settings) -> String {
        match settings.get("repository").map_or("", String::as_str).trim() {
            "" => "GitHub".into(),
            named => format!("GitHub / {named}"),
        }
    }

    async fn work_items(
        &self,
        conn: &Connection,
        asked: WorkItemQuery,
    ) -> Result<Vec<WorkItem>, TrackerError> {
        let repository = conn.setting("repository").trim().to_string();
        // One repository is asked with the login it belongs to; everything this
        // token can see is asked with a filter instead. Neither is needed to list
        // what everyone is working on.
        let login = if repository.is_empty() || !asked.mine_only {
            String::new()
        } else {
            self.login(conn).await?
        };

        let mut items: Vec<WorkItem> = Vec::new();
        for page in 1..=MAX_PAGES {
            let mut url = match repository.split_once('/') {
                None if repository.is_empty() => api_url(conn, &["issues"])?,
                None => {
                    return Err(TrackerError::Config(format!(
                        "'{repository}' is not a repository - it reads owner/name"
                    )))
                }
                Some((owner, name)) => api_url(conn, &["repos", owner, name, "issues"])?,
            };
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("state", if asked.include_finished { "all" } else { "open" })
                    .append_pair("per_page", &PAGE_SIZE.to_string())
                    .append_pair("page", &page.to_string())
                    // Said out loud rather than left to the default, because the
                    // panel promises the most recently touched work.
                    .append_pair("sort", "updated")
                    .append_pair("direction", "desc");
                if repository.is_empty() {
                    // Documented values include `assigned` and `all`; `all` is
                    // every issue in the repositories this token can see.
                    query.append_pair("filter", if asked.mine_only { "assigned" } else { "all" });
                } else if asked.mine_only {
                    query.append_pair("assignee", &login);
                }
            }

            let body = call(conn, Method::GET, url, None).await?;
            let page_items = body.as_array().map_or(0, Vec::len);
            items.extend(
                body.as_array()
                    .map(|issues| issues.iter().filter_map(work_item_from))
                    .into_iter()
                    .flatten(),
            );
            if page_items < PAGE_SIZE {
                break;
            }
        }
        items.truncate(MAX_WORK_ITEMS);
        Ok(items)
    }

    async fn item_detail(&self, conn: &Connection, item: &WorkItem) -> Result<WorkItemDetail, TrackerError> {
        let issue = self.issue(conn, item, Method::GET, None).await?;
        Ok(WorkItemDetail {
            // Markdown is text already.
            description: issue
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            facts: facts_of(&issue),
        })
    }

    /// An issue has the states GitHub gives every issue - no request needed, and
    /// nothing about this repository can change them.
    async fn states(&self, _conn: &Connection, _item: &WorkItem) -> Result<Vec<StateOption>, TrackerError> {
        Ok(vec![
            StateOption {
                name: OPEN.into(),
                category: StateCategory::Todo,
            },
            StateOption {
                name: CLOSED.into(),
                category: StateCategory::Done,
            },
            StateOption {
                name: NOT_PLANNED.into(),
                category: StateCategory::Removed,
            },
        ])
    }

    async fn comments(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<Comment>, TrackerError> {
        let body = call(conn, Method::GET, self.comments_url(conn, item)?, None).await?;
        Ok(body
            .as_array()
            .map(|comments| comments.iter().map(comment_from).collect())
            .unwrap_or_default())
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
            Some(json!({ "body": text })),
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
        let update =
            update_for(state).ok_or_else(|| TrackerError::Config(format!("an issue cannot be '{state}'")))?;
        let updated = self.issue(conn, item, Method::PATCH, Some(update)).await?;
        work_item_from(&updated).ok_or_else(|| TrackerError::Api {
            status: 200,
            message: format!("issue {} came back as something else", item.id),
        })
    }
}

impl GitHub {
    /// Where one issue's conversation lives.
    fn comments_url(&self, conn: &Connection, item: &WorkItem) -> Result<Url, TrackerError> {
        let reference = IssueRef::parse(&item.id)?;
        let path = reference.api_path();
        let mut tail: Vec<&str> = vec!["repos"];
        tail.extend(path.iter().map(String::as_str));
        tail.push("comments");
        api_url(conn, &tail)
    }

    /// Who this token belongs to, which is what "assigned to me" means inside one
    /// repository. Read per refresh: a replaced token is a different person.
    async fn login(&self, conn: &Connection) -> Result<String, TrackerError> {
        let body = call(conn, Method::GET, api_url(conn, &["user"])?, None).await?;
        body.get("login")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| TrackerError::Auth("GitHub did not say who this token belongs to".into()))
    }

    /// One request against one issue, addressed from the id the panel handed back.
    async fn issue(
        &self,
        conn: &Connection,
        item: &WorkItem,
        method: Method,
        body: Option<Value>,
    ) -> Result<Value, TrackerError> {
        let reference = IssueRef::parse(&item.id)?;
        let path = reference.api_path();
        let mut tail: Vec<&str> = vec!["repos"];
        tail.extend(path.iter().map(String::as_str));
        call(conn, method, api_url(conn, &tail)?, body).await
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

    fn connection(service: &FakeService, repository: &str) -> Connection {
        let mut settings = Settings::new();
        settings.insert("repository".into(), repository.into());
        settings.insert("apiUrl".into(), service.base.clone());
        Connection {
            settings,
            token: "ghp_token".into(),
        }
    }

    /// A conversation as GitHub answers one: an array, not an object.
    const COMMENTS: &str = r#"[
        {"id":8,"body":"Reproduced on Firefox as well.","user":{"login":"mai"},
         "created_at":"2026-08-17T09:00:00Z"}]"#;

    fn item(id: &str, state: &str) -> WorkItem {
        WorkItem {
            id: id.into(),
            display_id: None,
            title: "Whatever".into(),
            item_type: "Issue".into(),
            state: state.into(),
            category: StateCategory::Todo,
            web_url: String::new(),
            parent: None,
            dimensions: Vec::new(),
            scope: None,
        }
    }

    /// The shape `api.github.com` really answers with, including the pull request
    /// that arrives inside an issue list and the two kinds of closing.
    const ISSUES: &str = r#"[
        {"number":161000,"title":"Encode OpenBSD version in target_env","state":"open","state_reason":null,
         "html_url":"https://github.com/rust-lang/rust/issues/161000",
         "url":"https://api.github.com/repos/rust-lang/rust/issues/161000"},
        {"number":161284,"title":"Rollup of 4 pull requests","state":"open",
         "html_url":"https://github.com/rust-lang/rust/pull/161284",
         "pull_request":{"url":"https://api.github.com/repos/rust-lang/rust/pulls/161284"}},
        {"number":161267,"title":"Done thing","state":"closed","state_reason":"completed",
         "html_url":"https://github.com/rust-lang/rust/issues/161267"},
        {"number":161265,"title":"Duplicate thing","state":"closed","state_reason":"duplicate",
         "html_url":"https://github.com/rust-lang/rust/issues/161265"}]"#;

    #[tokio::test]
    async fn a_refresh_lists_issues_and_leaves_pull_requests_out_of_it() {
        let service = FakeService::start(|_| json_response(ISSUES));
        let items = GitHub
            .work_items(&connection(&service, ""), MINE_AND_DONE)
            .await
            .expect("the list");

        assert_eq!(
            items.iter().map(|issue| issue.id.as_str()).collect::<Vec<_>>(),
            [
                "rust-lang/rust#161000",
                "rust-lang/rust#161267",
                "rust-lang/rust#161265"
            ],
            "a pull request is not an issue, however much the endpoint mixes them"
        );
        assert_eq!(
            items[0].display_id.as_deref(),
            Some("rust#161000"),
            "a row says what a person says: the repository and the number"
        );
        assert_eq!(items[0].state, "Open");
        assert_eq!(items[0].category, StateCategory::Todo);
        assert_eq!(items[1].state, "Closed");
        assert_eq!(items[1].category, StateCategory::Done);
        assert_eq!(
            items[2].state, "Closed as not planned",
            "a duplicate is work that will not be done, not work that was done"
        );
        assert_eq!(items[2].category, StateCategory::Removed);
        assert_eq!(
            items[0].web_url,
            "https://github.com/rust-lang/rust/issues/161000"
        );

        let listed = service.request_for("/issues");
        assert_eq!(listed.authorization, "Bearer ghp_token");
        assert!(
            listed.target.contains("filter=assigned") && listed.target.contains("state=all"),
            "with no repository named, the whole account is asked: {}",
            listed.target
        );
        assert!(
            listed.target.contains("sort=updated") && listed.target.contains("direction=desc"),
            "the panel promises the most recently touched work: {}",
            listed.target
        );
    }

    #[tokio::test]
    async fn open_work_is_what_is_asked_for_unless_finished_work_was_wanted() {
        let service = FakeService::start(|_| json_response("[]"));
        GitHub
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect("the list");
        assert!(service.request_for("/issues").target.contains("state=open"));
    }

    #[tokio::test]
    async fn one_repository_is_asked_with_the_login_the_token_belongs_to() {
        let service = FakeService::start(|request| {
            if request.target.ends_with("/user") {
                return json_response(r#"{"login":"linhpham","id":1}"#);
            }
            json_response(ISSUES)
        });

        GitHub
            .work_items(&connection(&service, "iodm/portal"), MINE)
            .await
            .expect("the list");

        let listed = service.request_for("/repos/");
        assert!(
            listed.target.starts_with("/repos/iodm/portal/issues"),
            "the repository named in the form is the one asked: {}",
            listed.target
        );
        assert!(
            listed.target.contains("assignee=linhpham"),
            "'assigned to me' inside one repository needs a name: {}",
            listed.target
        );
    }

    #[tokio::test]
    async fn a_full_page_is_followed_by_the_next_one() {
        let service = FakeService::start(|request| {
            // `&` matters: `per_page=100` contains "page=1" too.
            let full = request.target.contains("&page=1");
            let count = if full { PAGE_SIZE } else { 2 };
            let issues: Vec<String> = (0..count)
                .map(|index| {
                    format!(
                        r#"{{"number":{n},"title":"Issue {n}","state":"open",
                            "html_url":"https://github.com/iodm/portal/issues/{n}"}}"#,
                        n = index + if full { 0 } else { 1000 }
                    )
                })
                .collect();
            json_response(&format!("[{}]", issues.join(",")))
        });

        let items = GitHub
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect("the list");

        assert_eq!(items.len(), PAGE_SIZE + 2, "the second page was never asked for");
        let pages: Vec<String> = service
            .requests()
            .into_iter()
            .filter_map(|seen| {
                // `&page=`, not `page=`: `per_page=100` would answer first.
                seen.target
                    .split("&page=")
                    .nth(1)
                    .map(|tail| tail.chars().take_while(char::is_ascii_digit).collect())
            })
            .collect();
        assert_eq!(pages, ["1", "2"], "GitHub counts pages from one: {pages:?}");
    }

    #[tokio::test]
    async fn a_wrong_token_is_reported_in_github_s_own_words() {
        let service = FakeService::start(|_| {
            response(
                "401 Unauthorized",
                "application/json",
                r#"{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}"#,
            )
        });

        let error = GitHub
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect_err("a refusal is not an empty board")
            .to_string();
        assert_eq!(error, "TRACKER_AUTH::Bad credentials");
    }

    #[tokio::test]
    async fn a_token_without_the_scope_reads_as_a_credential_problem_too() {
        // 403 here is a scope or a rate limit, and both are about the credential
        // rather than about the board.
        let service = FakeService::start(|_| {
            response(
                "403 Forbidden",
                "application/json",
                r#"{"message":"API rate limit exceeded for user ID 1."}"#,
            )
        });

        let error = GitHub
            .work_items(&connection(&service, ""), MINE)
            .await
            .expect_err("a refusal is a failure")
            .to_string();
        assert!(error.starts_with("TRACKER_AUTH::"), "{error}");
        assert!(error.contains("rate limit"), "{error}");
    }

    #[tokio::test]
    async fn closing_an_issue_says_whether_the_work_was_done_or_dropped() {
        let service = FakeService::start(|request| {
            let reason = if request.body.contains("not_planned") {
                "not_planned"
            } else {
                "completed"
            };
            json_response(&format!(
                r#"{{"number":7,"title":"Whatever","state":"closed","state_reason":"{reason}",
                    "html_url":"https://github.com/iodm/portal/issues/7"}}"#
            ))
        });
        let conn = connection(&service, "iodm/portal");

        let done = GitHub
            .set_state(&conn, &item("iodm/portal#7", "Open"), "Closed")
            .await
            .expect("the move");
        assert_eq!(done.state, "Closed");
        assert_eq!(done.category, StateCategory::Done);

        let dropped = GitHub
            .set_state(&conn, &item("iodm/portal#7", "Open"), "Closed as not planned")
            .await
            .expect("the move");
        assert_eq!(dropped.category, StateCategory::Removed);

        let patch = service
            .requests()
            .into_iter()
            .find(|seen| seen.method == "PATCH")
            .expect("nothing was written");
        assert_eq!(patch.target, "/repos/iodm/portal/issues/7");
        assert_eq!(patch.body, r#"{"state":"closed","state_reason":"completed"}"#);
    }

    #[tokio::test]
    async fn a_state_github_does_not_have_is_refused_before_anything_is_sent() {
        let service = FakeService::start(|_| json_response("{}"));
        let error = GitHub
            .set_state(
                &connection(&service, ""),
                &item("iodm/portal#7", "Open"),
                "In progress",
            )
            .await
            .expect_err("an issue has two states, whatever a board calls them")
            .to_string();

        assert!(error.starts_with("TRACKER_CONFIG::"), "{error}");
        assert!(service.requests().is_empty(), "nothing may be written first");
    }

    #[tokio::test]
    async fn a_body_is_already_text_so_it_travels_as_it_is() {
        let service = FakeService::start(|_| {
            json_response(
                // Three hashes: the Markdown heading in the body contains `"##`,
                // which would close a shorter raw string.
                r###"{"number":7,"title":"Login fails","state":"open",
                    "html_url":"https://github.com/iodm/portal/issues/7",
                    "body":"## Steps\n1. Open /login\n2. Submit"}"###,
            )
        });

        let detail = GitHub
            .item_detail(&connection(&service, ""), &item("iodm/portal#7", "Open"))
            .await
            .expect("the detail");
        assert_eq!(detail.description, "## Steps\n1. Open /login\n2. Submit");
    }

    #[test]
    fn an_id_that_is_not_an_issue_is_refused_before_it_reaches_a_url() {
        assert!(IssueRef::parse("iodm/portal#7").is_ok());
        for bad in [
            "iodm/portal",
            "portal#7",
            "iodm/portal#seven",
            "iodm//portal#7",
            "../../admin#7",
            "",
        ] {
            assert!(
                IssueRef::parse(bad).is_err(),
                "'{bad}' must not become part of a URL"
            );
        }
    }

    #[test]
    fn an_issue_is_addressed_from_the_web_address_it_arrived_with() {
        let reference =
            IssueRef::from_web_url("https://github.com/rust-lang/rust/issues/161000").expect("an issue URL");
        assert_eq!(reference.id(), "rust-lang/rust#161000");
        assert_eq!(reference.display(), "rust#161000");
        assert_eq!(
            reference.api_path(),
            [
                "rust-lang".to_string(),
                "rust".to_string(),
                "issues".to_string(),
                "161000".to_string()
            ],
            "owner and name are separate segments, or the slash between them is encoded"
        );
        // Enterprise Server puts the same shape under a company host.
        assert_eq!(
            IssueRef::from_web_url("https://ghe.company.com/iodm/portal/issues/7")
                .expect("an enterprise URL")
                .id(),
            "iodm/portal#7"
        );
        assert!(IssueRef::from_web_url("https://github.com/rust-lang/rust").is_none());
    }

    #[test]
    fn a_repository_is_part_of_what_identifies_the_connection() {
        let mut settings = Settings::new();
        assert_eq!(GitHub.connection_id(&settings), "github");
        assert_eq!(GitHub.connection_label(&settings), "GitHub");

        settings.insert("repository".into(), " IODM/Portal ".into());
        assert_eq!(GitHub.connection_id(&settings), "github:iodm/portal");
        assert_eq!(GitHub.connection_label(&settings), "GitHub / IODM/Portal");
    }

    /// The conversation, both ways. GitHub answers a list of comments as a bare
    /// array rather than as an object with a field in it, which is the half that
    /// can only be wrong at runtime.
    #[tokio::test]
    async fn the_conversation_is_read_from_the_array_github_answers_with() {
        let service = FakeService::start(|request| {
            if request.method == "POST" {
                json_response(
                    r#"{"id":9,"body":"Fixed on the branch.","user":{"login":"linh"},
                        "created_at":"2026-08-18T10:00:00Z"}"#,
                )
            } else {
                json_response(COMMENTS)
            }
        });
        let conn = connection(&service, "iodm/portal");
        let subject = item("iodm/portal#7", "Open");

        let thread = GitHub.comments(&conn, &subject).await.expect("the comments");
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].author, "mai");
        assert_eq!(thread[0].text, "Reproduced on Firefox as well.");
        assert!(
            service
                .request_for("comments")
                .target
                .contains("/repos/iodm/portal/issues/7/comments"),
            "the owner and the repository are two path segments: {}",
            service.request_for("comments").target
        );

        let posted = GitHub
            .add_comment(&conn, &subject, "Fixed on the branch.")
            .await
            .expect("the new comment");
        assert_eq!(posted.text, "Fixed on the branch.");
        assert_eq!(posted.author, "linh");

        let sent = service
            .requests()
            .into_iter()
            .find(|seen| seen.method == "POST")
            .expect("the comment was never sent");
        assert_eq!(sent.body, r#"{"body":"Fixed on the branch."}"#);
    }
}
