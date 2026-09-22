//! The command tree a CLI writes down for a shell, read back as a vocabulary.
//!
//! Why this exists. A model asked what can be done to a resource answers from
//! what it remembers of a CLI, and what it remembers can be a command that was
//! never there. Measured in the app 2026-09-21 on a Supabase database: three
//! operations, all three under a `postgres` group this CLI does not have, all
//! three refused, and a pane with nothing on it. AWS never has that problem
//! because its own models sit beside the binary and travel with the question
//! (`reads.rs`, `AwsCatalog`); Supabase needed the same thing.
//!
//! Where it comes from. `supabase --help` lists the 34 top-level groups and
//! nothing below them, and the second level is where the next guess goes wrong
//! (`backups create`, `postgres-config set` - measured, both refused). Asking
//! the CLI group by group would be 34 processes. But the same CLI writes its
//! whole tree in ONE answer for a shell to complete against - `--completions
//! bash`, 141 KB, 158 functions on 2.116.0 - and that answer is exact: a
//! dispatch arm per real word, pointing at the function for the level below.
//!
//! What is parsed, and nothing more. Each function's `# Subcommand dispatch`
//! block, whose arms read `list)` then `_supabase_backups_list "$i"`; the word
//! is the command as a person types it and the function is where its children
//! are. Function NAMES are not paths - `_supabase_encryption_get_root_key` is
//! `encryption get-root-key`, and a hyphen cannot be told from a separator -
//! so the words come off the arms and the names are used only as keys.

use std::collections::HashMap;

/// The marker that begins the block naming a level's subcommands.
const DISPATCH: &str = "# Subcommand dispatch";

/// Every command the completion script describes, deepest path included,
/// each one spelled as it is typed: `backups list`, `encryption get-root-key`.
///
/// Empty when the script is not one - a CLI that does not offer completions,
/// or an answer that is an error message. The caller falls back to whatever it
/// had before rather than treating an empty vocabulary as "this CLI has no
/// commands".
pub(super) fn commands_in(script: &str, root: &str) -> Vec<String> {
    let children = dispatch_table(script);
    let mut commands = Vec::new();
    walk(&children, root, &[], &mut commands);
    commands
}

/// Which words each completion function dispatches on, and where each leads.
fn dispatch_table(script: &str) -> HashMap<String, Vec<(String, String)>> {
    let mut table: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut function = String::new();
    let mut dispatching = false;
    let mut word: Option<String> = None;

    for line in script.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_suffix("()") {
            function = name.to_string();
            dispatching = false;
            word = None;
            continue;
        }
        if trimmed == DISPATCH {
            dispatching = true;
            continue;
        }
        if !dispatching {
            continue;
        }
        if trimmed == "esac" {
            dispatching = false;
            continue;
        }
        // A case arm: one word and a closing bracket. Flag-value arms start
        // with a dash and belong to a different `case` altogether.
        if let Some(arm) = trimmed.strip_suffix(')') {
            if !arm.is_empty() && !arm.starts_with('-') && !arm.contains(['(', '"', '$', '|']) {
                word = Some(arm.to_string());
                continue;
            }
        }
        // The line under the arm names the function for the level below - the
        // line UNDER it and no other: an arm whose next line is something else
        // is an arm with no level below, and pairing it with whatever function
        // call came later would invent a command.
        let child = trimmed
            .starts_with('_')
            .then(|| trimmed.split_whitespace().next().unwrap_or_default());
        if let (Some(found), Some(child)) = (word.take(), child) {
            table
                .entry(function.clone())
                .or_default()
                .push((found, child.to_string()));
        }
    }
    table
}

/// Every path under one function, in the order the CLI listed them.
fn walk(
    children: &HashMap<String, Vec<(String, String)>>,
    function: &str,
    path: &[String],
    commands: &mut Vec<String>,
) {
    let Some(arms) = children.get(function) else {
        return;
    };
    for (word, child) in arms {
        let mut here = path.to_vec();
        here.push(word.clone());
        commands.push(here.join(" "));
        // A tree written by a program cannot loop, but a file read off disk is
        // input: without this a cycle would recurse until the stack ran out.
        if here.len() < MAX_DEPTH {
            walk(children, child, &here, commands);
        }
    }
}

/// Deeper than any CLI goes - `supabase inspect db table-stats` is three.
const MAX_DEPTH: usize = 6;

#[cfg(test)]
mod tests {
    use super::*;

    /// Cut from the 141 KB `supabase --completions bash` really printed on
    /// this machine (2.116.0, captured 2026-09-21): the root's dispatch, a
    /// group with children, a group whose child has children of its own, and
    /// a leaf that carries a flag-value `case` of the kind that must not be
    /// read as a subcommand.
    const SCRIPT: &str = r#"
_supabase()
{
  local cur prev words cword i

  # Subcommand dispatch
  local cmd _skip_next=0
  for ((i = _command_index + 1; i < cword; i++)); do
    case "${words[i]}" in
      backups)
        _supabase_backups "$i"
        return
        ;;
      encryption)
        _supabase_encryption "$i"
        return
        ;;
      inspect)
        _supabase_inspect "$i"
        return
        ;;
    esac
  done

  COMPREPLY=( $(compgen -W 'backups encryption inspect' -- "$cur") )
}

_supabase_backups()
{
  # Subcommand dispatch
  for ((i = _command_index + 1; i < cword; i++)); do
    case "${words[i]}" in
      list)
        _supabase_backups_list "$i"
        return
        ;;
      restore)
        _supabase_backups_restore "$i"
        return
        ;;
    esac
  done
}

_supabase_backups_list()
{
  # Flag value completions
  case "$prev" in
    --project-ref)
      COMPREPLY=()
      return
      ;;
  esac
}

_supabase_encryption()
{
  # Subcommand dispatch
  for ((i = _command_index + 1; i < cword; i++)); do
    case "${words[i]}" in
      get-root-key)
        _supabase_encryption_get_root_key "$i"
        return
        ;;
    esac
  done
}

_supabase_inspect()
{
  # Subcommand dispatch
  for ((i = _command_index + 1; i < cword; i++)); do
    case "${words[i]}" in
      db)
        _supabase_inspect_db "$i"
        return
        ;;
    esac
  done
}

_supabase_inspect_db()
{
  # Subcommand dispatch
  for ((i = _command_index + 1; i < cword; i++)); do
    case "${words[i]}" in
      table-stats)
        _supabase_inspect_db_table_stats "$i"
        return
        ;;
    esac
  done
}
"#;

    #[test]
    fn every_level_of_the_tree_is_read_as_a_person_would_type_it() {
        assert_eq!(
            commands_in(SCRIPT, "_supabase"),
            [
                "backups",
                "backups list",
                "backups restore",
                "encryption",
                // The function is `_supabase_encryption_get_root_key`; the
                // command has a hyphen, which is why the words come off the
                // dispatch arms and never off a function name.
                "encryption get-root-key",
                "inspect",
                "inspect db",
                "inspect db table-stats",
            ]
        );
    }

    #[test]
    fn a_flag_value_case_is_not_mistaken_for_a_subcommand() {
        let commands = commands_in(SCRIPT, "_supabase");
        assert!(
            !commands.iter().any(|command| command.contains("--project-ref")),
            "{commands:?}"
        );
    }

    #[test]
    fn anything_that_is_not_a_completion_script_is_no_vocabulary_at_all() {
        assert!(commands_in("", "_supabase").is_empty());
        assert!(commands_in("Unknown option: --completions\n", "_supabase").is_empty());
        assert!(
            commands_in(SCRIPT, "_something_else").is_empty(),
            "a root nobody wrote is not guessed at"
        );
    }
}
