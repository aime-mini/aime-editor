//! Any AI CLI, described in `providers.json` instead of in Rust.
//!
//! Claude and Codex are built in because Aime speaks their event streams
//! precisely. Everything else - a new CLI, a company's internal one, an early
//! build - should not need a Rust change to be usable, so this adapter reads a
//! description and drives the command it names (ARCHITECTURE.md §4, §7).
//!
//! The file is re-read whenever it changes (`fs_watch::watch_providers_config`),
//! so a CLI added while Aime runs is usable straight away. Adapters are shared
//! `Arc`s for that reason: a turn already streaming keeps the adapter it started
//! with, whatever the file says a moment later.

use super::adapter::{
    explicit, Adapter, ApiKeyRoute, Invocation, Permission, TurnRequest, PROGRESS_MEMORY_PROMPT,
};
use crate::mcp::{McpServer, McpServerSpec};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, RwLockWriteGuard};

/// Placeholders Aime substitutes in the configured argument lists.
const PROMPT_PLACEHOLDER: &str = "{prompt}";
const SESSION_PLACEHOLDER: &str = "{sessionId}";
const MODEL_PLACEHOLDER: &str = "{model}";

/// How a CLI's stdout should be read.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ParserKind {
    /// Everything the CLI prints is the answer. Works with any CLI at all.
    #[default]
    Plain,
    /// One JSON object per line; `textField` names the field carrying text.
    Jsonl,
}

/// How this CLI finds the project's knowledge (ARCHITECTURE.md §4).
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryStrategy {
    /// The CLI reads a file of its own; Aime keeps it pointing at AGENTS.md.
    Native,
    /// The CLI's context filename is configurable; the user points it at AGENTS.md.
    ConfigPointer,
    /// Nothing native: Aime prepends the project's knowledge to the prompt.
    #[default]
    PromptInject,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub display_name: String,
    pub command: String,
    /// Arguments for one turn; `{prompt}` and `{model}` are substituted.
    pub args: Vec<String>,
    /// Appended when continuing a conversation; `{sessionId}` is substituted.
    #[serde(default)]
    pub resume_args: Vec<String>,
    #[serde(default)]
    pub parser: ParserKind,
    /// For `jsonl`: the field carrying assistant text.
    #[serde(default = "default_text_field")]
    pub text_field: String,
    /// Command that signs the user in, run in a terminal on request.
    #[serde(default)]
    pub login: String,
    /// Shown when the CLI is missing.
    #[serde(default)]
    pub install: String,
    #[serde(default)]
    pub memory: MemoryStrategy,
    /// The CLI's own user-level memory file, relative to the home directory.
    #[serde(default)]
    pub memory_file: String,
    /// Send the prompt on stdin instead of substituting `{prompt}`. Strongly
    /// preferred where the CLI supports it: on Windows a prompt passed as an
    /// argument loses everything after its first line (see `Invocation`).
    #[serde(default)]
    pub prompt_stdin: bool,
    /// Environment variable this CLI reads an API key from (e.g.
    /// `GEMINI_API_KEY`). Empty = the Settings page offers no key field for it.
    #[serde(default)]
    pub api_key_env: String,
    /// Arguments of the CLI's own "take this key" command, for a CLI that
    /// stores keys itself instead of reading a variable (e.g.
    /// `["login", "--with-api-key"]`). Aime pipes the key to its stdin and
    /// keeps no copy. `apiKeyEnv` wins if a config sets both, since a variable
    /// costs nothing and changes nothing the CLI has stored.
    #[serde(default)]
    pub api_key_login_args: Vec<String>,
}

fn default_text_field() -> String {
    "text".to_string()
}

/// Adapter over one configured CLI.
pub struct GenericAdapter {
    pub config: ProviderConfig,
}

/// A prompt-inject provider gets the project's knowledge in the prompt, since
/// it has no memory convention of its own. Capped, because it rides along on
/// every single turn.
const INJECTED_MEMORY_LIMIT: usize = 8_000;

/// Reads the canonical project memory for the `prompt-inject` strategy.
fn project_memory(cwd: &str) -> Option<String> {
    let text = std::fs::read_to_string(Path::new(cwd).join("AGENTS.md")).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(INJECTED_MEMORY_LIMIT).collect())
}

/// Substitutes placeholders, dropping arguments whose value is empty so a
/// config can carry optional flags without producing empty arguments.
fn expand(args: &[String], prompt: &str, session_id: Option<&str>, model: Option<&str>) -> Vec<String> {
    let mut expanded = Vec::with_capacity(args.len());
    for arg in args {
        if arg.contains(MODEL_PLACEHOLDER) && explicit(model).is_none() {
            continue; // the flag exists only to carry a model that was not chosen
        }
        expanded.push(
            arg.replace(PROMPT_PLACEHOLDER, prompt)
                .replace(SESSION_PLACEHOLDER, session_id.unwrap_or_default())
                .replace(MODEL_PLACEHOLDER, model.unwrap_or_default()),
        );
    }
    expanded
}

impl GenericAdapter {
    /// Hands the prompt over the channel this CLI was configured for.
    fn deliver(&self, args: Vec<String>, prompt: String) -> Invocation {
        if self.config.prompt_stdin {
            Invocation::piped(args, prompt)
        } else {
            Invocation::plain(args)
        }
    }
}

impl Adapter for GenericAdapter {
    fn command(&self) -> &str {
        &self.config.command
    }

    fn chat_invocation(&self, req: &TurnRequest<'_>) -> Invocation {
        // An unknown CLI has no permission flags to map onto and no
        // system-prompt hook, so everything Aime needs it to know travels in
        // the prompt - the one channel every CLI accepts.
        let mut preamble = String::from(PROGRESS_MEMORY_PROMPT);
        if req.permission == Permission::ReadOnly {
            preamble.push_str(
                "\n\nDo not modify any file and do not run any command that changes state. \
                 Read and explain only.",
            );
        }
        // Native and config-pointer CLIs read AGENTS.md themselves; only the
        // universal fallback has to carry it (ARCHITECTURE.md §4).
        if self.config.memory == MemoryStrategy::PromptInject {
            if let Some(memory) = project_memory(req.cwd) {
                preamble.push_str("\n\nProject knowledge (AGENTS.md):\n");
                preamble.push_str(&memory);
            }
        }
        let prompt = format!("{preamble}\n\n---\n\n{}", req.prompt);

        let mut args = expand(&self.config.args, &prompt, req.session_id, req.model);
        if let Some(session_id) = req.session_id {
            args.extend(expand(
                &self.config.resume_args,
                &prompt,
                Some(session_id),
                req.model,
            ));
        }
        self.deliver(args, prompt)
    }

    fn oneshot_invocation(&self, prompt: &str, model: Option<&str>) -> Invocation {
        self.deliver(expand(&self.config.args, prompt, None, model), prompt.to_string())
    }

    fn parse_oneshot(&self, stdout: &str) -> Result<String, String> {
        let answer = match self.config.parser {
            ParserKind::Plain => stdout.trim().to_string(),
            ParserKind::Jsonl => stdout
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter_map(|event| {
                    event
                        .get(&self.config.text_field)
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
                .join(""),
        };
        if answer.is_empty() {
            return Err("CLI returned no result".into());
        }
        Ok(answer)
    }

    fn auth_probe_args(&self) -> Option<&'static [&'static str]> {
        None // an unknown CLI has no probe Aime could trust
    }

    fn api_key_route(&self) -> Option<ApiKeyRoute> {
        if !self.config.api_key_env.is_empty() {
            return Some(ApiKeyRoute::Env {
                variable: self.config.api_key_env.clone(),
            });
        }
        if !self.config.api_key_login_args.is_empty() {
            return Some(ApiKeyRoute::CliLogin {
                args: self.config.api_key_login_args.clone(),
            });
        }
        None
    }

    fn login_command(&self) -> String {
        self.config.login.clone()
    }

    fn global_memory_path(&self, home: &Path) -> PathBuf {
        if self.config.memory_file.is_empty() {
            home.join(".aime").join("AGENTS.md")
        } else {
            home.join(&self.config.memory_file)
        }
    }

    // MCP is a convention of the CLIs that implement it; a configured one is
    // not assumed to. The UI shows an empty list rather than inventing flags.
    fn mcp_list_args(&self) -> Vec<String> {
        Vec::new()
    }

    fn parse_mcp_list(&self, _stdout: &str) -> Vec<McpServer> {
        Vec::new()
    }

    fn mcp_add_args(&self, _spec: &McpServerSpec) -> Vec<String> {
        Vec::new()
    }

    fn mcp_remove_args(&self, _name: &str) -> Vec<String> {
        Vec::new()
    }

    fn mcp_login_command(&self, _name: &str) -> String {
        String::new()
    }
}

/// The providers currently described by `providers.json`.
///
/// Replaceable, because the file is: the user (or the agent, on their behalf)
/// adds a CLI while Aime is running and expects to see it. Adapters are handed
/// out as `Arc`s so a turn that is already streaming keeps the adapter it
/// started with even if the list is swapped underneath it.
static CONFIGURED: RwLock<Vec<Arc<GenericAdapter>>> = RwLock::new(Vec::new());

/// Reads `providers.json` next to the app's own config. A malformed file must
/// not cost the user their built-in providers, so it degrades to none.
pub fn load(path: &Path) -> Vec<Arc<GenericAdapter>> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let configs: Vec<ProviderConfig> = serde_json::from_str(&text).unwrap_or_else(|err| {
        eprintln!("providers.json ignored: {err}");
        Vec::new()
    });
    configs
        .into_iter()
        .filter(|config| !config.id.is_empty() && !config.command.is_empty())
        .map(|config| Arc::new(GenericAdapter { config }))
        .collect()
}

/// Publishes a freshly read `providers.json`, replacing whatever was there.
pub fn install(adapters: Vec<Arc<GenericAdapter>>) {
    *guard() = adapters;
}

pub fn configured() -> Vec<Arc<GenericAdapter>> {
    guard().clone()
}

pub fn find(id: &str) -> Option<Arc<GenericAdapter>> {
    guard()
        .iter()
        .find(|adapter| adapter.config.id == id)
        .map(Arc::clone)
}

/// A poisoned lock still holds a valid provider list — recovering it keeps the
/// AI panel working, where panicking would take every provider down with it.
fn guard() -> RwLockWriteGuard<'static, Vec<Arc<GenericAdapter>>> {
    CONFIGURED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{expand, GenericAdapter, MemoryStrategy, ParserKind, ProviderConfig};
    use crate::providers::adapter::{Adapter, ApiKeyRoute, Permission, TurnRequest};

    fn adapter(args: &[&str], resume: &[&str], parser: ParserKind) -> GenericAdapter {
        GenericAdapter {
            config: ProviderConfig {
                id: "demo".into(),
                display_name: "Demo".into(),
                command: "demo-cli".into(),
                args: args.iter().map(|a| (*a).to_string()).collect(),
                resume_args: resume.iter().map(|a| (*a).to_string()).collect(),
                parser,
                text_field: "text".into(),
                login: "demo-cli login".into(),
                install: String::new(),
                memory: super::MemoryStrategy::default(),
                memory_file: String::new(),
                prompt_stdin: false,
                api_key_env: String::new(),
                api_key_login_args: Vec::new(),
            },
        }
    }

    #[test]
    fn a_configured_cli_can_take_a_key_either_way_and_neither_by_default() {
        let mut by_variable = adapter(&["{prompt}"], &[], ParserKind::Plain);
        by_variable.config.api_key_env = "GEMINI_API_KEY".into();
        assert_eq!(
            by_variable.api_key_route(),
            Some(ApiKeyRoute::Env {
                variable: "GEMINI_API_KEY".into()
            })
        );

        let mut by_login = adapter(&["{prompt}"], &[], ParserKind::Plain);
        by_login.config.api_key_login_args = vec!["login".into(), "--with-api-key".into()];
        assert_eq!(
            by_login.api_key_route(),
            Some(ApiKeyRoute::CliLogin {
                args: vec!["login".into(), "--with-api-key".into()]
            })
        );

        // Both configured: the variable wins, because it changes nothing the
        // CLI has stored.
        let mut both = by_login;
        both.config.api_key_env = "GEMINI_API_KEY".into();
        assert!(matches!(both.api_key_route(), Some(ApiKeyRoute::Env { .. })));

        let neither = adapter(&["{prompt}"], &[], ParserKind::Plain);
        assert_eq!(
            neither.api_key_route(),
            None,
            "nothing configured, no key field offered"
        );
    }

    fn turn<'a>(prompt: &'a str, session_id: Option<&'a str>) -> TurnRequest<'a> {
        TurnRequest {
            prompt,
            cwd: "",
            session_id,
            model: None,
            effort: None,
            permission: Permission::Full,
        }
    }

    #[test]
    fn the_prompt_lands_where_the_config_puts_it() {
        let args = adapter(&["chat", "--input", "{prompt}"], &[], ParserKind::Plain)
            .chat_invocation(&turn("hello", None))
            .args;
        assert_eq!(args[0], "chat");
        assert_eq!(args[1], "--input");
        assert!(args[2].ends_with("hello"), "prompt is substituted, not appended");
    }

    #[test]
    fn the_journal_rule_travels_with_the_prompt() {
        let args = adapter(&["{prompt}"], &[], ParserKind::Plain)
            .chat_invocation(&turn("do it", None))
            .args;
        assert!(args[0].contains(".aime/PROGRESS.md"));
    }

    #[test]
    fn read_only_is_expressed_in_words_when_there_are_no_flags_to_use() {
        let request = TurnRequest {
            permission: Permission::ReadOnly,
            ..turn("explain", None)
        };
        let args = adapter(&["{prompt}"], &[], ParserKind::Plain)
            .chat_invocation(&request)
            .args;
        assert!(args[0].contains("Read and explain only"));
    }

    #[test]
    fn only_the_fallback_strategy_carries_project_knowledge_in_the_prompt() {
        let workspace = std::env::temp_dir().join("aime-generic-memory-test");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("AGENTS.md"), "Prefer tabs over spaces.").expect("memory file");
        let cwd = workspace.to_string_lossy().to_string();
        let request = TurnRequest {
            cwd: &cwd,
            ..turn("go", None)
        };

        let mut injecting = adapter(&["{prompt}"], &[], ParserKind::Plain);
        injecting.config.memory = MemoryStrategy::PromptInject;
        assert!(injecting.chat_invocation(&request).args[0].contains("Prefer tabs over spaces."));

        // A CLI that reads AGENTS.md itself must not be told it twice.
        let mut native = adapter(&["{prompt}"], &[], ParserKind::Plain);
        native.config.memory = MemoryStrategy::Native;
        assert!(!native.chat_invocation(&request).args[0].contains("Prefer tabs over spaces."));

        std::fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn a_stdin_provider_gets_the_prompt_on_stdin_and_not_in_its_arguments() {
        let mut piped = adapter(&["chat"], &[], ParserKind::Plain);
        piped.config.prompt_stdin = true;
        let call = piped.chat_invocation(&turn("hello", None));
        assert_eq!(call.args, vec!["chat".to_string()]);
        assert!(call.stdin.expect("prompt on stdin").ends_with("hello"));
    }

    #[test]
    fn resume_arguments_only_appear_for_a_continued_conversation() {
        let generic = adapter(&["{prompt}"], &["--resume", "{sessionId}"], ParserKind::Plain);
        assert_eq!(generic.chat_invocation(&turn("hi", None)).args.len(), 1);

        let resumed = generic.chat_invocation(&turn("hi", Some("abc"))).args;
        assert_eq!(resumed[1], "--resume");
        assert_eq!(resumed[2], "abc");
    }

    #[test]
    fn a_model_flag_disappears_when_no_model_was_chosen() {
        let with_model = expand(
            &["--model".to_string(), "{model}".to_string()],
            "p",
            None,
            Some("fast"),
        );
        assert_eq!(with_model, vec!["--model", "fast"]);
        assert!(
            expand(&["--model".to_string(), "{model}".to_string()], "p", None, None)
                .iter()
                .all(|arg| arg != "{model}")
        );
    }

    #[test]
    fn plain_output_is_the_answer_and_jsonl_is_assembled() {
        assert_eq!(
            adapter(&[], &[], ParserKind::Plain)
                .parse_oneshot("  the answer \n")
                .expect("plain output parses"),
            "the answer"
        );
        let jsonl = "{\"text\":\"par\"}\n{\"other\":1}\n{\"text\":\"tial\"}";
        assert_eq!(
            adapter(&[], &[], ParserKind::Jsonl)
                .parse_oneshot(jsonl)
                .expect("jsonl output parses"),
            "partial"
        );
    }

    #[test]
    fn an_empty_answer_is_an_error_rather_than_an_empty_message() {
        assert!(adapter(&[], &[], ParserKind::Plain).parse_oneshot("   ").is_err());
    }
}
