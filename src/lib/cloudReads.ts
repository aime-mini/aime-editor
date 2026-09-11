/**
 * Planning how one KIND of cloud resource is read, by asking the AI once.
 *
 * Same split as `aiTasks.ts` (ARCHITECTURE.md §5): Aime says what it needs -
 * the configuration of a `lambda/function`, how to connect to a
 * `Microsoft.Sql/servers`, where its keys are - and the AI, which knows what a
 * Lambda function IS, says which of the CLI's own commands answers each. The
 * answer is written against placeholders, never against a real resource, so the
 * AI sees no identifiers and no values, and one answer serves every resource of
 * that kind. Nothing it says is taken on trust: `cloud_check_reads` proves every
 * command against the CLI's own service model (AWS) or the CLI's own `--help`
 * (Azure, Google Cloud) before it is kept - see `src-tauri/src/cloud/reads.rs`.
 */

/** The clouds whose reads Aime knows how to check, so how to plan. */
export type PlannableCloud = "azure" | "aws" | "gcp" | "supabase";

/** What each cloud's CLI is called, and how its command lines are scoped. */
const CLIS: Record<
  PlannableCloud,
  { name: string; program: string; group: string; scope: string; output: string }
> = {
  azure: {
    name: "Azure",
    program: "az",
    group: "resource group",
    scope: "`--subscription`",
    output: "`--output json`",
  },
  aws: {
    name: "AWS",
    program: "aws",
    group: "account number",
    scope: "`--profile`, `--region`",
    output: "`--output json`",
  },
  gcp: {
    name: "Google Cloud",
    program: "gcloud",
    group: "project id",
    scope: "`--project`",
    output: "`--format json`",
  },
  supabase: {
    name: "Supabase",
    program: "supabase",
    group: "project ref",
    scope: "`--project-ref`",
    output: "`-o json`",
  },
};

/** What a read is for; mirrors the Rust `ReadPurpose`. */
export type ReadPurpose = "overview" | "connection" | "secret";

/** One planned read; mirrors the Rust `PlannedRead`. */
export interface PlannedRead {
  purpose: ReadPurpose;
  /** What a person sees on the button, in the CLI's own words. */
  label: string;
  /** Arguments after the program name, with `<id>`, `<name>`, `<group>`, `<region>` where the resource goes. */
  args: string[];
  /**
   * Which of the cloud's own CLIs runs this; absent or empty for its main one.
   *
   * Google Cloud is two CLIs: `gcloud`, and `bq` for the BigQuery datasets
   * `gcloud` has no command for at all. Rust is the gate (`reads.rs:
   * program_of`) - a name it does not allow for that kind is refused there.
   */
  program?: string;
}

/**
 * One thing a developer pastes into an app, written out of the resource's own
 * identity instead of fetched; mirrors the Rust `ConnectionFact`.
 *
 * `value` is a template over the same placeholders a command uses, so one
 * answer serves every resource of the kind.
 */
export interface ConnectionFact {
  label: string;
  value: string;
}

/** A read Aime refused, and why; mirrors the Rust `RejectedRead`. */
export interface RejectedRead {
  label: string;
  reason: string;
  /** The read refused, so it can be sent back to the AI. Null for a fact. */
  command: PlannedRead | null;
}

/** What Aime kept for one kind and what it would not; mirrors the Rust `ReadPlan`. */
export interface ReadPlan {
  reads: PlannedRead[];
  facts: ConnectionFact[];
  rejected: RejectedRead[];
}

/** One kind's plan as it comes back off disk; mirrors the Rust `StoredPlan`. */
export interface StoredPlan {
  reads: PlannedRead[];
  facts: ConnectionFact[];
  /**
   * Whether every read here has answered on a real resource. False for a plan
   * written by an older build, and for one whose trial run hit a wall rather
   * than an answer - such a plan is proved again the next time one of its
   * resources is opened.
   */
  proved: boolean;
}

/** One read the AWS CLI has, as its own model spells it; mirrors the Rust `AwsOperation`. */
export interface AwsOperation {
  command: string;
  flags: string[];
  required: string[];
}

/** The AWS CLI's catalogue of one service's reads; mirrors the Rust `AwsCatalog`. */
export interface AwsCatalog {
  service: string;
  operations: AwsOperation[];
}

const PURPOSES: ReadPurpose[] = ["overview", "connection", "secret"];

/**
 * The second CLI a Google Cloud read may run under.
 *
 * `gcloud` has no `bigquery` command group at all, and `bq` - which ships in
 * the same folder of the Cloud SDK, so it needs no install - reads the datasets
 * it cannot. Which kinds may use it is settled in Rust (`reads.rs: program_of`).
 */
export const BIGQUERY_CLI = "bq";

/**
 * The one place a Google Cloud read is not a `gcloud` command, in both prompts.
 *
 * Measured 2026-09-11 on a real account: `gcloud` has no `bigquery` command
 * group at all, so every BigQuery kind was answering "no read" - and `bq show`
 * returns the dataset's own configuration in one call. Both prompts carry this,
 * because a repair round is a fresh call that remembers nothing of the first.
 */
const BIGQUERY_BRIEF =
  "- BigQuery is the one exception: `gcloud` has no `bigquery` commands, and BigQuery's own CLI `bq` " +
  "ships in the same folder of the Cloud SDK. For a `bigquery.googleapis.com/…` kind ONLY, answer `bq` " +
  'commands by naming it on the read - `{"purpose":"overview","program":"bq","label":"bq show",' +
  '"args":["show","<name>"]}` reads a dataset. `bq` takes ONE command word (`show`, `ls`, `head`), its ' +
  "flags stand BEFORE the arguments and are spelled with underscores, and Aime adds `--project_id` and " +
  "`--format prettyjson` itself. Every other kind is a `gcloud` command with no `program` at all, and " +
  "no other CLI - `gsutil`, `firebase` - can be used here, so a kind neither of these two can read has " +
  "no read at all.";

/** What each purpose means, in the words the model has to decide from. */
const PURPOSE_BRIEF = [
  "- `overview`: exactly ONE read - the describe/get/show that returns this resource's own configuration.",
  "- `connection`: what a developer needs to reach it - endpoints, hosts, ports, URLs, database names. " +
    "No credentials.",
  "- `secret`: reads whose answer carries a credential - keys, passwords, connection strings with a " +
    "password, publishing credentials. Aime shows these only after a deliberate click.",
].join("\n");

/**
 * The brief for one kind.
 *
 * The AWS catalogue is the CLI's own list of reads for that service, so the
 * model chooses from what exists rather than from memory; a command or flag
 * outside it is refused afterwards anyway. Azure needs no catalogue: `az
 * resource show --ids` is already seeded by Aime for every type, so the model
 * is asked only for the reads that generic call cannot make. Google Cloud has
 * neither a catalogue on disk nor a generic read, so the model is told the two
 * things about `gcloud` that decide whether a command runs: every `describe`
 * takes the relative resource name (`<path>`), and the location flag is spelled
 * per kind.
 */
export function buildReadPlanPrompt(
  cloud: PlannableCloud,
  kind: string,
  exampleId: string,
  catalog: AwsCatalog | null,
): string {
  const cli = CLIS[cloud];
  const lines = [
    `Plan how Aime reads ONE KIND of ${cli.name} resource with the \`${cli.program}\` CLI.`,
    "Answer once for the kind: Aime runs your commands for every resource of this kind, filling the placeholders.",
    "",
    `Kind: ${kind}`,
    `Identifier shape: ${redactId(exampleId)}`,
    "",
    placeholderBrief(cloud),
    `Aime itself adds ${cli.scope} and ${cli.output} - never include them.`,
    "",
    "Purposes:",
    PURPOSE_BRIEF,
    "",
    "RULES:",
    "- Read-only commands only: describe, get, list, show. Never create, update, delete, set, restart.",
    "- `args` are the arguments AFTER the program name, one token each, in the exact order the CLI takes them.",
    "- A value is a placeholder or a literal; a URL may contain placeholders " +
      "(`https://sqs.<region>.amazonaws.com/<group>/<name>`).",
    "- Leave out a purpose this kind has nothing for. Never invent a command to fill a purpose.",
  ];
  if (cloud === "azure") {
    lines.push(
      "- `az resource show --ids <id>` is already covered; do NOT repeat it. Give the type-specific reads " +
        "this kind has: connection strings, keys, app settings, endpoints - or nothing.",
    );
  }
  if (cloud === "gcp") {
    lines.push(
      "- WHAT A COMMAND IS GIVEN is per command, and `gcloud` is not consistent about it. Most take the " +
        "resource's OWN id - `<name>` - and reject the relative name: measured on a real account, " +
        "`iam service-accounts describe <path>` answers HTTP 404 (it takes the email, which is " +
        "`<name>`), and `logging buckets describe <path> --location <region>` answers NOT_FOUND (it " +
        "takes the bucket id). `pubsub topics describe` takes either. So prefer `<name>`, and use " +
        "`<path>` only where that command's own documentation shows a relative name. A storage bucket " +
        "is `gs://<name>`; the project itself takes the bare id, `projects describe <group>`.",
      "- `<name>` is the identifier, not the label: for a service account it is the email, for an API " +
        "key the key id. Aime fills it from the resource's own name, never from its display name.",
      "- Do not add a location flag the command does not ask for, and do not leave out one it does: " +
        "`logging buckets describe` takes `BUCKET_ID --location=LOCATION`. Aime refuses a command that " +
        "leaves out a flag the CLI's own synopsis lists as required.",
      "- Positionals come right after the command, before any flag. A flag and its value are two tokens " +
        "(`--zone`, `<region>`), never `--zone=<region>`.",
      "- Where `gcloud` can hand over the credential itself, that read is `secret`, never `connection`: " +
        "`services api-keys get-key-string`, `secrets versions access`, `iam service-accounts keys list`. " +
        "A developer needs those, so give them when the kind has them - Aime just waits for a click.",
      "- Aime RUNS each read once against a real resource before keeping it, and comes back with the " +
        "CLI's own words when it fails. A command that only looks right does not survive that, so " +
        "answer with the reads you are sure of and leave out the ones you are guessing at.",
      BIGQUERY_BRIEF,
    );
  }
  if (cloud === "supabase") {
    lines.push(
      "- A `supabase/database` is the project's Postgres: its reads are the project-level ones " +
        "(`postgres-config get`, `domains get`, `network-restrictions get`, `ssl-enforcement get`, " +
        "`inspect db …`); `projects api-keys` carries keys and is a secret. A `supabase/function` is an " +
        "Edge Function whose slug is `<name>`; a `supabase/branch` is a preview branch named `<name>`.",
      "- Only commands that accept `--project-ref`; nothing that needs a linked folder or a local stack.",
    );
  }
  if (catalog !== null) {
    lines.push(
      "",
      `The \`aws ${catalog.service}\` reads this machine's CLI actually has (command: flags; * = required). ` +
        "Use ONLY these commands and flags:",
      ...catalog.operations.map(
        (operation) =>
          `${operation.command}: ${operation.flags
            .map((flag) => (operation.required.includes(flag) ? `${flag}*` : flag))
            .join(" ")}`,
      ),
    );
  }
  lines.push(
    "",
    "FACTS - what a developer pastes, that no command is needed for:",
    "Much of what someone needs to connect is the resource's own identity written the way an SDK takes " +
      "it: a topic path, a bucket URI, a dataset id, a queue URL, a hostname. Aime already knows every " +
      "part of that, so asking the cloud for it would be a network call to be told what is on screen. " +
      "Answer those as `facts`: `{label, value}` with the placeholders above in the value " +
      "(`projects/<group>/topics/<name>`). Rules Aime enforces: a value with NO placeholder is refused, " +
      "because it would say the same thing for every resource of the kind; and a fact may never be a " +
      "credential - a key or a password cannot be worked out from a name, so those are `secret` reads. " +
      "Six at most, and none at all for a kind that has nothing to paste.",
  );
  lines.push("", "Answer with ONLY this JSON, no prose and no code fence:", EXAMPLE_ANSWER[cloud]);
  return lines.join("\n");
}

/**
 * The slots a command may leave for the resource, spelled out.
 *
 * In both prompts, because a repair is a fresh one-shot call with no memory of
 * the plan prompt: measured 2026-09-11, a repair round that only said "the
 * placeholders are the same as before" came back using `<email>`, which Aime
 * refuses and which cost another round to say so.
 */
function placeholderBrief(cloud: PlannableCloud): string {
  const cli = CLIS[cloud];
  return (
    "Placeholders Aime fills, and there are no others: `<id>` the full identifier, `<path>` the " +
    "identifier without its `//service/` head (`projects/…`), `<name>` the name the CLI takes for " +
    `the resource, \`<group>\` the ${cli.group}, \`<region>\` the location - ` +
    (cloud === "gcp" ? "a zone for a zonal resource, a region for a regional one." : "the region.")
  );
}

/** One well-formed answer per cloud, in that CLI's own spelling. */
const EXAMPLE_ANSWER: Record<PlannableCloud, string> = {
  azure:
    '{"reads":[{"purpose":"connection","label":"az webapp config hostname list","args":["webapp","config","hostname","list","--webapp-name","<name>","--resource-group","<group>"]}]}',
  aws: '{"reads":[{"purpose":"overview","label":"aws lambda get-function","args":["lambda","get-function","--function-name","<name>"]}]}',
  // One coherent kind, showing both halves of an answer: the read, and the
  // facts that need no command at all. Measured 2026-09-10 - with a single
  // `overview` read as the only example, the model answered overview-only for
  // kind after kind and the Connect tab stayed empty for the very resources a
  // developer had opened it for.
  gcp:
    '{"reads":[{"purpose":"overview","label":"gcloud storage buckets describe","args":["storage","buckets","describe","gs://<name>"]}],' +
    '"facts":[{"label":"Bucket URI","value":"gs://<name>"},{"label":"Public URL","value":"https://storage.googleapis.com/<name>"}]}',
  supabase:
    '{"reads":[{"purpose":"overview","label":"supabase postgres-config get","args":["postgres-config","get"]},{"purpose":"secret","label":"supabase projects api-keys","args":["projects","api-keys"]}]}',
};

/**
 * The identifier with its account and name replaced, so the prompt shows the
 * SHAPE of an identifier and not one of the user's resources.
 */
function redactId(id: string): string {
  if (id.startsWith("arn:")) {
    const parts = id.split(":");
    const head = parts.slice(0, 5).map((part, index) => (index === 4 && part !== "" ? "<account>" : part));
    return [...head, redactTail(parts.slice(5).join(":"))].join(":");
  }
  // A Google Cloud full resource name is `//<service>/projects/<project>/…/<name>`,
  // Aime's Supabase identifier is `supabase://<project>/…/<name>`, and an ARM id
  // names its subscription, group and resource in fixed positions. All end in
  // the name, and none puts a project or subscription elsewhere.
  return id
    .replace(/^supabase:\/\/[^/]+/, "supabase://<project>")
    .replace(/\/projects\/[^/]+/, "/projects/<project>")
    .replace(/\/subscriptions\/[^/]+/i, "/subscriptions/<subscription>")
    .replace(/\/resourceGroups\/[^/]+/i, "/resourceGroups/<group>")
    .replace(/([^/]+)$/, "<name>");
}

/** The ARN's tail with the name taken out: `function:<name>`, `stack/<name>`, `<name>`. */
function redactTail(tail: string): string {
  const separator = tail.search(/[/:]/);
  return separator === -1 ? "<name>" : `${tail.slice(0, separator + 1)}<name>`;
}

/**
 * Reads the answer, keeping only entries that are complete.
 *
 * Prose yields an empty list rather than a throw: the caller has to handle a
 * model that found nothing either way, and `cloud_check_reads` is the judge of
 * whether what remains can run.
 */
export function parseReadPlan(reply: string): { reads: PlannedRead[]; facts: ConnectionFact[] } {
  const empty = { reads: [], facts: [] };
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return empty;
  }
  const { reads, facts } = parsed as { reads?: unknown; facts?: unknown };
  return {
    reads: Array.isArray(reads)
      ? reads.map(asPlanned).filter((read): read is PlannedRead => read !== null)
      : [],
    facts: Array.isArray(facts)
      ? facts.map(asFact).filter((fact): fact is ConnectionFact => fact !== null)
      : [],
  };
}

function asFact(raw: unknown): ConnectionFact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { label, value } = raw as { label?: unknown; value?: unknown };
  if (typeof label !== "string" || typeof value !== "string") return null;
  if (label.trim() === "" || value.trim() === "") return null;
  return { label: label.trim(), value: value.trim() };
}

function asPlanned(raw: unknown): PlannedRead | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { purpose, label, args, program } = raw as {
    purpose?: unknown;
    label?: unknown;
    args?: unknown;
    program?: unknown;
  };
  if (typeof purpose !== "string" || !PURPOSES.includes(purpose as ReadPurpose)) return null;
  if (!Array.isArray(args) || args.length === 0) return null;
  const tokens = args.filter((token): token is string => typeof token === "string" && token.trim() !== "");
  if (tokens.length !== args.length) return null;
  return {
    purpose: purpose as ReadPurpose,
    label: typeof label === "string" && label.trim() !== "" ? label.trim() : tokens.join(" "),
    args: tokens.map((token) => token.trim()),
    program: typeof program === "string" ? program.trim() : "",
  };
}

/**
 * The command line one read becomes for one resource, for a person to copy.
 *
 * Display only: the Rust side (`cloud_run_read`) builds the line it actually
 * runs from the same plan, and this mirrors it so what is copied is what ran -
 * the placeholders filled, the account and the output format added.
 */
export function commandOf(
  cloudId: string,
  account: string,
  resource: PlaceholderSource,
  read: PlannedRead,
): string {
  const filled = read.args.map((arg) => fillSlots(arg, resource));
  // `bq` refuses a flag standing after the command's own arguments, so its
  // scope is prepended rather than appended - mirroring `reads.rs: run_read`.
  if (read.program === BIGQUERY_CLI) {
    return line([BIGQUERY_CLI, "--project_id", account, "--format", "prettyjson", ...filled]);
  }
  switch (cloudId) {
    case "aws": {
      const region = resource.location === "" ? [] : ["--region", resource.location];
      return line(["aws", ...filled, "--profile", account, ...region, "--output", "json"]);
    }
    case "gcp":
      return line(["gcloud", ...filled, "--project", account, "--format", "json"]);
    case "supabase":
      return line(["supabase", ...filled, "--project-ref", account, "-o", "json"]);
    default:
      return line(["az", ...filled, "--subscription", account, "--output", "json"]);
  }
}

/** What a placeholder can be filled from: the parts of one resource. */
export interface PlaceholderSource {
  id: string;
  name: string;
  cliName?: string;
  group: string;
  location: string;
}

/**
 * One template with this resource's own parts put in. Mirrors the Rust `fill`,
 * `<name>` included: the command gets the name the CLI takes, not the label
 * the panel shows.
 */
function fillSlots(template: string, resource: PlaceholderSource): string {
  const name = resource.cliName === undefined || resource.cliName === "" ? resource.name : resource.cliName;
  return template
    .replaceAll("<id>", resource.id)
    .replaceAll("<path>", pathOf(resource.id))
    .replaceAll("<name>", name)
    .replaceAll("<group>", resource.group)
    .replaceAll("<region>", resource.location);
}

/**
 * A connection fact as it reads for one resource, or null when it does not
 * read as one at all.
 *
 * The template is checked when the plan is kept (`cloud/reads.rs: check_fact`);
 * what cannot be checked there is what a particular resource puts INTO it.
 * Two things a filled value can turn out to be, both measured on real
 * resources, both dropped rather than shown with a copy button beside them:
 *
 * - one with a SPACE in it. `<name>` fills from the name the CLI takes rather
 *   than from the label now, which is where `projects/p/locations/global/keys/
 *   Server key 1` came from, but a cloud is free to answer a name with a space
 *   and no connection value has one.
 * - one with two `@`. A template that composes an address out of `<name>` is a
 *   guess about how the name is made, and for a Google service account the
 *   name IS the address: `<name>@<group>.iam.gserviceaccount.com` filled out
 *   as `svc@developer.gserviceaccount.com@p.iam.gserviceaccount.com`, which is
 *   nothing at all. No endpoint, URI or address has two.
 */
export function factFor(fact: ConnectionFact, resource: PlaceholderSource): string | null {
  const filled = fillSlots(fact.value, resource);
  const nonsense = /\s/.test(filled) || filled.split("@").length > 2;
  return nonsense ? null : filled;
}

/**
 * The identifier without the `//<service>/` a Google Cloud full resource name
 * starts with; any other identifier, whole. Mirrors the Rust `path_of`.
 */
function pathOf(id: string): string {
  if (!id.startsWith("//")) return id;
  const slash = id.indexOf("/", 2);
  return slash === -1 ? id : id.slice(slash + 1);
}

function line(tokens: string[]): string {
  return tokens.map(quoted).join(" ");
}

/**
 * A command line as a button reads it.
 *
 * A CLI Aime downloaded is invoked by its full quoted path, with PowerShell's
 * call operator on Windows (`& "C:\…\cloud-clis\supabase.exe" login`) - which
 * the terminal needs and a button does not. The button says `supabase login`;
 * the whole line stays in its tooltip. A command that starts with a bare name
 * is already readable and is left as it is.
 */
export function commandLabel(command: string): string {
  const invoked = /^(?:& )?"([^"]+)"(.*)$/.exec(command);
  if (invoked === null) return command;
  const [, path, rest] = invoked;
  const program = path.split(/[\\/]/).at(-1) ?? path;
  return `${program.replace(/\.exe$/i, "")}${rest}`;
}

/** A token as a shell takes it: quoted only when it has to be. */
function quoted(token: string): string {
  return /[\s"']/.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token;
}

/** One read Aime could not use, and why - the CLI's words or Aime's check. */
export interface FailedRead {
  /** The read as it was proposed, placeholders and all. */
  read: PlannedRead;
  /** Why it did not work, with this resource's own parts already taken out. */
  reason: string;
}

/**
 * Asks the AI to correct the reads that did not run, given what the CLI said.
 *
 * The loop this belongs to is the one a developer does at a terminal: run it,
 * read the error, fix the command, run it again. What makes it safe to hand
 * back is that the error is redacted first (`withPlaceholders`) - the model
 * sees `NOT_FOUND: Bucket \`<path>\` in location \`<region>\` does not exist`,
 * which is the whole of what it needs to fix the command, and nothing about
 * which project or resource it happened to. That keeps the promise the first
 * prompt makes: the AI plans a KIND, and never sees one of these resources.
 */
export function buildReadRepairPrompt(cloud: PlannableCloud, kind: string, failures: FailedRead[]): string {
  const cli = CLIS[cloud];
  return [
    `These ${cli.name} reads for \`${kind}\` did not work: Aime either refused them after reading the ` +
      "CLI's own help, or ran them against a real resource and the CLI refused them.",
    "Fix them, or drop the ones this kind has no working read for.",
    "",
    ...failures.flatMap((failure) => [
      `\`${cli.program} ${failure.read.args.join(" ")}\` (purpose: ${failure.read.purpose})`,
      `  ${failure.reason}`,
    ]),
    "",
    placeholderBrief(cloud),
    `Aime itself adds ${cli.scope} and ${cli.output} - never include them.`,
    `Purposes: ${PURPOSES.join(", ")} - the same three as before.`,
    "",
    "What matters here:",
    "- A wrong ARGUMENT is the usual cause: the command wants the resource's own id where it was " +
      "given a relative name, it takes the value in a flag rather than as a positional, or a flag " +
      "it requires is missing. Where a synopsis is quoted above, it is the CLI's own and it is the " +
      "answer.",
    "- Keep each read's PURPOSE. A `secret` rewritten as an overview is not a fix: it is the " +
      "credential read gone, and that is the one a developer opened this for.",
    "- A read you answer REPLACES the one with the same label, so rewrite every read above that is " +
      "wrong, not only the one you find most interesting.",
    "- Answer `facts` as well, all of them for this kind. They replace the ones Aime holds, which came " +
      "out of the same answer as the commands above and are wrong in the same way as often as not.",
    "- Do not answer with the same command again. If this kind has no read that works, leave it out: " +
      "an empty list is a true answer, and a command that fails is not.",
    cloud === "gcp"
      ? BIGQUERY_BRIEF
      : `- Every \`args\` list runs under \`${cli.program}\`. Another CLI cannot be used here even ` +
        "when it is the tool that would do this job, so a kind " +
        `\`${cli.program}\` has no read for has no read at all.`,
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    EXAMPLE_ANSWER[cloud],
  ].join("\n");
}

/**
 * One resource's own parts swapped back out for the placeholders they filled.
 *
 * Longest first, so a project id inside a full resource name goes with the
 * name rather than leaving `//service/projects/<group>/topics/x` behind.
 */
export function withPlaceholders(text: string, resource: PlaceholderSource): string {
  const name = resource.cliName === undefined || resource.cliName === "" ? resource.name : resource.cliName;
  const parts: [string, string][] = [
    [resource.id, "<id>"],
    [pathOf(resource.id), "<path>"],
    [name, "<name>"],
    [resource.name, "<name>"],
    [resource.group, "<group>"],
    [resource.location, "<region>"],
  ];
  return parts
    .filter(([part]) => part !== "")
    .sort(([left], [right]) => right.length - left.length)
    .reduce((redacted, [part, slot]) => redacted.split(part).join(slot), text);
}
