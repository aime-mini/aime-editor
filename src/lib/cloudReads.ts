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
}

/** A read Aime refused, and why; mirrors the Rust `RejectedRead`. */
export interface RejectedRead {
  label: string;
  reason: string;
}

/** What Aime kept for one kind and what it would not; mirrors the Rust `ReadPlan`. */
export interface ReadPlan {
  reads: PlannedRead[];
  rejected: RejectedRead[];
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
    "Placeholders Aime fills: `<id>` the full identifier above, `<path>` the identifier without its " +
      "`//service/` head (`projects/…`), `<name>` the resource name, " +
      `\`<group>\` the ${cli.group}, \`<region>\` the location - ` +
      (cloud === "gcp" ? "a zone for a zonal resource, a region for a regional one." : "the region."),
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
      "- A resource INSIDE a project (`projects/<project>/zones/…`, `projects/<project>/locations/…`) is " +
        "described by its relative name: pass `<path>` as the positional and no `--zone`/`--region` " +
        "(`compute instances describe <path>`). A bucket is `gs://<name>`. The project itself " +
        "(`cloudresourcemanager.googleapis.com/Project`) and other top-level resources take the bare id: " +
        "`projects describe <group>` - `projects describe projects/<id>` is INVALID_ARGUMENT.",
      "- Positionals come right after the command, before any flag. A flag and its value are two tokens " +
        "(`--zone`, `<region>`), never `--zone=<region>`.",
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
  lines.push("", "Answer with ONLY this JSON, no prose and no code fence:", EXAMPLE_ANSWER[cloud]);
  return lines.join("\n");
}

/** One well-formed answer per cloud, in that CLI's own spelling. */
const EXAMPLE_ANSWER: Record<PlannableCloud, string> = {
  azure:
    '{"reads":[{"purpose":"connection","label":"az webapp config hostname list","args":["webapp","config","hostname","list","--webapp-name","<name>","--resource-group","<group>"]}]}',
  aws: '{"reads":[{"purpose":"overview","label":"aws lambda get-function","args":["lambda","get-function","--function-name","<name>"]}]}',
  gcp: '{"reads":[{"purpose":"overview","label":"gcloud compute instances describe","args":["compute","instances","describe","<path>"]}]}',
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
export function parseReadPlan(reply: string): PlannedRead[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const reads = (parsed as { reads?: unknown }).reads;
  if (!Array.isArray(reads)) return [];
  return reads.map(asPlanned).filter((read): read is PlannedRead => read !== null);
}

function asPlanned(raw: unknown): PlannedRead | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { purpose, label, args } = raw as { purpose?: unknown; label?: unknown; args?: unknown };
  if (typeof purpose !== "string" || !PURPOSES.includes(purpose as ReadPurpose)) return null;
  if (!Array.isArray(args) || args.length === 0) return null;
  const tokens = args.filter((token): token is string => typeof token === "string" && token.trim() !== "");
  if (tokens.length !== args.length) return null;
  return {
    purpose: purpose as ReadPurpose,
    label: typeof label === "string" && label.trim() !== "" ? label.trim() : tokens.join(" "),
    args: tokens.map((token) => token.trim()),
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
  resource: { id: string; name: string; group: string; location: string },
  read: PlannedRead,
): string {
  const filled = read.args.map((arg) =>
    arg
      .replaceAll("<id>", resource.id)
      .replaceAll("<path>", pathOf(resource.id))
      .replaceAll("<name>", resource.name)
      .replaceAll("<group>", resource.group)
      .replaceAll("<region>", resource.location),
  );
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
