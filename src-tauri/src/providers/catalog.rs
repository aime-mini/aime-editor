//! The models a built-in CLI offers right now, read from the CLI itself.
//!
//! A list typed into Aime is stale the day a model ships, and it did go stale:
//! the picker still said Opus 5 while the installed Claude Code already knew
//! Opus 5.5. Neither CLI has an API Aime could ask without a key, so each is
//! read where it keeps its own list:
//!
//! - **Codex** publishes its catalog: `codex debug models` prints the JSON the
//!   CLI fetched from its backend (measured on 0.146.0: 322 ms), with a display
//!   name, a visibility and the reasoning levels each model accepts. When the
//!   command fails the CLI's own cache of the same JSON, `models_cache.json`
//!   in its home, is read instead.
//! - **Claude Code** keeps no file. Its base list is compiled into the binary,
//!   and the extra options its server pushes are cached in `.claude.json`
//!   (`additionalModelOptionsCache`). So the installed binary is scanned once
//!   for the model names it carries - `claude-<family>-<major>[-<minor>]`,
//!   dated snapshots and `-v1` variants excluded - and the result is cached
//!   by the binary's size and modification time, which change exactly when
//!   Claude Code updates itself. Of what is found, the newest generation of
//!   each family is offered whole and the one before it by its last release;
//!   the server's extra options come first.
//!
//! - **A configured CLI** (`providers.json`) names its own list command in
//!   `modelsArgs`, or its service's model endpoint in `modelsUrl`, filled in
//!   by the AI that read the CLI's help when it was added; the output is read
//!   as JSON or as lines. Without either the picker offers the CLI's default
//!   only. Measured on gemini-cli 0.62.0: no list flag, and its bundle holds
//!   the model names only as variables, so a scan of the program (thirty
//!   distinct `gemini-*` strings, test fixtures among them) is no catalog -
//!   Google's `models.list` endpoint is, with the user's key.
//!
//! The aliases (`opus`, `sonnet`, …) and the "Auto" choice are the
//! frontend's: they are not model names and never go stale (`lib/providers.ts`).

use super::generic::ProviderConfig;
use crate::home::home_dir;
use crate::program::Program;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// One model as the picker offers it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// What the CLI's model flag takes.
    pub value: String,
    pub label: String,
    /// The reasoning levels this model accepts, when the catalog says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<String>>,
}

/// The models the named CLI offers on this machine, newest first.
#[tauri::command]
pub async fn provider_models(app: AppHandle, provider_id: String) -> Result<Vec<ModelChoice>, String> {
    match provider_id.as_str() {
        "claude" => tauri::async_runtime::spawn_blocking(move || claude_models(&app))
            .await
            .map_err(|e| e.to_string())?,
        "codex" => codex_models().await,
        other => configured_models(&app, other).await,
    }
}

// ---- Claude Code -----------------------------------------------------------

/// Where the scan of the installed binary is kept, under the app data dir.
const SCAN_CACHE: &str = "model-catalog/claude.json";
/// The npm install of Claude Code: a shim on PATH, the program beside it.
const NPM_BUNDLE: &str = "node_modules/@anthropic-ai/claude-code/cli.js";
/// A file this small on PATH is a launcher, not the program.
const LAUNCHER_MAX_BYTES: u64 = 1024 * 1024;
/// Families in the order the picker shows them; anything else is not a model name.
const FAMILIES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
const PREFIX: &[u8] = b"claude-";
/// Read size for the scan; the overlap keeps a name split across two reads whole.
const CHUNK_BYTES: usize = 8 * 1024 * 1024;
const OVERLAP_BYTES: usize = 64;

/// A model name as the binary spells it: `claude-opus-5-5` is opus 5.5.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct ModelId {
    family: String,
    major: u32,
    minor: Option<u32>,
}

impl ModelId {
    fn value(&self) -> String {
        match self.minor {
            Some(minor) => format!("claude-{}-{}-{}", self.family, self.major, minor),
            None => format!("claude-{}-{}", self.family, self.major),
        }
    }

    fn label(&self) -> String {
        let mut family = self.family.clone();
        if let Some(first) = family.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        match self.minor {
            Some(minor) => format!("{family} {}.{minor}", self.major),
            None => format!("{family} {}", self.major),
        }
    }

    fn family_rank(&self) -> usize {
        FAMILIES
            .iter()
            .position(|family| *family == self.family)
            .unwrap_or(FAMILIES.len())
    }
}

/// Family order, then newest first.
impl Ord for ModelId {
    fn cmp(&self, other: &Self) -> Ordering {
        self.family_rank()
            .cmp(&other.family_rank())
            .then_with(|| other.major.cmp(&self.major))
            .then_with(|| other.minor.unwrap_or(0).cmp(&self.minor.unwrap_or(0)))
    }
}

impl PartialOrd for ModelId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn claude_models(app: &AppHandle) -> Result<Vec<ModelChoice>, String> {
    let binary = claude_program().ok_or("Claude Code is not installed")?;
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(SCAN_CACHE);
    let found = scanned_with_cache(&binary, &cache).map_err(|e| e.to_string())?;
    let mut choices = additional_options(&claude_config_path());
    for choice in pinned(&found) {
        if !choices.iter().any(|known| known.value == choice.value) {
            choices.push(choice);
        }
    }
    if choices.is_empty() {
        return Err(format!("no model names found in {}", binary.display()));
    }
    Ok(choices)
}

/// The file that holds Claude Code's own code: the native binary, or the
/// JavaScript bundle an npm install puts beside its shim.
fn claude_program() -> Option<PathBuf> {
    let resolved = Program::resolve("claude");
    if !resolved.exists() {
        return None;
    }
    let path = dunce::canonicalize(resolved.path()).unwrap_or_else(|_| resolved.path().to_path_buf());
    let small = fs::metadata(&path).is_ok_and(|meta| meta.len() < LAUNCHER_MAX_BYTES);
    if resolved.is_batch_shim() || small {
        let bundle = path.parent()?.join(NPM_BUNDLE);
        return bundle.is_file().then_some(bundle);
    }
    Some(path)
}

/// `.claude.json`, in the folder Claude Code is told to use or in the home.
fn claude_config_path() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(home_dir)
        .unwrap_or_default()
        .join(".claude.json")
}

/// What the scan found last time, and of which file.
#[derive(Serialize, Deserialize)]
struct CachedScan {
    path: String,
    len: u64,
    modified_ms: u64,
    models: Vec<ModelId>,
}

/// The names in the binary, from the cache when the binary has not changed.
fn scanned_with_cache(binary: &Path, cache: &Path) -> io::Result<BTreeSet<ModelId>> {
    let meta = fs::metadata(binary)?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX));
    let path = binary.to_string_lossy().to_string();
    if let Some(cached) = fs::read_to_string(cache)
        .ok()
        .and_then(|text| serde_json::from_str::<CachedScan>(&text).ok())
    {
        if cached.path == path && cached.len == meta.len() && cached.modified_ms == modified_ms {
            return Ok(cached.models.into_iter().collect());
        }
    }
    let models = scan_file(binary)?;
    if let Some(dir) = cache.parent() {
        fs::create_dir_all(dir)?;
    }
    let record = CachedScan {
        path,
        len: meta.len(),
        modified_ms,
        models: models.iter().cloned().collect(),
    };
    fs::write(cache, serde_json::to_string(&record).map_err(io::Error::other)?)?;
    Ok(models)
}

/// Every model name in a file, read in chunks: the binary is a quarter of a
/// gigabyte and only ever grows.
fn scan_file(path: &Path) -> io::Result<BTreeSet<ModelId>> {
    let mut reader = BufReader::new(fs::File::open(path)?);
    let mut found = BTreeSet::new();
    let mut buffer = vec![0u8; CHUNK_BYTES + OVERLAP_BYTES];
    let mut carried = 0;
    loop {
        let read = reader.read(&mut buffer[carried..])?;
        if read == 0 {
            break;
        }
        let filled = carried + read;
        found.extend(scan(&buffer[..filled]));
        carried = filled.min(OVERLAP_BYTES);
        buffer.copy_within(filled - carried..filled, 0);
    }
    Ok(found)
}

/// Every well-formed model name in a byte slice.
fn scan(bytes: &[u8]) -> BTreeSet<ModelId> {
    let mut found = BTreeSet::new();
    let mut from = 0;
    while let Some(offset) = bytes[from..].iter().position(|&byte| byte == PREFIX[0]) {
        let start = from + offset;
        if bytes[start..].starts_with(PREFIX) {
            if let Some(id) = parse_id(&bytes[start + PREFIX.len()..]) {
                found.insert(id);
            }
        }
        from = start + 1;
    }
    found
}

/// `opus-5-5"` → opus 5.5; None for a snapshot (`opus-4-1-20250805`), a
/// `-v1` variant, or anything that is not a family name and a version.
fn parse_id(rest: &[u8]) -> Option<ModelId> {
    let family = FAMILIES
        .iter()
        .find(|family| rest.starts_with(family.as_bytes()) && rest.get(family.len()) == Some(&b'-'))?;
    let mut at = family.len() + 1;
    let (major, after_major) = number(rest, at)?;
    at = after_major;
    let mut minor = None;
    if rest.get(at) == Some(&b'-') && rest.get(at + 1).is_some_and(u8::is_ascii_digit) {
        let (value, after_minor) = number(rest, at + 1)?;
        minor = Some(value);
        at = after_minor;
    }
    // A name ends here; a further `-digit`, `-v1` or a letter means a longer
    // identifier this is only the start of.
    let continues = rest
        .get(at)
        .is_some_and(|byte| *byte == b'-' || byte.is_ascii_alphanumeric());
    (!continues).then(|| ModelId {
        family: (*family).to_string(),
        major,
        minor,
    })
}

/// Up to two digits at `at`, and where they end.
fn number(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
    let digits: Vec<u8> = bytes[at..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .take(3)
        .copied()
        .collect();
    if digits.is_empty() || digits.len() > 2 {
        return None;
    }
    let value = std::str::from_utf8(&digits).ok()?.parse().ok()?;
    Some((value, at + digits.len()))
}

/// The newest generation of each family whole, the one before it by its last
/// release: what a person choosing a model today would want to see.
fn pinned(found: &BTreeSet<ModelId>) -> Vec<ModelChoice> {
    let mut choices = Vec::new();
    for family in FAMILIES {
        let mut of_family = found.iter().filter(|id| id.family == family);
        let Some(newest) = of_family.next() else {
            continue;
        };
        let previous = newest.major.checked_sub(1);
        let mut previous_shown = false;
        for id in std::iter::once(newest).chain(of_family) {
            let keep = id.major == newest.major || (Some(id.major) == previous && !previous_shown);
            if !keep {
                continue;
            }
            previous_shown |= Some(id.major) == previous;
            choices.push(ModelChoice {
                value: id.value(),
                label: id.label(),
                efforts: None,
            });
        }
    }
    choices
}

/// One entry of `additionalModelOptionsCache` in `.claude.json`: what the
/// server offered this account beyond the built-in list.
#[derive(Deserialize)]
struct AdditionalOption {
    value: String,
    label: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct ClaudeConfig {
    #[serde(default, rename = "additionalModelOptionsCache")]
    additional_model_options_cache: Vec<AdditionalOption>,
}

/// Long-context variants are named `<model>[1m]`.
const LONG_CONTEXT_SUFFIX: &str = "[1m]";

/// The server's extra options, labelled the way Claude Code's own picker does:
/// the description's first part ("Fable 5.1 · Most capable…") names the
/// version, the label alone ("Fable") does not.
fn additional_options(config: &Path) -> Vec<ModelChoice> {
    let Some(parsed) = fs::read_to_string(config)
        .ok()
        .and_then(|text| serde_json::from_str::<ClaudeConfig>(&text).ok())
    else {
        return Vec::new();
    };
    parsed
        .additional_model_options_cache
        .into_iter()
        .filter(|option| !option.value.is_empty())
        .map(|option| {
            let named = option.description.split(" · ").next().unwrap_or("").trim();
            let base = if named.starts_with(option.label.as_str()) && !named.is_empty() {
                named.to_string()
            } else {
                option.label.clone()
            };
            let label = if option.value.ends_with(LONG_CONTEXT_SUFFIX) {
                format!("{base} · 1M context")
            } else {
                base
            };
            ModelChoice {
                value: option.value,
                label,
                efforts: None,
            }
        })
        .collect()
}

// ---- Codex ------------------------------------------------------------------

/// How long a CLI may take to list its models.
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
/// The CLI's own copy of the catalog, in its home.
const CODEX_CACHE: &str = "models_cache.json";
/// The catalog's word for a model the picker should show.
const VISIBLE: &str = "list";

#[derive(Deserialize)]
struct CodexCatalog {
    models: Vec<CodexModel>,
}

#[derive(Deserialize)]
struct CodexModel {
    slug: String,
    display_name: String,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    supported_reasoning_levels: Vec<ReasoningLevel>,
}

#[derive(Deserialize)]
struct ReasoningLevel {
    effort: String,
}

async fn codex_models() -> Result<Vec<ModelChoice>, String> {
    let listed = tokio::time::timeout(
        LIST_TIMEOUT,
        super::cli_command("codex", ["debug", "models"]).output(),
    )
    .await;
    let text = match listed {
        Ok(Ok(output)) if output.status.success() => String::from_utf8_lossy(&output.stdout).to_string(),
        _ => fs::read_to_string(codex_home().join(CODEX_CACHE))
            .map_err(|e| format!("codex debug models failed and {CODEX_CACHE} could not be read: {e}"))?,
    };
    parse_codex_catalog(&text)
}

/// `CODEX_HOME`, or `~/.codex`.
fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().unwrap_or_default().join(".codex"))
}

/// The catalog's listed models, in the catalog's own order.
fn parse_codex_catalog(text: &str) -> Result<Vec<ModelChoice>, String> {
    let catalog: CodexCatalog = serde_json::from_str(text).map_err(|e| format!("codex catalog: {e}"))?;
    Ok(catalog
        .models
        .into_iter()
        .filter(|model| model.visibility == VISIBLE)
        .map(|model| ModelChoice {
            value: model.slug,
            label: model.display_name,
            efforts: Some(
                model
                    .supported_reasoning_levels
                    .into_iter()
                    .map(|level| level.effort)
                    .collect(),
            ),
        })
        .collect())
}

// ---- Configured CLIs ---------------------------------------------------------

/// A CLI described in `providers.json`: its own list command when the entry
/// names one, its service's endpoint otherwise; nothing, rather than an
/// error, when it has neither.
async fn configured_models(app: &AppHandle, provider_id: &str) -> Result<Vec<ModelChoice>, String> {
    let adapter =
        super::generic::find(provider_id).ok_or_else(|| format!("Unsupported provider: {provider_id}"))?;
    let config = &adapter.config;
    if config.models_args.is_empty() {
        return listed_over_http(app, config).await;
    }
    let command = format!("{} {}", config.command, config.models_args.join(" "));
    let output = tokio::time::timeout(
        LIST_TIMEOUT,
        super::cli_command(&config.command, &config.models_args).output(),
    )
    .await
    .map_err(|_| format!("{command} did not finish"))?
    .map_err(|e| format!("{command}: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{command} failed: {}", stderr.trim()));
    }
    Ok(parse_listing(&String::from_utf8_lossy(&output.stdout)))
}

/// What stands for the user's key in `modelsUrl`.
const API_KEY_PLACEHOLDER: &str = "{apiKey}";
/// Google's word for a model that answers a chat; one that only embeds or
/// renders says otherwise in the same field and is not offered.
const CHAT_METHOD: &str = "generateContent";
const METHODS_FIELD: &str = "supportedGenerationMethods";

/// The models a service lists over HTTP. The key is never written anywhere:
/// errors name the template, not the URL that was fetched.
async fn listed_over_http(app: &AppHandle, config: &ProviderConfig) -> Result<Vec<ModelChoice>, String> {
    if config.models_url.is_empty() {
        return Ok(Vec::new());
    }
    let Some(url) = models_url_for(&config.models_url, || api_key_of(app, config)) else {
        return Ok(Vec::new()); // no key yet: the list waits for one
    };
    let client = crate::trackers::http::client().map_err(|e| e.to_string())?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("{}: {e}", config.models_url))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let said: String = body.trim().chars().take(300).collect();
        return Err(format!("{} answered {status}: {said}", config.models_url));
    }
    Ok(parse_listing(&body))
}

/// The URL to fetch, or None when it needs a key there is none of.
fn models_url_for(template: &str, key: impl FnOnce() -> Option<String>) -> Option<String> {
    if !template.contains(API_KEY_PLACEHOLDER) {
        return Some(template.to_string());
    }
    key()
        .filter(|key| !key.is_empty())
        .map(|key| template.replace(API_KEY_PLACEHOLDER, &key))
}

/// The key Aime keeps for the provider, or the one in the variable its CLI reads.
fn api_key_of(app: &AppHandle, config: &ProviderConfig) -> Option<String> {
    super::stored_key(app, &config.id).or_else(|| {
        (!config.api_key_env.is_empty())
            .then(|| std::env::var(&config.api_key_env).ok())
            .flatten()
    })
}

/// Fields a listing's objects name a model by, and label it by, most specific first.
const NAME_FIELDS: [&str; 5] = ["id", "slug", "model", "name", "value"];
const LABEL_FIELDS: [&str; 4] = ["displayName", "display_name", "label", "name"];

/// Models in whatever a CLI prints for them: a JSON array of names or of
/// objects, an object holding one such array, or plain lines whose first
/// word is the name and the rest its description.
fn parse_listing(text: &str) -> Vec<ModelChoice> {
    let from_json = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|json| model_array(&json).map(|items| items.iter().filter_map(model_from_json).collect()));
    without_shared_prefix(from_json.unwrap_or_else(|| text.lines().filter_map(model_from_line).collect()))
}

/// Google names models `models/gemini-2.5-pro` while its CLI takes
/// `gemini-2.5-pro`: a path segment every name shares is a resource prefix,
/// not part of the name. Names that differ in it (`openai/…`, `anthropic/…`)
/// keep it, since there it tells models apart.
fn without_shared_prefix(mut models: Vec<ModelChoice>) -> Vec<ModelChoice> {
    let Some(first) = models.first() else {
        return models;
    };
    let Some(slash) = first.value.find('/') else {
        return models;
    };
    let prefix = first.value[..=slash].to_string();
    if !models.iter().all(|model| model.value.starts_with(&prefix)) {
        return models;
    }
    for model in &mut models {
        let bare = model.value[prefix.len()..].to_string();
        if model.label == model.value {
            model.label = bare.clone();
        }
        model.value = bare;
    }
    models
}

fn model_array(json: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    match json {
        serde_json::Value::Array(items) => Some(items),
        serde_json::Value::Object(fields) => fields.values().find_map(|value| match value {
            serde_json::Value::Array(items) => Some(items),
            _ => None,
        }),
        _ => None,
    }
}

fn model_from_json(item: &serde_json::Value) -> Option<ModelChoice> {
    match item {
        serde_json::Value::String(name) => Some(ModelChoice {
            value: name.clone(),
            label: name.clone(),
            efforts: None,
        }),
        serde_json::Value::Object(fields) => {
            if let Some(serde_json::Value::Array(methods)) = fields.get(METHODS_FIELD) {
                if !methods.iter().any(|method| method.as_str() == Some(CHAT_METHOD)) {
                    return None;
                }
            }
            let text_of = |names: &[&str]| {
                names
                    .iter()
                    .find_map(|name| fields.get(*name).and_then(serde_json::Value::as_str))
                    .map(str::to_string)
            };
            let value = text_of(&NAME_FIELDS)?;
            let label = text_of(&LABEL_FIELDS).unwrap_or_else(|| value.clone());
            Some(ModelChoice {
                value,
                label,
                efforts: None,
            })
        }
        _ => None,
    }
}

/// `gemini-2.5-pro   Fast and capable` → that name with that description. A
/// line whose first word has neither a digit nor a dash - "Models:", "NAME" -
/// is a heading, not a model.
fn model_from_line(line: &str) -> Option<ModelChoice> {
    let line = line.trim().trim_start_matches(['-', '*', '•']).trim();
    let (name, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    let name_chars = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c));
    let versioned = name.chars().any(|c| c.is_ascii_digit() || c == '-');
    if name.is_empty() || !name_chars || !versioned {
        return None;
    }
    let description = rest.trim();
    Some(ModelChoice {
        value: name.to_string(),
        label: if description.is_empty() { name } else { description }.to_string(),
        efforts: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(value: &str, label: &str) -> ModelChoice {
        ModelChoice {
            value: value.to_string(),
            label: label.to_string(),
            efforts: None,
        }
    }

    #[test]
    fn a_configured_clis_listing_is_read_as_json_or_as_lines() {
        assert_eq!(
            parse_listing(r#"["gemini-2.5-pro", "gemini-2.5-flash"]"#),
            [
                choice("gemini-2.5-pro", "gemini-2.5-pro"),
                choice("gemini-2.5-flash", "gemini-2.5-flash")
            ]
        );
        assert_eq!(
            parse_listing(
                r#"{"object":"list","data":[{"id":"gpt-4.1","owned_by":"openai"},{"name":"o3","displayName":"o3 (reasoning)"}]}"#
            ),
            [choice("gpt-4.1", "gpt-4.1"), choice("o3", "o3 (reasoning)")]
        );
        assert_eq!(
            parse_listing(
                "Available models:
NAME            DESCRIPTION
- gemini-2.5-pro   Most capable
  gemini-2.5-flash

"
            ),
            [
                choice("gemini-2.5-pro", "Most capable"),
                choice("gemini-2.5-flash", "gemini-2.5-flash")
            ]
        );
        assert!(parse_listing("").is_empty());
    }

    #[test]
    fn googles_model_list_loses_its_resource_prefix_and_its_non_chat_models() {
        // The shape `GET /v1beta/models` documents (ai.google.dev/api/models, 2026-10-02).
        let text = r#"{"models":[
          {"name":"models/gemini-2.5-pro","displayName":"Gemini 2.5 Pro","supportedGenerationMethods":["generateContent","countTokens"]},
          {"name":"models/gemini-embedding-001","displayName":"Gemini Embedding","supportedGenerationMethods":["embedContent"]},
          {"name":"models/gemini-3.8-flash","displayName":"Gemini 3.8 Flash","supportedGenerationMethods":["generateContent"]}
        ],"nextPageToken":""}"#;
        assert_eq!(
            parse_listing(text),
            [
                choice("gemini-2.5-pro", "Gemini 2.5 Pro"),
                choice("gemini-3.8-flash", "Gemini 3.8 Flash")
            ]
        );
        // A prefix that tells models apart is part of the name.
        assert_eq!(
            parse_listing(r#"["openai/gpt-4o", "anthropic/claude-opus-5"]"#),
            [
                choice("openai/gpt-4o", "openai/gpt-4o"),
                choice("anthropic/claude-opus-5", "anthropic/claude-opus-5")
            ]
        );
    }

    #[test]
    fn the_endpoint_is_fetched_only_once_there_is_a_key_for_it() {
        let template = "https://example.test/v1/models?key={apiKey}";
        assert_eq!(models_url_for(template, || None), None);
        assert_eq!(models_url_for(template, || Some(String::new())), None);
        assert_eq!(
            models_url_for(template, || Some("k-1".to_string())).as_deref(),
            Some("https://example.test/v1/models?key=k-1")
        );
        assert_eq!(
            models_url_for("https://example.test/models", || None).as_deref(),
            Some("https://example.test/models")
        );
    }

    fn id(family: &str, major: u32, minor: Option<u32>) -> ModelId {
        ModelId {
            family: family.to_string(),
            major,
            minor,
        }
    }

    #[test]
    fn a_binary_yields_its_model_names_and_not_their_snapshots() {
        // The shapes seen in claude.exe 2.1.287, each with what follows it there.
        let bytes = concat!(
            "x\"claude-opus-5-5\",\"claude-opus-5\"}claude-sonnet-5-5'claude-fable-5-1[1m]",
            "claude-opus-4-1-20250805 claude-sonnet-4-5-20250929-v1 claude-opus-4-6-v1",
            "claude-haiku-4-5-20251001 claude-haiku-4-5\n claude-3-opus claude-opus-latest",
        )
        .as_bytes();
        let found: Vec<ModelId> = scan(bytes).into_iter().collect();
        assert_eq!(
            found,
            [
                id("fable", 5, Some(1)),
                id("opus", 5, Some(5)),
                id("opus", 5, None),
                id("sonnet", 5, Some(5)),
                id("haiku", 4, Some(5)),
            ]
        );
    }

    #[test]
    fn a_name_split_across_two_reads_is_still_found() {
        let dir = std::env::temp_dir().join("aime-catalog-test-split");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("bundle.js");
        let mut bytes = vec![b'.'; CHUNK_BYTES - 5];
        bytes.extend_from_slice(b"claude-sonnet-5-5\" tail");
        fs::write(&file, bytes).expect("fixture");

        let found = scan_file(&file).expect("scanned");
        assert_eq!(found.into_iter().collect::<Vec<_>>(), [id("sonnet", 5, Some(5))]);
    }

    #[test]
    fn the_scan_is_cached_by_the_binary_and_redone_when_it_changes() {
        let dir = std::env::temp_dir().join("aime-catalog-test-cache");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let (binary, cache) = (dir.join("claude.exe"), dir.join("cache/claude.json"));
        fs::write(&binary, b"claude-opus-5-5").expect("binary");

        let first = scanned_with_cache(&binary, &cache).expect("scanned");
        assert_eq!(first.len(), 1);
        let record: CachedScan =
            serde_json::from_str(&fs::read_to_string(&cache).expect("cache written")).expect("record");
        assert_eq!(record.models, [id("opus", 5, Some(5))]);

        // A different file at the same path: the cache no longer applies.
        fs::write(&binary, b"claude-opus-5-5 claude-opus-6-0 padding").expect("updated binary");
        let second = scanned_with_cache(&binary, &cache).expect("rescanned");
        assert_eq!(second.len(), 2);
    }

    #[test]
    fn the_newest_generation_is_offered_whole_and_the_one_before_by_its_last_release() {
        let found: BTreeSet<ModelId> = [
            id("opus", 5, Some(5)),
            id("opus", 5, None),
            id("opus", 4, Some(8)),
            id("opus", 4, Some(7)),
            id("opus", 4, Some(1)),
            id("opus", 3, None),
            id("sonnet", 5, Some(5)),
            id("sonnet", 4, Some(6)),
            id("sonnet", 3, Some(7)),
            id("haiku", 4, Some(5)),
            id("fable", 5, Some(1)),
            id("fable", 5, None),
        ]
        .into_iter()
        .collect();
        let labels: Vec<(String, String)> = pinned(&found)
            .into_iter()
            .map(|choice| (choice.value, choice.label))
            .collect();
        assert_eq!(
            labels,
            [
                ("claude-fable-5-1".to_string(), "Fable 5.1".to_string()),
                ("claude-fable-5".to_string(), "Fable 5".to_string()),
                ("claude-opus-5-5".to_string(), "Opus 5.5".to_string()),
                ("claude-opus-5".to_string(), "Opus 5".to_string()),
                ("claude-opus-4-8".to_string(), "Opus 4.8".to_string()),
                ("claude-sonnet-5-5".to_string(), "Sonnet 5.5".to_string()),
                ("claude-sonnet-4-6".to_string(), "Sonnet 4.6".to_string()),
                ("claude-haiku-4-5".to_string(), "Haiku 4.5".to_string()),
            ]
        );
    }

    #[test]
    fn the_servers_extra_options_are_labelled_with_their_version() {
        // Captured from ~/.claude.json on 2026-10-02.
        let dir = std::env::temp_dir().join("aime-catalog-test-extra");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let config = dir.join(".claude.json");
        fs::write(
            &config,
            r#"{"numStartups":3,"additionalModelOptionsCache":[{"value":"claude-fable-5-1[1m]","label":"Fable","description":"Fable 5.1 · Most capable for your hardest and longest-running tasks"}],"modelAccessCache":[]}"#,
        )
        .expect("config");

        let extra = additional_options(&config);
        assert_eq!(
            extra,
            [ModelChoice {
                value: "claude-fable-5-1[1m]".to_string(),
                label: "Fable 5.1 · 1M context".to_string(),
                efforts: None,
            }]
        );
        assert!(additional_options(&dir.join("missing.json")).is_empty());
    }

    #[test]
    fn the_codex_catalog_keeps_the_listed_models_with_their_reasoning_levels() {
        // Trimmed from `codex debug models` on 0.146.0 (2026-10-02).
        let text = r#"{"models":[
          {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide",
           "supported_reasoning_levels":[{"effort":"low","description":""}]},
          {"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra","visibility":"list",
           "supported_reasoning_levels":[{"effort":"low","description":""},{"effort":"medium","description":""},{"effort":"ultra","description":""}]},
          {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","supported_reasoning_levels":[]}
        ]}"#;
        let listed = parse_codex_catalog(text).expect("parsed");
        assert_eq!(
            listed,
            [
                ModelChoice {
                    value: "gpt-5.6-terra".to_string(),
                    label: "GPT-5.6-Terra".to_string(),
                    efforts: Some(vec!["low".to_string(), "medium".to_string(), "ultra".to_string()]),
                },
                ModelChoice {
                    value: "gpt-5.5".to_string(),
                    label: "GPT-5.5".to_string(),
                    efforts: Some(Vec::new()),
                },
            ]
        );
        assert!(parse_codex_catalog("not json").is_err());
    }

    /// Reads the Claude Code installed on this machine; run by hand with
    /// `cargo test real_claude -- --ignored --nocapture` to see what it offers.
    #[test]
    #[ignore]
    fn real_claude_binary_on_this_machine() {
        let binary = claude_program().expect("claude on PATH");
        let started = std::time::Instant::now();
        let found = scan_file(&binary).expect("scanned");
        println!("{} in {:?}", binary.display(), started.elapsed());
        for id in &found {
            println!("  {}", id.value());
        }
        for choice in pinned(&found) {
            println!("pinned: {} = {}", choice.label, choice.value);
        }
        for choice in additional_options(&claude_config_path()) {
            println!("extra: {} = {}", choice.label, choice.value);
        }
    }
}
