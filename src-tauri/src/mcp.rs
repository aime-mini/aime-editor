//! MCP servers (ARCHITECTURE.md §7). Each AI CLI already owns its MCP
//! configuration, health checks and OAuth, so Aime drives those commands
//! instead of writing config files behind the CLI's back — one place where
//! servers live, whichever tool edits them.

use crate::providers::adapter::adapter_for;
use crate::providers::cli_command;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// URL of an HTTP server, or the command line of a stdio one.
    pub target: String,
    /// What the CLI reports about the server (health, sign-in); may be empty.
    pub status: String,
}

/// A server the user is adding, as typed in the UI.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSpec {
    pub name: String,
    /// An `http(s)://` URL, or the command line that launches the server.
    pub target: String,
    /// `KEY=VALUE` pairs, only meaningful for stdio servers.
    #[serde(default)]
    pub env: Vec<String>,
}

impl McpServerSpec {
    pub fn is_http(&self) -> bool {
        let target = self.target.trim_start();
        target.starts_with("http://") || target.starts_with("https://")
    }
}

/// Splits a command line into arguments, keeping double-quoted groups whole —
/// MCP commands routinely carry paths with spaces.
pub fn tokenize_command(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in command.chars() {
        match character {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Runs an MCP command of the given CLI. `cwd` is the workspace when one is
/// open — Claude Code resolves project-scoped servers relative to it — and
/// `None` falls back to the app's own directory, where only global servers exist.
async fn run_cli(provider_id: &str, args: Vec<String>, cwd: Option<&str>) -> Result<String, String> {
    let adapter = adapter_for(provider_id)?;
    let mut command = cli_command(adapter.command(), &args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .await
        .map_err(|e| format!("CLI_MISSING::{provider_id}::{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Servers the selected CLI has configured.
#[tauri::command]
pub async fn mcp_list(provider_id: String, cwd: Option<String>) -> Result<Vec<McpServer>, String> {
    let adapter = adapter_for(&provider_id)?;
    let stdout = run_cli(&provider_id, adapter.mcp_list_args(), cwd.as_deref()).await?;
    Ok(adapter.parse_mcp_list(&stdout))
}

#[tauri::command]
pub async fn mcp_add(provider_id: String, cwd: Option<String>, spec: McpServerSpec) -> Result<(), String> {
    let adapter = adapter_for(&provider_id)?;
    run_cli(&provider_id, adapter.mcp_add_args(&spec), cwd.as_deref()).await?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_remove(provider_id: String, cwd: Option<String>, name: String) -> Result<(), String> {
    let adapter = adapter_for(&provider_id)?;
    run_cli(&provider_id, adapter.mcp_remove_args(&name), cwd.as_deref()).await?;
    Ok(())
}

/// The command that signs in to an MCP server; Aime runs it in a terminal,
/// like every other interactive CLI flow.
#[tauri::command]
pub fn mcp_login_command(provider_id: String, name: String) -> Result<String, String> {
    Ok(adapter_for(&provider_id)?.mcp_login_command(&name))
}

#[cfg(test)]
mod tests {
    use super::{tokenize_command, McpServerSpec};

    fn spec(target: &str) -> McpServerSpec {
        McpServerSpec {
            name: "srv".into(),
            target: target.into(),
            env: Vec::new(),
        }
    }

    #[test]
    fn urls_are_http_servers_and_commands_are_not() {
        assert!(spec("https://mcp.example.com/mcp").is_http());
        assert!(spec("  http://localhost:3000").is_http());
        assert!(!spec("npx -y @modelcontextprotocol/server-github").is_http());
        assert!(!spec("./httpserver").is_http());
    }

    #[test]
    fn a_command_line_splits_on_spaces() {
        assert_eq!(
            tokenize_command("npx -y @modelcontextprotocol/server-github"),
            vec!["npx", "-y", "@modelcontextprotocol/server-github"]
        );
    }

    #[test]
    fn quoted_arguments_stay_whole() {
        assert_eq!(
            tokenize_command(r#"node "C:\My Servers\index.js" --root ."#),
            vec!["node", r"C:\My Servers\index.js", "--root", "."]
        );
    }

    #[test]
    fn extra_whitespace_produces_no_empty_arguments() {
        assert_eq!(tokenize_command("  npx   server  "), vec!["npx", "server"]);
        assert!(tokenize_command("   ").is_empty());
    }
}
