//! What a deploy has to know about the CLI it is talking to.
//!
//! `deploy.rs` was written against `gcloud` and read as if every cloud spoke
//! it: the scope flags, the groups a deployment may not enter, the flag family
//! that overwrites a running service, the one grant that is fenced rather than
//! refused. None of that is universal - `az` is told where to work with
//! `--subscription` and has no `--account` at all, asks for JSON with
//! `--output`, and spells a change as a verb rather than as a `--set-*` flag.
//!
//! So the differences live here, one table per cloud, and the checker reads
//! the table. All four are measured now, and the last two each moved something
//! out of the checker and into a row rather than into a branch: AWS, how a CLI
//! is asked whether it knows a command (it has no `--help` flag at all) and how
//! far it can be held to before the command runs; Supabase, the flags a CLI
//! needs that only a running installation can fill in.
//!
//! A cloud with no table here can be neither deployed to nor operated on.
//! Having a table is not the same as having a Deploy button: this checker also
//! stands behind the operations on a single resource, and proving one command
//! is a far smaller claim than planning a whole deployment. All four clouds
//! have both since 2026-09-22; `lib/deployDialect.ts` holds that split, and a
//! fifth cloud would arrive on the near side of it.

/// How a CLI is told which account, project or subscription to work in.
///
/// Aime pins this itself on every step rather than trusting the CLI's current
/// context: the panel shows one account and must run against that one, however
/// the person's terminal is configured.
pub(super) struct Scope {
    /// The flag naming the unit a command is scoped by.
    pub(super) unit: &'static str,
    /// The flag naming who owns it, for a CLI that takes one.
    ///
    /// `gcloud` does: one machine holds credentials for several Google
    /// accounts and a project is only visible through the right one. `az` does
    /// not - the signed-in user is a property of the token that already sits
    /// behind the subscription id, and there is no such flag to give
    /// (measured 2026-09-17 against az 2.90.0: `--subscription` is the only
    /// scope flag in its global arguments).
    pub(super) owner: Option<&'static str>,
}

/// The one account-level grant a deployment may make, and the fence around it.
///
/// A cloud without an entry here refuses its whole grant surface. That is
/// where Google Cloud started too; the exception was opened only after a real
/// deploy failed on it (see `deploy::Dialect::GCLOUD`), and Azure's will be
/// opened the same way or not at all.
pub(super) struct Grant {
    /// The command group the grant lives in, which is otherwise refused.
    pub(super) group: &'static str,
    /// The one command in that group a deployment may use.
    pub(super) command: &'static str,
    /// The flag naming who is being granted something.
    pub(super) member: &'static str,
    /// What that member must start with: an identity belonging to a machine.
    pub(super) member_prefix: &'static str,
    /// The flag naming what is being granted.
    pub(super) role: &'static str,
    /// Roles that can grant every other role, so never these.
    pub(super) refused_roles: &'static [&'static str],
}

/// One cloud's command line, as far as a deploy has to care.
pub(super) struct Dialect {
    /// The cloud as a person reads it in a refusal.
    pub(super) name: &'static str,
    /// The CLI as a person writes it, which is not always how Aime runs it.
    ///
    /// A refusal has to name the command the person would type. Three of these
    /// CLIs are on PATH and the resolved program is the same word; the
    /// Supabase one is a copy Aime downloaded, so the resolved program is a
    /// full path and a refusal that used it read
    /// *`C:\Users\…\cloud-clis\supabase.exe db upgrade` is not a command*.
    pub(super) program: &'static str,
    /// Flags Aime appends itself; a plan that carries one is refused.
    pub(super) own_flags: &'static [&'static str],
    /// Flags that change what the CLI does with the command line rather than
    /// what it asks the cloud, so none of them belongs in a step.
    pub(super) refused_flags: &'static [&'static str],
    /// Command groups a deployment has no business in.
    pub(super) refused_groups: &'static [&'static str],
    /// What those groups have in common, finishing "`<group>` …".
    ///
    /// Per cloud rather than one sentence for all, because they are not about
    /// the same thing everywhere: on the three big CLIs they are the account,
    /// the money and the CLI itself, while half of Supabase's run a local
    /// development stack that has nothing to do with the project in the cloud.
    /// A refusal the AI cannot act on is a refusal it will make again.
    pub(super) groups_are: &'static str,
    /// Commands a DEPLOYMENT may run although work on a resource may not.
    ///
    /// The two are not the same job and the refusals are not the same either:
    /// day-to-day work happens on a resource that already exists, from a work
    /// folder holding no project, while a deploy happens inside somebody's
    /// repository and its whole point is to put what is in that repository
    /// into the cloud. On Supabase that is the difference between "this CLI
    /// cannot deploy" and "this CLI deploys the way its own documentation
    /// says": `link`, `functions deploy`, `db push` and `config push` read
    /// the `supabase/` directory in the repository, which the panel does not
    /// have and a deploy does.
    ///
    /// A pair is `(group, command)`; an empty command is a word that stands
    /// alone, like `supabase link`. Empty for a cloud whose deploy needs
    /// nothing its panel is refused.
    pub(super) deploy_opens: &'static [(&'static str, &'static str)],
    /// Single commands refused inside a group that is otherwise allowed.
    ///
    /// A group is the blunt instrument, and on some CLIs it is too blunt:
    /// `aws ecs` is how an ECS service is redeployed and `aws ssm` is how a
    /// parameter is read, but `ecs execute-command` and `ssm start-session`
    /// open a shell on somebody's machine, which is the thing this whole
    /// module exists to keep out of an AI's reach.
    pub(super) refused_commands: &'static [RefusedCommand],
    /// Values refused wherever their flag appears - see `RefusedValue`.
    pub(super) refused_values: &'static [RefusedValue],
    /// Flag prefixes that replace or wipe what a running service already has,
    /// and the prefix to use instead.
    pub(super) overriding: &'static [&'static str],
    /// What to put in place of an overriding flag, where the CLI has a
    /// merging counterpart.
    pub(super) merging: &'static str,
    /// The grant that is fenced instead of refused, where there is one.
    pub(super) grant: Option<Grant>,
    /// How the CLI is told where to work.
    pub(super) scope: Scope,
    /// How it is asked for JSON.
    pub(super) json: [&'static str; 2],
    /// A second program a step may name, where the cloud has one.
    pub(super) second_program: Option<&'static str>,
    /// The token that asks the CLI whether it knows a command.
    ///
    /// Appended to the words being tried, and exit 0 means the CLI has them.
    /// Not a constant, because it is not the same token everywhere: `gcloud`
    /// and `az` take `--help` as a flag, and `aws` does not have that flag at
    /// all. Measured 2026-09-18 against aws-cli 2.17.31 - `aws ec2
    /// describe-instances --help` exits **252** with *Unknown options:
    /// --help*, while `aws ec2 describe-instances help` exits 0 with 79 KB of
    /// documentation and a misspelled operation exits 252. A checker that
    /// assumed the flag would refuse every AWS command there is.
    pub(super) help: &'static str,
    /// How far this CLI can be held to before a command is run.
    pub(super) proof: Proof,
    /// Flags this CLI needs on every call that cannot be written down here,
    /// because they are decided when the app runs rather than when it is built.
    ///
    /// Only the Supabase CLI has any: it needs a `--workdir` it may write into,
    /// and that path is this installation's own app-data folder. Without it the
    /// CLI drops `supabase/.temp` into whatever directory the command ran in -
    /// which is the person's repository (`supabase.rs` has the measurement).
    pub(super) runtime_flags: Option<RuntimeFlags>,
}

/// Flags only a running installation can fill in, as a function of it and of
/// where the command is allowed to keep a project: `None` for work on a
/// resource, the repository being deployed for a deploy step.
pub(super) type RuntimeFlags = fn(&tauri::AppHandle, Option<&str>) -> Result<Vec<String>, String>;

/// One command refused inside a group that is otherwise open, and why.
///
/// The reason is part of the entry because these are refused for different
/// reasons on different CLIs - one opens a shell on a machine, another would
/// push a local project Aime does not have - and a refusal the AI cannot act
/// on is a refusal it will make again.
pub(super) struct RefusedCommand {
    pub(super) group: &'static str,
    pub(super) command: &'static str,
    /// Finishes the sentence "`<group> <command>` …".
    pub(super) why: &'static str,
}

/// One value a flag may not carry, wherever that flag appears.
///
/// A flag is not always the whole decision: `aws cloudformation deploy` is a
/// command a deployment is for, and `--capabilities` is how the same command
/// asks for the right to make identities. What it may ask for is a question
/// about the value, not about the flag or the command.
pub(super) struct RefusedValue {
    pub(super) flag: &'static str,
    pub(super) value: &'static str,
    /// Finishes the sentence "`<flag> <value>` …".
    pub(super) why: &'static str,
}

/// What the refused groups of the three big cloud CLIs have in common.
const ACCOUNT_AND_CLI: &str =
    "manages the account, the money or the CLI itself, none of which is work on a resource";
/// Supabase spreads them wider: sign-in, the folder link, scaffolding, a local
/// development stack that is not the cloud project at all - and everything
/// that speaks to the database, which this CLI does only for a project LINKED
/// into a local folder (measured; `refused_groups` carries the answers).
const NOT_THE_PROJECT: &str = "signs in, links a folder, scaffolds files, runs the local development \
                               stack, or reaches the database through a project linked into a local \
                               folder - and Aime runs this CLI from a work folder with no project \
                               linked, so none of it is work it can do on the project in the cloud";

/// It runs code on somebody's machine rather than asking a service.
const SHELL: &str = "runs code on a machine instead of asking the cloud for something; Aime runs \
                     commands, not sessions";
/// It reads a local project folder, and Aime's work folder holds none.
const NO_LOCAL_PROJECT: &str = "pushes a LOCAL project to the cloud, and Aime runs this CLI from a \
                                work folder that holds no project - so there would be nothing to push";
/// It acts on the local development stack rather than on the cloud.
const LOCAL_ONLY: &str = "acts on the local development stack on this machine, not on the project in \
                          the cloud";
/// It is the whole project, not something inside it.
const WHOLE_PROJECT: &str =
    "creates or removes a whole project, which is more than day-to-day work on one resource inside one";

/// How much of a command a CLI lets Aime prove before running it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Proof {
    /// Only that the words exist. `gcloud` and `az` describe a command in
    /// prose, and a flag that does not fit fails at run time in the CLI's own
    /// words, which the panel shows.
    Words,
    /// The words AND the flags. `aws` describes itself twice over: 387 service
    /// models sit beside the binary naming every API operation's flags and the
    /// ones it requires, and the commands the CLI adds itself carry a synopsis
    /// in their help. Measured the hard way 2026-09-18 - `aws logs tail
    /// --log-group-name <name>` passed a walk, because `logs tail` is a real
    /// command, and then died on the CLI with *Unknown options*, because that
    /// command takes the group as a positional.
    WordsAndFlags,
    /// The words, proven by the command tree the CLI prints rather than by an
    /// exit code. The Supabase CLI needs this: measured 2026-09-05,
    /// `supabase functions lst --help` exits **0** and prints the help of
    /// `functions`, so a misspelled subcommand sails through a walk that trusts
    /// the exit code. What it does give is a `SUBCOMMANDS` section at every
    /// level, so each word has to be listed by the level above it.
    Listed,
}

impl Dialect {
    /// Google Cloud: `gcloud`, and `kubectl` for the clusters it creates.
    const GCLOUD: Dialect = Dialect {
        name: "Google Cloud",
        program: "gcloud",
        groups_are: ACCOUNT_AND_CLI,
        // `--quiet` is Aime's because prompts are already disabled for every
        // CLI it runs; a plan that adds it is a plan expecting a question.
        own_flags: &["--project", "--account", "--format", "--quiet"],
        // Nothing measured here yet: `gcloud`'s own command-line flags have
        // not been gone through the way `aws`'s global options were, and a
        // list written from memory is the thing this file refuses to keep.
        refused_flags: &[],
        // The account, the money, the sign-in and the CLI itself.
        refused_groups: &[
            "projects",
            "billing",
            "organizations",
            "auth",
            "config",
            "components",
        ],
        deploy_opens: &[],
        refused_commands: &[],
        refused_values: &[],
        // gcloud's own convention: `--set-*` replaces, `--update-*` merges,
        // `--clear-*` wipes, `--remove-*` deletes.
        overriding: &["--set-", "--clear-", "--remove-"],
        merging: "--update-",
        grant: Some(Grant {
            // Measured 2026-09-10 on the first deploy that got past billing:
            // `gcloud run deploy --source` failed with *Build failed because
            // the default service account is missing required IAM
            // permissions*, the change Google made to new projects. The AI
            // diagnosed it exactly and then said it was not allowed to fix it,
            // because the fix is a project-level grant. Refusing that sends
            // the person to the web console for the commonest failure there
            // is, which is the opposite of the point.
            group: "projects",
            command: "add-iam-policy-binding",
            member: "--member",
            member_prefix: "serviceAccount:",
            role: "--role",
            // `editor` and `owner` are the blanket grants; the other four are
            // the escalation paths - the right to change IAM, to mint
            // service-account keys, or to become another account.
            refused_roles: &[
                "roles/owner",
                "roles/editor",
                "roles/iam.securityAdmin",
                "roles/iam.serviceAccountKeyAdmin",
                "roles/iam.serviceAccountTokenCreator",
                "roles/resourcemanager.projectIamAdmin",
            ],
        }),
        scope: Scope {
            unit: "--project",
            owner: Some("--account"),
        },
        json: ["--format", "json"],
        second_program: Some(super::k8s::PROGRAM),
        help: "--help",
        proof: Proof::Words,
        runtime_flags: None,
    };

    /// Azure: `az`, and nothing else.
    ///
    /// Measured 2026-09-17 against az 2.90.0 on a real subscription, because
    /// the checker's whole method rests on it: `az webapp create --help` exits
    /// 0 with 15.6 KB on stdout and nothing on stderr, and `az webapp crate
    /// --help` exits 2 with an empty stdout and *'crate' is misspelled or not
    /// recognized by the system* on stderr. So the `--help` walk that settles
    /// where a command's words end works here exactly as it does for `gcloud`.
    const AZ: Dialect = Dialect {
        name: "Azure",
        program: "az",
        groups_are: ACCOUNT_AND_CLI,
        // `--output` is `az`'s `--format`, and `-o` its short spelling; a plan
        // that sets either is choosing the shape Aime parses.
        own_flags: &["--subscription", "--output", "-o"],
        // As for Google Cloud: not measured, so not claimed.
        refused_flags: &[],
        // The same four concerns as Google Cloud, in this CLI's own words
        // (every name checked against `az --help`, 2026-09-17), plus the two
        // ways out of the checker itself: `rest` sends a raw ARM request,
        // which is a DELETE away from anything in the subscription, and
        // `interactive` is a shell. `ad` and `role` are the directory and its
        // role assignments: Google Cloud's equivalent was opened only after a
        // real deploy needed it, so Azure's starts closed.
        refused_groups: &[
            "account",
            "login",
            "logout",
            "config",
            "configure",
            "extension",
            "upgrade",
            "ad",
            "role",
            "billing",
            "consumption",
            "rest",
            "interactive",
        ],
        deploy_opens: &[],
        refused_commands: &[],
        refused_values: &[],
        // Azure has no flag family that means "replace what is there": a
        // change is a verb (`az webapp config appsettings set`), not a prefix,
        // so there is nothing to refuse by shape. What protects a running
        // service's settings here is the plan's `keep` reads, which Aime runs
        // before and after and compares.
        overriding: &[],
        merging: "",
        grant: None,
        scope: Scope {
            unit: "--subscription",
            owner: None,
        },
        json: ["--output", "json"],
        second_program: None,
        help: "--help",
        proof: Proof::Words,
        runtime_flags: None,
    };

    /// AWS: `aws`, and nothing else.
    ///
    /// Measured 2026-09-18 against aws-cli 2.17.31 on this machine. Two things
    /// here are unlike the other two CLIs and both were found by running it:
    /// the help probe is a WORD rather than a flag (see `Dialect::help`), and
    /// the scope is a PROFILE - there is no project or subscription above it,
    /// because an AWS account is reached through the credentials themselves.
    ///
    /// The region is not scope either. It belongs to the resource, so a plan
    /// writes `--region` with the `<region>` placeholder and Aime fills it
    /// from the ARN, the same way `reads.rs` does.
    const AWS: Dialect = Dialect {
        name: "AWS",
        program: "aws",
        groups_are: ACCOUNT_AND_CLI,
        own_flags: &["--profile", "--output"],
        // From `aws help`, Global Options, read on this machine rather than
        // recalled. Four of these hand the command line somewhere Aime cannot
        // follow: `--endpoint-url` sends it to any host at all, `--cli-input-
        // json`/`--cli-input-yaml` carry parameters the checker never saw, and
        // `--generate-cli-skeleton` answers with a template instead of doing
        // the work. The rest weaken the connection, print credentials into a
        // log, or turn the run interactive. `--query` filters the answer
        // before Aime parses it, which breaks the reads a plan is proved by.
        refused_flags: &[
            "--endpoint-url",
            "--cli-input-json",
            "--cli-input-yaml",
            "--generate-cli-skeleton",
            "--no-verify-ssl",
            "--no-sign-request",
            "--debug",
            "--cli-auto-prompt",
            "--query",
        ],
        // The same four concerns as the other two clouds, in this CLI's own
        // service names (every one verified with `aws <name> help`, exit 0,
        // 2026-09-18): the identity (`iam`, `sts`, `organizations`,
        // `account`), the sign-in (`sso`), the money (`budgets`, `ce`), and
        // the CLI's own configuration (`configure`, which writes
        // `~/.aws/config`). `ec2-instance-connect` is here because every
        // command it has exists to hand somebody a shell on an instance.
        refused_groups: &[
            "configure",
            "sso",
            "iam",
            "sts",
            "organizations",
            "account",
            "budgets",
            "ce",
            "ec2-instance-connect",
        ],
        // AWS has no `az rest`, but it has four commands that run code on a
        // machine instead of asking a service for something, and they sit in
        // groups a deployment genuinely needs. Each name verified the same way.
        deploy_opens: &[],
        refused_commands: &[
            RefusedCommand {
                group: "ssm",
                command: "start-session",
                why: SHELL,
            },
            RefusedCommand {
                group: "ssm",
                command: "send-command",
                why: SHELL,
            },
            RefusedCommand {
                group: "ssm",
                command: "start-automation-execution",
                why: SHELL,
            },
            RefusedCommand {
                group: "ecs",
                command: "execute-command",
                why: SHELL,
            },
        ],
        // A deployment here IS a CloudFormation stack, and `--capabilities` is
        // that same command asking for the right to make identities. The plain
        // one is left open because a stack that runs code needs a role of its
        // own and CloudFormation names that role after the stack; the other two
        // reach outside what the stack owns.
        refused_values: &[
            RefusedValue {
                flag: "--capabilities",
                value: "CAPABILITY_NAMED_IAM",
                why: "lets the template make an identity with a name of its own choosing, which \
                      may be one something else already owns; `CAPABILITY_IAM` leaves the naming \
                      to CloudFormation, and those roles belong to this stack alone",
            },
            RefusedValue {
                flag: "--capabilities",
                value: "CAPABILITY_AUTO_EXPAND",
                why: "runs a macro that rewrites the template after the person has read it, so \
                      what would run is not what was confirmed",
            },
        ],
        // Like Azure and unlike Google Cloud, AWS has no flag family meaning
        // "replace what is there": an update names the thing it updates.
        overriding: &[],
        merging: "",
        grant: None,
        // An AWS profile IS the account: `aws` has no flag for a project or a
        // subscription, and the signed-in identity is whatever the profile's
        // credentials belong to.
        scope: Scope {
            unit: "--profile",
            owner: None,
        },
        json: ["--output", "json"],
        second_program: None,
        // Measured, and the reason this field exists at all.
        help: "help",
        proof: Proof::WordsAndFlags,
        runtime_flags: None,
    };

    /// Supabase: the `supabase` CLI, measured 2026-09-18 on 2.116.0.
    ///
    /// The odd one out in three ways, and all three were measured rather than
    /// assumed. Its help walk cannot trust an exit code (see `Proof::Listed`).
    /// Its scope is a `--project-ref`, which is not a global flag but one the
    /// project commands take. And it is the only CLI here that needs flags
    /// decided at run time, because it writes a project folder wherever it is
    /// run unless given a `--workdir`.
    const SUPABASE: Dialect = Dialect {
        name: "Supabase",
        program: "supabase",
        groups_are: NOT_THE_PROJECT,
        // `--agent`, `--experimental` and `--workdir` are Aime's for the
        // reasons `supabase.rs` records; `-o`/`--output` and `--output-format`
        // decide the shape of an answer Aime reads.
        own_flags: &[
            "--project-ref",
            "-o",
            "--output",
            "--output-format",
            "--agent",
            "--experimental",
            "--workdir",
            "--yes",
        ],
        // From `supabase --help`, GLOBAL FLAGS, read on this machine.
        // `--wizard` is interactive, `--create-ticket` files a support ticket
        // with the vendor, `--profile` swaps the credentials out from under
        // the account the panel is showing, and the last three reach past the
        // command into how it connects.
        refused_flags: &[
            "--wizard",
            "--create-ticket",
            "--profile",
            "--debug",
            "--network-id",
            "--dns-resolver",
            "--completions",
        ],
        // Every name read from `supabase --help` on this machine. The
        // sign-in (`login`, `logout`, `sso`), the link between a folder and a
        // project that Aime pins per command instead (`link`, `unlink`), the
        // level above the project (`orgs`), the CLI's own settings
        // (`telemetry`, `completion`), the things that scaffold or generate
        // files (`init`, `bootstrap`, `seed`, `gen`), the GitHub issue form
        // (`issue`), and the LOCAL Docker stack, which is not this project at
        // all (`start`, `stop`, `status`, `test`).
        //
        // And the four that speak to the database directly, which this CLI
        // will only do for a project LINKED into a local folder. Measured
        // 2026-09-21 against a real project from Aime's own work folder:
        // every `db` command answers *--project-ref only applies when
        // targeting the linked project* (`db advisors`, `db lint`, `db diff`,
        // all three the same), `migration list` and `inspect db table-stats`
        // answer *Run supabase link … to setup IPv4 connection*, and `storage
        // ls` answers *Anon key not found*. `migration up`'s own help says it
        // applies migrations to the LOCAL database. A group that cannot run
        // at all is worse than one that is refused: the AI spends an answer
        // on it and the person reads the CLI's confusion instead of Aime's.
        refused_groups: &[
            "login",
            "logout",
            "sso",
            "link",
            "unlink",
            "orgs",
            "telemetry",
            "completion",
            "init",
            "bootstrap",
            "seed",
            "gen",
            "issue",
            "start",
            "stop",
            "status",
            "test",
            "db",
            "migration",
            "migrations",
            "inspect",
            "storage",
        ],
        // What a deploy does that the panel never does: it works INSIDE the
        // repository. `link` binds that folder to the project and is what
        // every `db` command asks for, `functions deploy` uploads
        // `supabase/functions/<slug>`, `db push` applies the migrations in
        // `supabase/migrations`, and `config push` writes the settings in
        // `supabase/config.toml`. Refused for work on a resource, and the
        // whole job here.
        deploy_opens: &[
            ("link", ""),
            ("init", ""),
            ("functions", "deploy"),
            ("db", "push"),
            ("config", "push"),
        ],
        // Aime runs this CLI from a work folder of its own that holds no
        // project, so anything that pushes LOCAL state to the cloud would push
        // emptiness. `projects create`/`delete` are a whole project, which is
        // more than day-to-day work on a resource inside one.
        refused_commands: &[
            RefusedCommand {
                group: "config",
                command: "push",
                why: NO_LOCAL_PROJECT,
            },
            RefusedCommand {
                group: "functions",
                command: "deploy",
                why: NO_LOCAL_PROJECT,
            },
            RefusedCommand {
                group: "functions",
                command: "new",
                why: NO_LOCAL_PROJECT,
            },
            RefusedCommand {
                group: "functions",
                command: "serve",
                why: LOCAL_ONLY,
            },
            RefusedCommand {
                group: "projects",
                command: "create",
                why: WHOLE_PROJECT,
            },
            RefusedCommand {
                group: "projects",
                command: "delete",
                why: WHOLE_PROJECT,
            },
        ],
        refused_values: &[],
        overriding: &[],
        merging: "",
        grant: None,
        scope: Scope {
            unit: "--project-ref",
            owner: None,
        },
        json: ["-o", "json"],
        second_program: None,
        help: "--help",
        proof: Proof::Listed,
        runtime_flags: Some(super::supabase::step_flags),
    };

    /// The dialect for a cloud, or `None` where Aime has not measured one.
    pub(super) fn of(cloud_id: &str) -> Option<&'static Dialect> {
        match cloud_id {
            "gcp" => Some(&Self::GCLOUD),
            "azure" => Some(&Self::AZ),
            "aws" => Some(&Self::AWS),
            "supabase" => Some(&Self::SUPABASE),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether this dialect refuses that one command inside an open group.
    fn refuses(dialect: &Dialect, group: &str, command: &str) -> bool {
        dialect
            .refused_commands
            .iter()
            .any(|one| one.group == group && one.command == command)
    }

    #[test]
    fn only_the_measured_clouds_have_a_command_line_here() {
        assert!(Dialect::of("gcp").is_some());
        assert!(Dialect::of("azure").is_some());
        assert!(Dialect::of("aws").is_some());
        assert!(Dialect::of("supabase").is_some());
        assert!(Dialect::of("fly").is_none(), "nothing else has been measured");
    }

    /// Supabase proves a command by the tree its help prints.
    ///
    /// Measured 2026-09-05: `supabase functions lst --help` exits **0** and
    /// prints the help of `functions`, so an exit code proves nothing here.
    #[test]
    fn supabase_is_proven_by_its_command_tree_not_by_an_exit_code() {
        let supabase = Dialect::of("supabase").expect("supabase");
        assert!(matches!(supabase.proof, Proof::Listed));
        assert_eq!(supabase.scope.unit, "--project-ref");
        assert_eq!(supabase.json, ["-o", "json"]);
    }

    /// The Supabase CLI is the only one that must be told where it may write.
    #[test]
    fn only_supabase_needs_flags_this_installation_fills_in() {
        assert!(Dialect::of("supabase").expect("supabase").runtime_flags.is_some());
        for cloud in ["gcp", "azure", "aws"] {
            assert!(
                Dialect::of(cloud).expect(cloud).runtime_flags.is_none(),
                "{cloud}"
            );
        }
        // Whatever those flags turn out to be, a plan may not write them.
        for flag in ["--workdir", "--agent", "--experimental", "--yes"] {
            assert!(
                Dialect::of("supabase")
                    .expect("supabase")
                    .own_flags
                    .contains(&flag),
                "{flag}"
            );
        }
    }

    /// Aime runs this CLI from a work folder holding no project, so a command
    /// that pushes local state would push emptiness - and one that reaches the
    /// database would not reach it at all.
    #[test]
    fn supabase_refuses_what_would_push_an_empty_local_project() {
        let supabase = Dialect::of("supabase").expect("supabase");
        for command in [("config", "push"), ("functions", "deploy"), ("functions", "new")] {
            assert!(refuses(supabase, command.0, command.1), "{command:?}");
        }
        // A whole project is more than day-to-day work on one resource inside it.
        assert!(refuses(supabase, "projects", "delete"));
        // The local Docker stack is not this project at all, and neither is
        // anything that needs a linked folder to reach the database: measured
        // 2026-09-21, every `db` command answers *--project-ref only applies
        // when targeting the linked project*, `migration list` and `inspect db
        // table-stats` ask for `supabase link`, and `storage ls` cannot find
        // an anon key. `db query` is covered by its group now rather than by a
        // line of its own.
        for group in [
            "start",
            "stop",
            "status",
            "test",
            "login",
            "link",
            "db",
            "migration",
            "migrations",
            "inspect",
            "storage",
        ] {
            assert!(supabase.refused_groups.contains(&group), "{group}");
        }
        // And the groups the panel really works through stay open.
        for group in [
            "functions",
            "projects",
            "postgres-config",
            "secrets",
            "branches",
            "backups",
            "network-restrictions",
            "snippets",
        ] {
            assert!(!supabase.refused_groups.contains(&group), "{group}");
        }
    }

    /// The probe that settles whether a command exists is the CLI's own.
    ///
    /// `aws` is the reason this is a field: it has no `--help` flag, and a
    /// checker that sent one would refuse every AWS command there is.
    #[test]
    fn each_cli_is_asked_about_a_command_in_the_form_it_accepts() {
        assert_eq!(Dialect::of("gcp").expect("gcp").help, "--help");
        assert_eq!(Dialect::of("azure").expect("azure").help, "--help");
        assert_eq!(Dialect::of("aws").expect("aws").help, "help");
    }

    /// A shell on somebody's machine is not an operation, wherever it hides.
    #[test]
    fn aws_refuses_the_commands_that_run_code_instead_of_calling_a_service() {
        let aws = Dialect::of("aws").expect("aws");
        for command in [
            ("ssm", "start-session"),
            ("ssm", "send-command"),
            ("ecs", "execute-command"),
        ] {
            assert!(refuses(aws, command.0, command.1), "aws {command:?}");
        }
        // The groups those live in stay open: `ecs update-service` and
        // `ssm get-parameter` are the day-to-day work this panel is for.
        assert!(!aws.refused_groups.contains(&"ecs"));
        assert!(!aws.refused_groups.contains(&"ssm"));
    }

    /// The flags that carry a command line out of Aime's sight.
    #[test]
    fn aws_refuses_the_flags_that_go_around_the_checker() {
        let aws = Dialect::of("aws").expect("aws");
        for flag in [
            "--endpoint-url",
            "--cli-input-json",
            "--generate-cli-skeleton",
            "--no-verify-ssl",
        ] {
            assert!(aws.refused_flags.contains(&flag), "{flag}");
        }
    }

    /// Every cloud pins its own scope, and the flags are the CLI's own.
    #[test]
    fn each_cli_is_told_where_to_work_in_its_own_words() {
        let gcloud = Dialect::of("gcp").expect("gcp");
        assert_eq!(gcloud.scope.unit, "--project");
        assert_eq!(gcloud.scope.owner, Some("--account"));
        assert_eq!(gcloud.json, ["--format", "json"]);

        let az = Dialect::of("azure").expect("azure");
        assert_eq!(az.scope.unit, "--subscription");
        assert_eq!(az.scope.owner, None, "`az` has no account flag to give");
        assert_eq!(az.json, ["--output", "json"]);

        let aws = Dialect::of("aws").expect("aws");
        assert_eq!(aws.scope.unit, "--profile", "an AWS profile IS the account");
        assert_eq!(aws.scope.owner, None);
        assert_eq!(aws.json, ["--output", "json"]);
    }

    /// A scope flag is Aime's to add, so a plan may never carry it.
    #[test]
    fn the_scope_flags_are_the_ones_a_plan_may_not_write() {
        for cloud in ["gcp", "azure", "aws", "supabase"] {
            let dialect = Dialect::of(cloud).expect(cloud);
            assert!(
                dialect.own_flags.contains(&dialect.scope.unit),
                "{cloud}: {} is added by Aime and must be refused in a plan",
                dialect.scope.unit
            );
            if let Some(owner) = dialect.scope.owner {
                assert!(dialect.own_flags.contains(&owner), "{cloud}: {owner}");
            }
            assert!(
                dialect.own_flags.contains(&dialect.json[0]),
                "{cloud}: the JSON flag is Aime's too"
            );
        }
    }

    /// The two ways around the checker on Azure are refused by name.
    #[test]
    fn a_raw_api_call_and_a_shell_are_not_deployments() {
        let az = Dialect::of("azure").expect("azure");
        for bypass in ["rest", "interactive"] {
            assert!(az.refused_groups.contains(&bypass), "`az {bypass}`");
        }
    }

    /// A grant is fenced only where a real deploy proved it was needed.
    #[test]
    fn azure_refuses_its_whole_grant_surface_until_one_is_measured() {
        let az = Dialect::of("azure").expect("azure");
        assert!(az.grant.is_none());
        for group in ["ad", "role"] {
            assert!(az.refused_groups.contains(&group));
        }
        let gcloud = Dialect::of("gcp").expect("gcp");
        let grant = gcloud.grant.as_ref().expect("the measured exception");
        assert!(gcloud.refused_groups.contains(&grant.group));
        assert_eq!(grant.command, "add-iam-policy-binding");
    }

    /// An overriding prefix is only a rule where the CLI has the convention.
    #[test]
    fn only_gcloud_has_a_flag_family_that_overwrites() {
        assert!(!Dialect::of("gcp").expect("gcp").overriding.is_empty());
        assert!(Dialect::of("azure").expect("azure").overriding.is_empty());
        assert!(Dialect::of("aws").expect("aws").overriding.is_empty());
    }

    /// `kubectl` belongs to the cloud whose clusters Aime deploys to.
    #[test]
    fn a_second_program_is_named_per_cloud() {
        assert_eq!(Dialect::of("gcp").expect("gcp").second_program, Some("kubectl"));
        assert_eq!(Dialect::of("azure").expect("azure").second_program, None);
        assert_eq!(Dialect::of("aws").expect("aws").second_program, None);
    }
}
