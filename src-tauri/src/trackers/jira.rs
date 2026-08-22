//! Jira, in both of its deployments: Cloud (REST API v3) and Server / Data
//! Centre (v2). They are one file because everything about an issue is the same
//! on both, and two connectors because what a person must type, and what
//! authenticates them, is not (see [`Deployment`]).
//!
//! Measured against a real Cloud site and a real self-hosted one on 2026-08-18
//! (`hibernate.atlassian.net` and `jira.atlassian.com`, both of which allow
//! anonymous reads), plus Atlassian's own OpenAPI document for Cloud:
//!
//! 1. **A status carries its own category** on both: `statusCategory.key` is
//!    `new`, `indeterminate` or `done`, whatever the team named the status
//!    ("Gathering Interest", "Waiting for review"). So unlike Azure DevOps there
//!    is no process template to read first, and JQL filters on it directly.
//! 2. **Search differs.** Cloud is `POST /search/jql` (the older `/search` is
//!    deprecated in Atlassian's own document), answering
//!    `{issues, nextPageToken, isLast}`, and it **refuses an unbounded query** -
//!    `ORDER BY updated DESC` alone came back "Unbounded JQL queries are not
//!    allowed here". Self-hosted is `POST /search`, answering
//!    `{issues, startAt, maxResults, total}`: offset paging. Both are asked the
//!    same JQL, which always carries `assignee = currentUser()` - a restriction,
//!    and the reason a project is optional here.
//! 3. **The page is capped at 100** on Cloud: asking for 250 returned 100.
//! 4. **A status is changed by a transition, not by writing a field.** The
//!    transitions available *from this issue's current status* are what may be
//!    picked (`GET /issue/{key}/transitions`), and performing one answers `204`
//!    with no body - so the item is read back afterwards.
//! 5. **Neither deployment stores the description as text**: Cloud keeps ADF (a
//!    JSON document), self-hosted keeps wiki markup. Both answer
//!    `expand=renderedFields` with the same field as HTML, which
//!    [`super::rich_text`] already turns into Markdown.
//!
//! And they refuse a credential differently, which is why the message is read
//! out of two shapes: Cloud answers `401` with an HTML sentence, self-hosted
//! `401 application/xml` with the sentence inside a `<message>` element. A Cloud
//! site that does not exist answers `404` with an HTML page.

use async_trait::async_trait;
use reqwest::{Method, Url};
use serde_json::{json, Value};

use super::connector::{Comment, Fact, Parent};
use super::connector::{
    Connection, ConnectionField, Connector, Settings, StateCategory, StateOption, TrackerError, WorkItem,
    WorkItemDetail, WorkItemQuery, MAX_WORK_ITEMS,
};
use super::http::client;
use super::rich_text::html_to_markdown;

/// Which Jira is on the other end. The two are different products with the same
/// name: measured on 2026-08-18, a Cloud site answers `deploymentType: "Cloud"`
/// and `/rest/api/3`, while a self-hosted one answers `"Server"` and only has
/// `/rest/api/2`. The person picks - the service list is exactly that choice -
/// so nothing here has to guess from a probe that could be wrong.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Deployment {
    /// `*.atlassian.net`: `/rest/api/3`, email + API token, token-paged search.
    Cloud,
    /// Server or Data Center behind a company URL: `/rest/api/2`, a personal
    /// access token as a bearer, and `startAt`/`total` paging.
    SelfHosted,
}

pub struct Jira {
    pub deployment: Deployment,
}

/// What the service will return in one page, whatever is asked for (measured:
/// 250 requested, 100 returned). More than that is fetched by following the
/// continuation token, up to `MAX_WORK_ITEMS`.
const PAGE_SIZE: usize = 100;

/// How many pages that cap is worth. Counted rather than left to the token,
/// because "walk until the service says stop" trusts the service to advance: a
/// token handed back unchanged would turn one refresh into a hundred requests.
const MAX_PAGES: usize = MAX_WORK_ITEMS.div_ceil(PAGE_SIZE);

/// Fields a row needs. `status` brings its category along, which is what makes
/// a second request unnecessary.
/// `parent` brings its own summary along (measured on a real site), so a subtask
/// can say what it belongs to without a second request. `fixVersions` is how Jira
/// says "release", which is one of the ways teams file work.
const LIST_FIELDS: [&str; 5] = ["summary", "status", "issuetype", "parent", "fixVersions"];

/// Optional everywhere: `assignee = currentUser()` is already a bounded query,
/// so without a project the panel shows your work across the whole site.
const PROJECT_FIELD: ConnectionField = ConnectionField {
    name: "project",
    placeholder: "PROJ",
    optional: true,
};

const CLOUD_FIELDS: [ConnectionField; 3] = [
    ConnectionField {
        name: "site",
        placeholder: "your-team.atlassian.net",
        optional: false,
    },
    ConnectionField {
        // Cloud authenticates the *account*, so the API token needs the email it
        // belongs to. A self-hosted token authenticates on its own.
        name: "email",
        placeholder: "you@company.com",
        optional: false,
    },
    PROJECT_FIELD,
];

const SELF_HOSTED_FIELDS: [ConnectionField; 2] = [
    ConnectionField {
        name: "site",
        placeholder: "https://jira.company.com",
        optional: false,
    },
    PROJECT_FIELD,
];

// ---------------------------------------------------------------- HTTP

/// The site's REST root. A site is typed as a host far more often than as a URL,
/// so a bare host is accepted and completed rather than refused.
fn site_url(conn: &Connection) -> Result<Url, TrackerError> {
    let site = conn.required("site")?.trim_end_matches('/');
    let absolute = if site.contains("://") {
        site.to_string()
    } else {
        format!("https://{site}")
    };
    let url =
        Url::parse(&absolute).map_err(|e| TrackerError::Config(format!("'{site}' is not a URL: {e}")))?;
    if url.host_str().is_none() {
        return Err(TrackerError::Config(format!("'{site}' has no host")));
    }
    Ok(url)
}

/// A REST URL under the site, built segment by segment so an issue key from the
/// UI cannot bring a path of its own. Cloud is on API 3, self-hosted on API 2 -
/// version 3 is the one that speaks ADF, and it does not exist off Cloud.
fn api_url(deployment: Deployment, conn: &Connection, tail: &[&str]) -> Result<Url, TrackerError> {
    let version = match deployment {
        Deployment::Cloud => "3",
        Deployment::SelfHosted => "2",
    };
    let mut url = site_url(conn)?;
    url.path_segments_mut()
        .map_err(|()| TrackerError::Config("the site URL cannot hold a path".into()))?
        .extend(["rest", "api", version])
        .extend(tail);
    Ok(url)
}

/// Where a person opens one issue in their browser.
fn browse_url(conn: &Connection, key: &str) -> Result<String, TrackerError> {
    let mut url = site_url(conn)?;
    url.path_segments_mut()
        .map_err(|()| TrackerError::Config("the site URL cannot hold a path".into()))?
        .extend(["browse", key]);
    Ok(url.to_string())
}

/// A request carrying the credential, answered as JSON or as a typed failure.
///
/// The two deployments authenticate differently: Cloud takes the Atlassian
/// account's email as the user name and the API token as the password (the token
/// alone authenticates nobody), while a self-hosted personal access token is a
/// bearer token and needs no name beside it.
async fn call(
    deployment: Deployment,
    conn: &Connection,
    method: Method,
    url: Url,
    body: Option<Value>,
) -> Result<Value, TrackerError> {
    let request = client()?.request(method, url.clone());
    let mut request = match deployment {
        Deployment::Cloud => request.basic_auth(conn.required("email")?.to_string(), Some(&conn.token)),
        Deployment::SelfHosted => request.bearer_auth(conn.token.trim()),
    };
    if let Some(payload) = body {
        request = request.json(&payload);
    }
    let response = request
        .send()
        .await
        .map_err(|e| TrackerError::Network(format!("{}: {e}", url.host_str().unwrap_or("the site"))))?;

    let status = response.status();
    let bytes = response.bytes().await.unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);

    if status.is_success() {
        // A transition answers 204 with no body, and callers that want the
        // result read the issue back themselves.
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        return serde_json::from_str(&text).map_err(|e| TrackerError::Api {
            status: status.as_u16(),
            // Unlike Azure DevOps, this service does not answer a wrong
            // credential with a page - so a page arriving here is more likely
            // something between Aime and it, and saying so beats guessing.
            message: format!(
                "the answer was not JSON, so something other than the site may have replied: {e}"
            ),
        });
    }
    let message = api_message(&text);
    Err(match status.as_u16() {
        // Measured: the body of a 401 here is HTML, not JSON.
        401 | 403 => TrackerError::Auth(message),
        404 => TrackerError::NotFound(message),
        other => TrackerError::Api {
            status: other,
            message,
        },
    })
}

/// Jira explains itself in `errorMessages` (and sometimes only in `errors`) on
/// Cloud, and in an XML `<message>` when a self-hosted site refuses a token
/// (measured: `401 application/xml` carrying "Client must be authenticated to
/// access this resource."). Anything else is quoted back short, because a page of
/// markup helps nobody.
fn api_message(body: &str) -> String {
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(body) {
        let messages: Vec<String> = map
            .get("errorMessages")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if !messages.is_empty() {
            return messages.join(" ");
        }
        if let Some(Value::Object(errors)) = map.get("errors") {
            let named: Vec<String> = errors
                .iter()
                .filter_map(|(field, reason)| reason.as_str().map(|text| format!("{field}: {text}")))
                .collect();
            if !named.is_empty() {
                return named.join(" ");
            }
        }
    }
    if let Some(message) = tagged(body, "message") {
        return message;
    }
    let summary: String = body.trim().chars().take(200).collect();
    if summary.is_empty() {
        "no explanation given".into()
    } else {
        summary
    }
}

/// The text of one XML element, without pulling in a parser for the single field
/// that is ever read out of one.
fn tagged(body: &str, tag: &str) -> Option<String> {
    let opened = body.find(&format!("<{tag}>"))? + tag.len() + 2;
    let closed = body[opened..].find(&format!("</{tag}>"))?;
    let text = body[opened..opened + closed].trim();
    (!text.is_empty()).then(|| text.to_string())
}

// ------------------------------------------------------------- normalizing

/// Jira's three status categories, in Aime's words. `undefined` is what a status
/// with no category reports, and it is not a claim worth translating.
fn category_of(key: &str) -> StateCategory {
    match key {
        "new" => StateCategory::Todo,
        "indeterminate" => StateCategory::InProgress,
        "done" => StateCategory::Done,
        _ => StateCategory::Unknown,
    }
}

/// One issue as the UI knows it. An issue with no key is not addressable, so it
/// is skipped rather than shown as a row nothing can act on.
fn work_item_from(issue: &Value, conn: &Connection) -> Option<WorkItem> {
    let key = issue.get("key").and_then(Value::as_str)?.to_string();
    let fields = issue.get("fields")?;
    let status = fields.get("status");
    Some(WorkItem {
        title: fields
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        item_type: fields
            .get("issuetype")
            .and_then(|kind| kind.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        state: status
            .and_then(|state| state.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        category: category_of(status.and_then(status_category_key).unwrap_or_default()),
        web_url: browse_url(conn, &key).ok()?,
        // Addressed by the same id it is read by.
        display_id: None,
        // Measured on a real site: a subtask's parent arrives with its own
        // summary, so a row can say what it belongs to without a second request.
        parent: fields.get("parent").and_then(|parent| {
            Some(Parent {
                id: parent.get("key")?.as_str()?.to_string(),
                title: parent
                    .get("fields")
                    .and_then(|fields| fields.get("summary"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        }),
        dimensions: dimensions_of(&key, fields),
        id: key,
    })
}

/// How Jira files work: the project a key belongs to, and the release it is
/// planned for. A sprint would belong here too, but it is a custom field whose
/// id differs per site - nothing here guesses at one.
fn dimensions_of(key: &str, fields: &Value) -> Vec<Fact> {
    let mut dimensions = Vec::new();
    if let Some((project, _)) = key.split_once('-') {
        dimensions.push(Fact {
            label: "Project".into(),
            value: project.to_string(),
        });
    }
    if let Some(release) = fields
        .get("fixVersions")
        .and_then(Value::as_array)
        .and_then(|versions| versions.first())
        .and_then(|version| version.get("name"))
        .and_then(Value::as_str)
    {
        dimensions.push(Fact {
            label: "Release".into(),
            value: release.to_string(),
        });
    }
    dimensions
}

fn status_category_key(status: &Value) -> Option<&str> {
    status.get("statusCategory")?.get("key")?.as_str()
}

/// The issues one search answer carried.
fn issues_of(body: &Value, conn: &Connection) -> Vec<WorkItem> {
    body.get("issues")
        .and_then(Value::as_array)
        .map(|issues| {
            issues
                .iter()
                .filter_map(|issue| work_item_from(issue, conn))
                .collect()
        })
        .unwrap_or_default()
}

/// One comment. `renderedBody` is the HTML both deployments answer with when it
/// is asked for; the stored `body` is a document on one and markup on the other,
/// so neither is worth reading here.
fn comment_from(comment: &Value) -> Comment {
    let text = comment
        .get("renderedBody")
        .and_then(Value::as_str)
        .map(html_to_markdown)
        .or_else(|| {
            comment
                .get("body")
                .and_then(Value::as_str)
                .map(|body| body.trim().to_string())
        })
        .unwrap_or_default();
    Comment {
        author: comment
            .get("author")
            .and_then(|author| author.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        when: comment
            .get("created")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        text,
    }
}

/// The short facts of one issue, in Jira's own words.
fn facts_of(issue: &Value) -> Vec<Fact> {
    let Some(fields) = issue.get("fields") else {
        return Vec::new();
    };
    let named = |field: &str, key: &str| {
        fields
            .get(field)
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    [
        ("Assignee", named("assignee", "displayName")),
        ("Reporter", named("reporter", "displayName")),
        ("Priority", named("priority", "name")),
        (
            "Updated",
            fields
                .get("updated")
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

/// The query behind the panel. `assignee = currentUser()` is both the point and
/// the restriction the endpoint insists on (see the module note).
fn jql(project: &str, asked: WorkItemQuery) -> String {
    let mut clauses: Vec<String> = Vec::new();
    if asked.mine_only {
        clauses.push("assignee = currentUser()".into());
    }
    if !project.is_empty() {
        clauses.push(format!("project = {}", jql_string(project)));
    }
    if !asked.include_finished {
        clauses.push("statusCategory != Done".into());
    }
    // Cloud refuses a query with no restriction at all (see the module note), and
    // "everyone's work, everywhere" is exactly that. A window of ninety days is
    // a restriction the service accepts (measured) and an honest reading of what
    // somebody scanning a whole site is looking for.
    if clauses.is_empty() {
        clauses.push("updated >= -90d".into());
    }
    format!("{} ORDER BY updated DESC", clauses.join(" AND "))
}

/// A JQL string literal. Project keys are tame, project *names* are whatever
/// somebody typed, and a stray quote would otherwise end the clause early.
fn jql_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// An issue key as a path segment: a key from the UI must not be able to walk
/// out of the path it is meant to fill. Percent-encoding covers the rest.
fn issue_key(item: &WorkItem) -> Result<&str, TrackerError> {
    let key = item.id.trim();
    // `.` and `..` are not encoded but *resolved* by the URL crate (measured:
    // `/issue/..` becomes `/issue`), which would quietly call another endpoint.
    let addressable = !key.is_empty()
        && key != "."
        && key != ".."
        && !key.contains('/')
        && !key.chars().any(char::is_whitespace);
    if !addressable {
        return Err(TrackerError::Config(format!("'{}' is not an issue key", item.id)));
    }
    Ok(key)
}

// --------------------------------------------------------------- connector

#[async_trait]
impl Connector for Jira {
    fn kind(&self) -> &'static str {
        match self.deployment {
            Deployment::Cloud => "jira",
            Deployment::SelfHosted => "jira-server",
        }
    }

    fn label(&self) -> &'static str {
        match self.deployment {
            Deployment::Cloud => "Jira Cloud",
            Deployment::SelfHosted => "Jira Server / Data Center",
        }
    }

    fn fields(&self) -> &'static [ConnectionField] {
        match self.deployment {
            Deployment::Cloud => &CLOUD_FIELDS,
            Deployment::SelfHosted => &SELF_HOSTED_FIELDS,
        }
    }

    fn secret_label(&self) -> &'static str {
        match self.deployment {
            Deployment::Cloud => "API token",
            Deployment::SelfHosted => "Personal access token",
        }
    }

    fn secret_help_url(&self) -> &'static str {
        match self.deployment {
            // An Atlassian account's tokens are managed per person, not per
            // site, so this address needs nothing filled in.
            Deployment::Cloud => "https://id.atlassian.com/manage-profile/security/api-tokens",
            // Self-hosted tokens are made on the profile page of that site. The
            // page is linked rather than its token tab: the tab's id belongs to
            // a plugin, and the page is where every version keeps it.
            Deployment::SelfHosted => "{site}/secure/ViewProfile.jspa",
        }
    }

    fn connection_id(&self, settings: &Settings) -> String {
        let value = |name: &str| {
            settings
                .get(name)
                .map_or("", String::as_str)
                .trim()
                .to_lowercase()
        };
        let host = value("site")
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string();
        // The kind is part of the identity: the same host can be a Cloud site
        // and a self-hosted one, and they are not the same connection.
        let kind = self.kind();
        match value("project") {
            project if project.is_empty() => format!("{kind}:{host}"),
            project => format!("{kind}:{host}/{project}"),
        }
    }

    fn connection_label(&self, settings: &Settings) -> String {
        let value = |name: &str| settings.get(name).map_or("", String::as_str).trim().to_string();
        let host = value("site");
        match value("project") {
            project if project.is_empty() => host,
            project => format!("{host} / {project}"),
        }
    }

    async fn work_items(
        &self,
        conn: &Connection,
        asked: WorkItemQuery,
    ) -> Result<Vec<WorkItem>, TrackerError> {
        let query = jql(conn.setting("project").trim(), asked);
        let mut items = match self.deployment {
            Deployment::Cloud => self.search_by_token(conn, &query).await?,
            Deployment::SelfHosted => self.search_by_offset(conn, &query).await?,
        };

        // A page repeated (by a service that does not advance, or by an issue
        // that moved between pages) must not become a row twice.
        let mut seen = std::collections::BTreeSet::new();
        items.retain(|item| seen.insert(item.id.clone()));
        items.truncate(MAX_WORK_ITEMS);
        Ok(items)
    }

    async fn item_detail(&self, conn: &Connection, item: &WorkItem) -> Result<WorkItemDetail, TrackerError> {
        let issue = self.fetch_issue(conn, item, Rendered::Yes).await?;
        let description = issue
            .get("renderedFields")
            .and_then(|rendered| rendered.get("description"))
            .and_then(Value::as_str)
            .map(html_to_markdown)
            .unwrap_or_default();
        Ok(WorkItemDetail {
            description,
            facts: facts_of(&issue),
        })
    }

    /// Where this issue can go from where it is - which is a question about the
    /// issue, not about its type: a Jira workflow allows different moves from
    /// each status.
    async fn states(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<StateOption>, TrackerError> {
        let transitions = self.transitions(conn, item).await?;
        Ok(transitions
            .iter()
            .filter_map(|transition| {
                let status = transition.get("to")?;
                Some(StateOption {
                    name: status.get("name")?.as_str()?.to_string(),
                    category: category_of(status_category_key(status).unwrap_or_default()),
                })
            })
            .collect())
    }

    async fn comments(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<Comment>, TrackerError> {
        let mut url = api_url(self.deployment, conn, &["issue", issue_key(item)?, "comment"])?;
        // The stored body is ADF on Cloud and wiki markup on a self-hosted site;
        // this asks both of them for the rendered HTML instead, which is the one
        // form `rich_text` can turn into Markdown.
        url.query_pairs_mut().append_pair("expand", "renderedBody");
        let body = call(self.deployment, conn, Method::GET, url, None).await?;
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
        // Cloud takes a document, self-hosted takes a string. Sending the wrong
        // one is a 400 from either.
        let body = match self.deployment {
            Deployment::Cloud => json!({
                "body": {
                    "type": "doc",
                    "version": 1,
                    "content": [{
                        "type": "paragraph",
                        "content": [{ "type": "text", "text": text }],
                    }],
                }
            }),
            Deployment::SelfHosted => json!({ "body": text }),
        };
        let posted = call(
            self.deployment,
            conn,
            Method::POST,
            api_url(self.deployment, conn, &["issue", issue_key(item)?, "comment"])?,
            Some(body),
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
        // A status is reached through the transition that leads to it, so the
        // one to perform has to be looked up by where it goes.
        let transitions = self.transitions(conn, item).await?;
        let id = transitions
            .iter()
            .find(|transition| {
                transition
                    .get("to")
                    .and_then(|status| status.get("name"))
                    .and_then(Value::as_str)
                    == Some(state)
            })
            .and_then(|transition| transition.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                TrackerError::Config(format!(
                    "{} cannot move to '{state}' from '{}'",
                    item.id, item.state
                ))
            })?
            .to_string();

        call(
            self.deployment,
            conn,
            Method::POST,
            api_url(self.deployment, conn, &["issue", issue_key(item)?, "transitions"])?,
            Some(json!({ "transition": { "id": id } })),
        )
        .await?;

        // The transition answers 204 with no body, so the item is read back
        // rather than assumed: a workflow may have moved it further than asked.
        let issue = self.fetch_issue(conn, item, Rendered::No).await?;
        work_item_from(&issue, conn).ok_or_else(|| TrackerError::NotFound(format!("issue {}", item.id)))
    }
}

/// Whether an issue is also wanted with its text fields rendered to HTML - the
/// only readable form of a description, and dead weight when the answer is only
/// needed for the row.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rendered {
    Yes,
    No,
}

impl Jira {
    /// One issue, as the service has it now.
    async fn fetch_issue(
        &self,
        conn: &Connection,
        item: &WorkItem,
        rendered: Rendered,
    ) -> Result<Value, TrackerError> {
        let mut url = api_url(self.deployment, conn, &["issue", issue_key(item)?])?;
        // Cloud stores the description as ADF and self-hosted as wiki markup;
        // neither is text. Both answer this expand with the same field rendered
        // as HTML, which is the form that turns into readable words.
        if rendered == Rendered::Yes {
            url.query_pairs_mut().append_pair("expand", "renderedFields");
        }
        call(self.deployment, conn, Method::GET, url, None).await
    }

    /// Cloud pages with a continuation token: each answer says whether it was the
    /// last and, if not, what to ask with next.
    async fn search_by_token(&self, conn: &Connection, query: &str) -> Result<Vec<WorkItem>, TrackerError> {
        let mut items: Vec<WorkItem> = Vec::new();
        let mut next_page: Option<String> = None;

        for _ in 0..MAX_PAGES {
            let mut request = json!({
                "jql": query,
                "fields": LIST_FIELDS,
                "maxResults": PAGE_SIZE,
            });
            if let (Some(token), Some(map)) = (next_page.as_ref(), request.as_object_mut()) {
                map.insert("nextPageToken".into(), Value::String(token.clone()));
            }
            let body = self
                .call_api(conn, Method::POST, &["search", "jql"], Some(request))
                .await?;
            items.extend(issues_of(&body, conn));

            // `isLast` is the service's own word for "stop"; the token is what to
            // ask with when it is not.
            let last = body.get("isLast").and_then(Value::as_bool).unwrap_or(true);
            next_page = body
                .get("nextPageToken")
                .and_then(Value::as_str)
                .map(str::to_string);
            if last || next_page.is_none() {
                break;
            }
        }
        Ok(items)
    }

    /// Self-hosted pages by offset, and says how many there are in total - so
    /// the walk ends on arithmetic rather than on a flag.
    async fn search_by_offset(&self, conn: &Connection, query: &str) -> Result<Vec<WorkItem>, TrackerError> {
        let mut items: Vec<WorkItem> = Vec::new();

        for page in 0..MAX_PAGES {
            let start = page * PAGE_SIZE;
            let body = self
                .call_api(
                    conn,
                    Method::POST,
                    &["search"],
                    Some(json!({
                        "jql": query,
                        "fields": LIST_FIELDS,
                        "maxResults": PAGE_SIZE,
                        "startAt": start,
                    })),
                )
                .await?;
            let found = issues_of(&body, conn);
            let complete_page = found.len() >= PAGE_SIZE;
            items.extend(found);

            let total = body.get("total").and_then(Value::as_u64).unwrap_or(0) as usize;
            if !complete_page || items.len() >= total {
                break;
            }
        }
        Ok(items)
    }

    /// One request against this deployment's API version.
    async fn call_api(
        &self,
        conn: &Connection,
        method: Method,
        tail: &[&str],
        body: Option<Value>,
    ) -> Result<Value, TrackerError> {
        call(
            self.deployment,
            conn,
            method,
            api_url(self.deployment, conn, tail)?,
            body,
        )
        .await
    }

    /// The transitions available from this issue's current status. A transition
    /// the service marks unavailable is not offered; a transition that says
    /// nothing about it is taken at its word.
    async fn transitions(&self, conn: &Connection, item: &WorkItem) -> Result<Vec<Value>, TrackerError> {
        let url = api_url(self.deployment, conn, &["issue", issue_key(item)?, "transitions"])?;
        let body = call(self.deployment, conn, Method::GET, url, None).await?;
        Ok(body
            .get("transitions")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|transition| {
                        transition
                            .get("isAvailable")
                            .and_then(Value::as_bool)
                            .unwrap_or(true)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
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

    /// The two deployments under test, as the registry holds them.
    const CLOUD: Jira = Jira {
        deployment: Deployment::Cloud,
    };
    const SELF_HOSTED: Jira = Jira {
        deployment: Deployment::SelfHosted,
    };

    /// The connection every test here drives, pointed at the stand-in. The site
    /// is given as a bare origin, which is what a person types.
    fn connection(service: &FakeService, project: &str) -> Connection {
        let mut settings = Settings::new();
        settings.insert("site".into(), service.base.clone());
        settings.insert("email".into(), "linh@example.com".into());
        settings.insert("project".into(), project.into());
        Connection {
            settings,
            token: "api-token-1".into(),
        }
    }

    /// One comment as a site answers it: the stored document next to the rendered
    /// HTML the panel actually reads.
    const COMMENTS: &str = r#"{"total":1,"comments":[
        {"id":"10100","author":{"displayName":"Mai Tran"},"created":"2026-08-17T09:00:00.000+0700",
         "body":{"type":"doc","version":1,"content":[]},
         "renderedBody":"<p>Reproduced on Firefox as well.</p>"}]}"#;

    /// What a site answers when it has accepted a new comment.
    const COMMENT: &str = r#"{"id":"10101","author":{"displayName":"Linh Pham"},
        "created":"2026-08-18T10:00:00.000+0700","renderedBody":"<p>Fixed on the branch.</p>"}"#;

    fn item(key: &str, state: &str) -> WorkItem {
        WorkItem {
            id: key.into(),
            title: "Whatever".into(),
            item_type: "Bug".into(),
            state: state.into(),
            category: StateCategory::InProgress,
            web_url: String::new(),
            display_id: None,
            parent: None,
            dimensions: Vec::new(),
        }
    }

    /// Two issues in the shape a real site answered with on 2026-08-18: a custom
    /// status name ("Waiting for review") whose category is the standard
    /// `indeterminate`, next to a stock "New".
    const SEARCH: &str = r#"{"issues":[
        {"id":"108635","key":"HHH-20613","fields":{
            "summary":"Discriminator column naming",
            "issuetype":{"name":"Improvement"},
            "status":{"name":"Waiting for review","statusCategory":{"key":"indeterminate","name":"In Progress"}}}},
        {"id":"108640","key":"HHH-20789","fields":{
            "summary":"Add a keyboard shortcut",
            "issuetype":{"name":"Task"},
            "status":{"name":"New","statusCategory":{"key":"new","name":"To Do"}}}}],
        "isLast":true}"#;

    const TRANSITIONS: &str = r#"{"expand":"transitions","transitions":[
        {"id":"11","name":"Start work","isAvailable":true,
         "to":{"name":"In Progress","statusCategory":{"key":"indeterminate"}}},
        {"id":"21","name":"Resolve","isAvailable":true,
         "to":{"name":"Closed","statusCategory":{"key":"done"}}},
        {"id":"31","name":"Escalate","isAvailable":false,
         "to":{"name":"Escalated","statusCategory":{"key":"indeterminate"}}}]}"#;

    #[tokio::test]
    async fn a_refresh_asks_one_bounded_query_and_normalizes_the_answers() {
        let service = FakeService::start(|_| json_response(SEARCH));
        let items = CLOUD
            .work_items(&connection(&service, "HHH"), MINE)
            .await
            .expect("the list");

        assert_eq!(
            items.iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(),
            ["HHH-20613", "HHH-20789"],
            "issues must arrive in the order the query returned them"
        );
        let first = &items[0];
        assert_eq!(first.title, "Discriminator column naming");
        assert_eq!(first.item_type, "Improvement");
        assert_eq!(
            first.state, "Waiting for review",
            "the team's own status name is kept, however custom it is"
        );
        assert_eq!(
            first.category,
            StateCategory::InProgress,
            "the category rides on the issue, so no second request is needed"
        );
        assert_eq!(items[1].category, StateCategory::Todo);
        assert!(
            first.web_url.ends_with("/browse/HHH-20613"),
            "the row must open the issue a person can read: {}",
            first.web_url
        );

        // Jira Cloud takes the account email as the user name and the API token
        // as the password: base64("linh@example.com:api-token-1").
        let search = service.request_for("/search/jql");
        assert_eq!(search.method, "POST");
        assert_eq!(
            search.authorization,
            "Basic bGluaEBleGFtcGxlLmNvbTphcGktdG9rZW4tMQ=="
        );
        // Measured: this endpoint refuses a query with no restriction at all, and
        // caps a page at 100 whatever is asked for.
        assert!(
            search.body.contains(r#"assignee = currentUser() AND project = \"HHH\" AND statusCategory != Done ORDER BY updated DESC"#),
            "the query was not the bounded one the endpoint requires: {}",
            search.body
        );
        assert!(search.body.contains("\"maxResults\":100"), "{}", search.body);
    }

    #[tokio::test]
    async fn the_next_page_is_followed_and_a_service_that_never_advances_still_ends() {
        // Two pages that advance, then a third answer that hands back the *same*
        // token forever - which is what would turn a refresh into a hundred
        // requests if the walk trusted the service instead of counting.
        let service = FakeService::start(|request| {
            // Which page was asked for is decided by the token that came with
            // the request: none for the first, then the one each answer handed
            // back - and from the third answer on, always the same one.
            let page = if request.body.contains("\"nextPageToken\"") {
                if request.body.contains("stuck") {
                    2
                } else {
                    1
                }
            } else {
                0
            };
            let token = if page == 0 { "second" } else { "stuck" };
            json_response(&format!(
                r#"{{"issues":[{{"id":"1","key":"HHH-{page}","fields":{{
                    "summary":"Page {page}","issuetype":{{"name":"Task"}},
                    "status":{{"name":"New","statusCategory":{{"key":"new"}}}}}}}}],
                    "nextPageToken":"{token}","isLast":false}}"#
            ))
        });

        let items = CLOUD
            .work_items(&connection(&service, "HHH"), MINE)
            .await
            .expect("the list");

        assert_eq!(
            items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["HHH-0", "HHH-1", "HHH-2"],
            "each page must be followed, and a repeat must not become a second row"
        );
        assert_eq!(
            service.requests().len(),
            MAX_PAGES,
            "the walk is counted, so a service that never says 'last' still stops"
        );
    }

    #[tokio::test]
    async fn a_site_without_a_project_still_asks_a_query_it_will_accept() {
        let service = FakeService::start(|_| json_response(SEARCH));
        CLOUD
            .work_items(&connection(&service, ""), MINE_AND_DONE)
            .await
            .expect("the list");

        let body = service.request_for("/search/jql").body;
        assert!(
            body.contains("assignee = currentUser() ORDER BY updated DESC"),
            "a project is optional, and the assignee clause is what bounds the query: {body}"
        );
        assert!(
            !body.contains("statusCategory"),
            "'include finished' must drop the filter entirely: {body}"
        );
    }

    #[tokio::test]
    async fn a_refused_token_is_reported_as_one_even_though_it_answers_in_html() {
        // Measured on a real Cloud site: 401 with a text/html body.
        let service = FakeService::start(|_| {
            response(
                "401 Unauthorized",
                "text/html;charset=UTF-8",
                "Client must be authenticated to access this resource.",
            )
        });

        let error = CLOUD
            .work_items(&connection(&service, "HHH"), MINE)
            .await
            .expect_err("a refusal must not read as an empty board")
            .to_string();
        assert!(error.starts_with("TRACKER_AUTH::"), "{error}");
        assert!(
            error.contains("must be authenticated"),
            "the service's own words are the useful half: {error}"
        );
    }

    #[tokio::test]
    async fn a_jql_the_service_rejects_is_quoted_back() {
        let service = FakeService::start(|_| {
            response(
                "400 Bad Request",
                "application/json",
                r#"{"errorMessages":["Unbounded JQL queries are not allowed here."],"errors":{}}"#,
            )
        });

        let error = CLOUD
            .work_items(&connection(&service, "HHH"), MINE)
            .await
            .expect_err("a rejected query is a failure")
            .to_string();
        assert!(error.starts_with("TRACKER_API::400::"), "{error}");
        assert!(error.contains("Unbounded JQL"), "{error}");
    }

    #[tokio::test]
    async fn the_states_offered_are_the_transitions_this_issue_can_take() {
        let service = FakeService::start(|_| json_response(TRANSITIONS));
        let states = CLOUD
            .states(&connection(&service, "HHH"), &item("HHH-1", "New"))
            .await
            .expect("the states");

        assert_eq!(
            states.iter().map(|state| state.name.as_str()).collect::<Vec<_>>(),
            ["In Progress", "Closed"],
            "a transition the service marks unavailable must not be offered"
        );
        assert_eq!(states[1].category, StateCategory::Done);
        assert!(service
            .request_for("/transitions")
            .target
            .contains("/issue/HHH-1/transitions"));
    }

    #[tokio::test]
    async fn a_move_performs_the_transition_that_leads_there_and_reads_the_issue_back() {
        let service = FakeService::start(|request| {
            if request.method == "POST" {
                // Measured: a performed transition answers 204 with no body.
                return response("204 No Content", "application/json", "");
            }
            if request.target.contains("/transitions") {
                return json_response(TRANSITIONS);
            }
            json_response(
                r#"{"key":"HHH-1","fields":{"summary":"Whatever","issuetype":{"name":"Bug"},
                    "status":{"name":"Closed","statusCategory":{"key":"done"}}},
                    "renderedFields":{"description":"<p>Fixed.</p>"}}"#,
            )
        });

        let moved = CLOUD
            .set_state(&connection(&service, "HHH"), &item("HHH-1", "New"), "Closed")
            .await
            .expect("the move");

        assert_eq!(moved.state, "Closed");
        assert_eq!(
            moved.category,
            StateCategory::Done,
            "the item comes back read from the service, not assumed"
        );
        let performed = service
            .requests()
            .into_iter()
            .find(|seen| seen.method == "POST")
            .expect("no transition was performed");
        assert_eq!(
            performed.body, r#"{"transition":{"id":"21"}}"#,
            "the transition is chosen by where it leads, not by its name"
        );
    }

    #[tokio::test]
    async fn a_state_no_transition_reaches_is_refused_before_anything_is_sent() {
        let service = FakeService::start(|_| json_response(TRANSITIONS));
        let error = CLOUD
            .set_state(&connection(&service, "HHH"), &item("HHH-1", "New"), "Escalated")
            .await
            .expect_err("an unavailable transition must not be attempted")
            .to_string();

        assert!(error.starts_with("TRACKER_CONFIG::"), "{error}");
        assert!(error.contains("cannot move to 'Escalated'"), "{error}");
        assert!(
            service.requests().iter().all(|seen| seen.method == "GET"),
            "nothing may be written when the move is impossible"
        );
    }

    #[tokio::test]
    async fn a_description_arrives_as_words_rather_than_as_a_document() {
        let service = FakeService::start(|_| {
            json_response(
                r#"{"key":"HHH-9","fields":{"summary":"Login fails","issuetype":{"name":"Bug"},
                    "status":{"name":"New","statusCategory":{"key":"new"}},
                    "description":{"type":"doc","version":1,"content":[]}},
                    "renderedFields":{"description":"<p>Users can&#39;t sign in.<br>Since&nbsp;Monday.</p>"}}"#,
            )
        });

        let detail = CLOUD
            .item_detail(&connection(&service, "HHH"), &item("HHH-9", "New"))
            .await
            .expect("the detail");

        // The stored field is ADF; the rendered one is HTML, and this is why the
        // request asks for it.
        assert_eq!(detail.description, "Users can't sign in.\nSince Monday.");
        assert!(
            service
                .request_for("/issue/HHH-9")
                .target
                .contains("expand=renderedFields"),
            "without the expand, the description would arrive as a JSON document"
        );
    }

    /// A self-hosted connection: no email, and the token is a bearer.
    fn self_hosted(service: &FakeService, project: &str) -> Connection {
        let mut settings = Settings::new();
        settings.insert("site".into(), service.base.clone());
        settings.insert("project".into(), project.into());
        Connection {
            settings,
            token: "pat-self-hosted".into(),
        }
    }

    /// The shape a real Jira Server answered with on 2026-08-18: offset paging
    /// with a total, and the same `statusCategory` Cloud has.
    fn offset_page(start: usize, count: usize, total: usize) -> String {
        let issues: Vec<String> = (0..count)
            .map(|index| {
                format!(
                    r#"{{"id":"{id}","key":"JRA-{id}","fields":{{
                        "summary":"Issue {id}","issuetype":{{"name":"Suggestion"}},
                        "status":{{"name":"Gathering Interest","statusCategory":{{"key":"new"}}}}}}}}"#,
                    id = start + index
                )
            })
            .collect();
        format!(
            r#"{{"startAt":{start},"maxResults":{PAGE_SIZE},"total":{total},"issues":[{}]}}"#,
            issues.join(",")
        )
    }

    #[tokio::test]
    async fn a_self_hosted_site_is_asked_on_api_2_with_the_token_as_a_bearer() {
        let service = FakeService::start(|_| json_response(&offset_page(0, 2, 2)));
        let items = SELF_HOSTED
            .work_items(&self_hosted(&service, "JRA"), MINE)
            .await
            .expect("the list");

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "JRA-0");
        assert_eq!(
            items[0].category,
            StateCategory::Todo,
            "a custom status name ('Gathering Interest') still carries a standard category"
        );

        let search = service.request_for("/search");
        assert!(
            search.target.starts_with("/rest/api/2/search"),
            "version 3 does not exist off Cloud: {}",
            search.target
        );
        assert_eq!(
            search.authorization, "Bearer pat-self-hosted",
            "a personal access token is a bearer token, not a password"
        );
        assert!(search.body.contains("\"startAt\":0"), "{}", search.body);
    }

    #[tokio::test]
    async fn a_self_hosted_walk_ends_on_the_total_it_was_told() {
        // Two pages worth, then nothing more: the total is what says so.
        let service = FakeService::start(|request| {
            let start: usize = request
                .body
                .split("\"startAt\":")
                .nth(1)
                .and_then(|tail| {
                    tail.trim_start()
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                        .parse()
                        .ok()
                })
                .unwrap_or(0);
            let count = if start == 0 { PAGE_SIZE } else { 5 };
            json_response(&offset_page(start, count, PAGE_SIZE + 5))
        });

        let items = SELF_HOSTED
            .work_items(&self_hosted(&service, ""), MINE)
            .await
            .expect("the list");

        assert_eq!(items.len(), PAGE_SIZE + 5, "the second page was never asked for");
        let offsets: Vec<usize> = service
            .requests()
            .into_iter()
            .filter(|seen| seen.target.contains("/search"))
            .map(|seen| {
                if seen.body.contains("\"startAt\":0") {
                    0
                } else {
                    PAGE_SIZE
                }
            })
            .collect();
        assert_eq!(
            offsets,
            [0, PAGE_SIZE],
            "the walk must stop once the total is reached"
        );
    }

    #[tokio::test]
    async fn a_self_hosted_refusal_arrives_as_xml_and_is_still_read() {
        // Measured: a self-hosted site refuses a bearer token with XML, not JSON.
        let service = FakeService::start(|_| {
            response(
                "401 Unauthorized",
                "application/xml;charset=UTF-8",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><status><status-code>401</status-code><message>Client must be authenticated to access this resource.</message></status>"#,
            )
        });

        let error = SELF_HOSTED
            .work_items(&self_hosted(&service, "JRA"), MINE)
            .await
            .expect_err("a refusal is not an empty board")
            .to_string();
        assert!(error.starts_with("TRACKER_AUTH::"), "{error}");
        assert_eq!(
            error, "TRACKER_AUTH::Client must be authenticated to access this resource.",
            "the message has to come out of the XML, not the angle brackets with it"
        );
    }

    #[test]
    fn the_two_deployments_are_two_connections_that_cannot_be_confused() {
        let mut settings = Settings::new();
        settings.insert("site".into(), "jira.company.com".into());
        assert_eq!(CLOUD.connection_id(&settings), "jira:jira.company.com");
        assert_eq!(
            SELF_HOSTED.connection_id(&settings),
            "jira-server:jira.company.com",
            "the same host on the two products is not the same connection"
        );
        assert_eq!(SELF_HOSTED.secret_label(), "Personal access token");
        assert_eq!(
            SELF_HOSTED
                .fields()
                .iter()
                .map(|field| field.name)
                .collect::<Vec<_>>(),
            ["site", "project"],
            "a self-hosted token authenticates on its own, so no email is asked for"
        );
    }

    #[test]
    fn a_site_typed_as_a_host_is_completed_rather_than_refused() {
        let mut settings = Settings::new();
        settings.insert("email".into(), "linh@example.com".into());
        let with = |site: &str| {
            let mut settings = settings.clone();
            settings.insert("site".into(), site.into());
            let conn = Connection {
                settings,
                token: "t".into(),
            };
            api_url(Deployment::Cloud, &conn, &["myself"]).map(String::from)
        };

        assert_eq!(
            with("team.atlassian.net").expect("a bare host is what people type"),
            "https://team.atlassian.net/rest/api/3/myself"
        );
        assert_eq!(
            with("https://team.atlassian.net/").expect("a full URL with a slash"),
            "https://team.atlassian.net/rest/api/3/myself"
        );
        assert!(with("").is_err(), "an empty site cannot be completed into one");
        assert!(with("not a url at all").is_err());
    }

    #[test]
    fn everyones_work_still_asks_something_the_service_will_answer() {
        // With a project there is already a restriction.
        let in_project = jql("HHH", EVERYONE);
        assert!(!in_project.contains("assignee"), "{in_project}");
        assert!(in_project.contains(r#"project = "HHH""#), "{in_project}");

        // Measured on a real Cloud site: `statusCategory != Done` counts as a
        // restriction on its own, so scanning a whole site for open work is a
        // query the service answers.
        let open_everywhere = jql("", EVERYONE);
        assert_eq!(open_everywhere, "statusCategory != Done ORDER BY updated DESC");

        // Everyone's work, finished included, across a whole site is the one case
        // with no restriction left - and `ORDER BY` alone is refused (measured),
        // so a window stands in for one.
        let everything = jql(
            "",
            WorkItemQuery {
                mine_only: false,
                include_finished: true,
            },
        );
        assert_eq!(everything, "updated >= -90d ORDER BY updated DESC");
        assert!(jql("", MINE).starts_with("assignee = currentUser()"));
    }

    #[test]
    fn a_project_name_with_a_quote_cannot_break_the_query() {
        assert_eq!(jql_string(r#"Won"t do"#), r#""Won\"t do""#);
        assert!(jql(r#"Won"t"#, MINE).contains(r#"project = "Won\"t""#));
    }

    #[test]
    fn an_issue_key_that_could_walk_out_of_its_path_is_refused() {
        assert!(issue_key(&item("HHH-1", "New")).is_ok());
        assert!(issue_key(&item("HHH-1/../../admin", "New")).is_err());
        assert!(issue_key(&item("HHH 1", "New")).is_err());
        assert!(issue_key(&item("  ", "New")).is_err());
        // Measured: the URL crate resolves these away rather than encoding them,
        // so `/issue/..` would become `/issue` - a different endpoint entirely.
        assert!(issue_key(&item("..", "New")).is_err());
        assert!(issue_key(&item(".", "New")).is_err());
    }

    #[test]
    fn a_connection_is_identified_by_its_site_and_project_however_they_were_typed() {
        let mut settings = Settings::new();
        settings.insert("site".into(), "https://Team.atlassian.net/".into());
        settings.insert("project".into(), "Proj".into());
        assert_eq!(CLOUD.connection_id(&settings), "jira:team.atlassian.net/proj");
        assert_eq!(
            CLOUD.connection_label(&settings),
            "https://Team.atlassian.net/ / Proj"
        );

        settings.insert("project".into(), String::new());
        assert_eq!(
            CLOUD.connection_id(&settings),
            "jira:team.atlassian.net",
            "a site-wide connection is not the same connection as a project's"
        );
    }

    #[test]
    fn every_status_category_jira_has_maps_to_one_of_ours() {
        assert_eq!(category_of("new"), StateCategory::Todo);
        assert_eq!(category_of("indeterminate"), StateCategory::InProgress);
        assert_eq!(category_of("done"), StateCategory::Done);
        assert_eq!(
            category_of("undefined"),
            StateCategory::Unknown,
            "a status with no category is not a claim worth guessing at"
        );
    }

    /// The conversation, both ways and on both deployments.
    ///
    /// The two halves that can only be wrong at runtime: the stored body is ADF on
    /// Cloud and wiki markup on a self-hosted site, so reading asks for the
    /// rendered HTML instead; and writing takes a document on Cloud and a plain
    /// string on a self-hosted site, where sending the other one is a 400.
    #[tokio::test]
    async fn the_conversation_is_read_as_words_and_written_in_the_shape_each_deployment_takes() {
        let service = FakeService::start(|request| {
            if request.method == "POST" {
                json_response(COMMENT)
            } else {
                json_response(COMMENTS)
            }
        });
        let subject = item("AIME-1", "In Progress");

        let thread = CLOUD
            .comments(&connection(&service, "AIME"), &subject)
            .await
            .expect("the comments");
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].author, "Mai Tran");
        assert_eq!(
            thread[0].text, "Reproduced on Firefox as well.",
            "a comment must arrive as words, not as markup"
        );
        let read = service.request_for("comment");
        assert!(
            read.target.contains("/rest/api/3/issue/AIME-1/comment")
                && read.target.contains("expand=renderedBody"),
            "the rendered form is the only one that can be turned into words: {}",
            read.target
        );

        CLOUD
            .add_comment(&connection(&service, "AIME"), &subject, "Fixed on the branch.")
            .await
            .expect("the new comment");
        SELF_HOSTED
            .add_comment(&self_hosted(&service, "AIME"), &subject, "Fixed on the branch.")
            .await
            .expect("the new comment");

        let posted: Vec<_> = service
            .requests()
            .into_iter()
            .filter(|seen| seen.method == "POST")
            .collect();
        assert_eq!(posted.len(), 2, "both deployments should have been written to");
        assert!(
            posted[0].body.contains(r#""type":"doc""#) && posted[0].body.contains("Fixed on the branch."),
            "Cloud takes a document: {}",
            posted[0].body
        );
        assert_eq!(
            posted[1].body, r#"{"body":"Fixed on the branch."}"#,
            "a self-hosted site takes a string"
        );
        assert!(
            posted[1].target.contains("/rest/api/2/issue/AIME-1/comment"),
            "a self-hosted site is asked on api 2: {}",
            posted[1].target
        );
    }
}
