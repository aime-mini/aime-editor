//! Reading BigQuery - the part of a Google Cloud account `gcloud` cannot read.
//!
//! Measured 2026-09-11 over a real Google account: of the 20 kinds of resource
//! in it, 8 have no `gcloud` read at all, and BigQuery is the one a developer
//! opens most - `gcloud` has no `bigquery` command group whatsoever. BigQuery's
//! own CLI answers those kinds, and it is already here: `bq` ships INSIDE the
//! Cloud SDK, in the same `bin` folder as `gcloud`, so a machine that can list
//! a dataset can read one. Nothing is installed and nothing is downloaded.
//!
//! Four things about `bq` differ from `gcloud`, and every one of them was
//! measured on this machine rather than recalled - the captured bytes are this
//! module's fixtures:
//!
//! - **Its help exits 1, always, and answers on stdout.** `bq help show`
//!   describes a real command in 10,586 bytes of stdout, writes nothing at all
//!   to stderr, and exits 1 - so the exit code that proves a `gcloud` command
//!   exists proves nothing here, and the usual reader would throw the answer
//!   away as a failure. What it SAYS is the proof: the line after its USAGE
//!   block begins with the command being described, and for a command `bq`
//!   does not have, that line reads `Any of the following commands:` instead.
//! - **Its commands are one word** - `show`, `ls`, `head` - where a `gcloud`
//!   command is a tree of them.
//! - **Its flags carry underscores** (`--project_id`, `--max_results`), which
//!   no other CLI here does.
//! - **Its flags must come before the command's arguments.** `bq show cars
//!   --project_id p` answers *FATAL Flags positioning error: Flag
//!   '--project_id' appears after final command line argument* - so the scope
//!   Aime adds is prepended as the global flags `bq`'s own usage line calls
//!   for, never appended the way every other CLI here takes it.

use super::read_cli_output;

/// The one command `bq` is spoken to by.
pub(super) const PROGRAM: &str = "bq";

/// The prefix of every kind `bq` may be used for.
///
/// A narrow gate on purpose: the AI names the CLI a read runs under, and the
/// only thing that makes a second CLI safe to accept is that it can be used
/// for one service and refused everywhere else.
const BIGQUERY_KINDS: &str = "bigquery.googleapis.com/";

/// The subcommands of `bq` that only read.
///
/// `query` is deliberately absent: it runs SQL, and SQL writes - `bq query
/// 'DELETE FROM …'` is a delete behind a read-sounding verb. `mk`, `rm`,
/// `update`, `cp`, `load` and `insert` are absent for saying what they do.
pub(super) const READ_COMMANDS: [&str; 5] = ["show", "ls", "head", "get-iam-policy", "info"];

/// Whether this kind of resource is one `bq` reads.
pub(super) fn reads_kind(kind: &str) -> bool {
    kind.starts_with(BIGQUERY_KINDS)
}

/// The global flags Aime puts in front of every `bq` read: which project it is
/// scoped to, and JSON out.
///
/// `prettyjson` rather than `json` because it is what `bq`'s own examples use
/// and both parse the same; `--project_id` because `bq` does not know
/// `--project`.
pub(super) fn scope(project: &str) -> Vec<String> {
    vec![
        "--project_id".to_string(),
        project.to_string(),
        "--format".to_string(),
        "prettyjson".to_string(),
    ]
}

/// Proves that the BigQuery CLI on this machine has this command, and that it
/// is one that only reads.
///
/// Both refusals name the command and list the ones that would have done,
/// because the reason is handed straight back to the AI to write the command
/// again and a round spent on "which word did you mean" is a round wasted.
pub(super) async fn check(words: &[&str]) -> Result<(), String> {
    let [command] = words else {
        return Err(format!(
            "`bq {}` is not a BigQuery command line: `bq` takes ONE command word and then its arguments",
            words.join(" ")
        ));
    };
    if !READ_COMMANDS.contains(command) {
        return Err(format!(
            "`bq {command}` is not one of the BigQuery commands that only read - {}",
            READ_COMMANDS.join(", ")
        ));
    }
    let help = read_cli_output(PROGRAM, &["help", command]).await?;
    if describes(&help, command) {
        return Ok(());
    }
    Err(format!(
        "`bq {command}` is not a command the BigQuery CLI here knows"
    ))
}

/// Whether a `bq help` answer describes the command it was asked about.
///
/// `bq help show` answers `show   Show all information about an object.` at
/// the start of a line; `bq help bogus` answers the whole command list, in
/// which every line that starts with a word starts with a command `bq` has -
/// and none of them with the word that was asked about. Both captured on this
/// machine.
fn describes(help: &str, command: &str) -> bool {
    help.lines().any(|line| {
        line.strip_prefix(command)
            .is_some_and(|rest| rest.starts_with(' '))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured 2026-09-11 from `bq help show` on this machine (BigQuery CLI
    /// 2.1.38), head of the answer. Written from memory of "what help looks
    /// like", this test would pass while the parser missed the one line that
    /// carries the answer.
    const HELP_SHOW: &str = "Python script for interacting with BigQuery.\n\n\nUSAGE: bq.py [--global_flags] <command> [--command_flags] [args]\n\n\nshow                       Show all information about an object.\n\n                           Examples:\n                           bq show -j <job_id>\n                           bq show dataset\n";

    /// Captured the same way from `bq help bogus` - which exits 1 like every
    /// other `bq help`, and answers the command list instead of a description.
    const HELP_UNKNOWN: &str = "Python script for interacting with BigQuery.\n\n\nUSAGE: bq.py [--global_flags] <command> [--command_flags] [args]\n\n\nAny of the following commands:\n  add-iam-policy-binding, cancel, cp, extract, get-iam-policy, head, help, info,\n  init, insert, load, ls, mk, mkdef, partition, query, remove-iam-policy-\n  binding, rm, set-iam-policy, shell, show, truncate, undelete, update, version,\n  wait\n\n\nadd-iam-policy-binding     Add a binding to a BigQuery resource's policy in IAM.\n";

    #[test]
    fn a_command_is_real_when_bqs_own_help_describes_it() {
        assert!(describes(HELP_SHOW, "show"));
        assert!(
            !describes(HELP_UNKNOWN, "bogus"),
            "the answer for an unknown command names every command but that one"
        );

        // What follows the list is the full description of every command `bq`
        // has, each at the start of its own line - so the answer for an
        // unknown command is still the truth about every command that exists.
        assert!(
            describes(HELP_UNKNOWN, "add-iam-policy-binding"),
            "that list ends in the full description of each command"
        );
        assert!(
            !describes(HELP_SHOW, "sho"),
            "a command has to be the whole word, not the start of one"
        );
    }

    #[test]
    fn only_bigquery_kinds_may_be_read_with_bq() {
        assert!(reads_kind("bigquery.googleapis.com/Dataset"));
        assert!(reads_kind("bigquery.googleapis.com/Table"));
        assert!(!reads_kind("pubsub.googleapis.com/Topic"));
        assert!(!reads_kind("bigqueryreservation.googleapis.com/Reservation"));
        assert!(!reads_kind(""), "a caller with no kind gets no second CLI");
    }

    /// `bq` takes its scope in front of the command, and under another name.
    #[test]
    fn the_scope_is_global_flags_in_bqs_own_spelling() {
        assert_eq!(
            scope("samplebigquery-428108"),
            ["--project_id", "samplebigquery-428108", "--format", "prettyjson"]
        );
    }
}
