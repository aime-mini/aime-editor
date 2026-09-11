import type { CloudAccount, CloudResource } from "../stores/cloud";
import { shortKind } from "./cloudIcons";
import type { PlannedRead } from "./cloudReads";

/**
 * Deploying the open project to a cloud: what Aime asks the AI, how the answers
 * are read back, and the two checks Aime makes itself.
 *
 * Same shape as `cloudReads.ts` and for the same reason - the prompt, the type
 * and the parser in one file, so what is asked cannot drift from what is
 * expected. The AI here never holds the CLI: it reads the repository with
 * files-only tools and answers argument lists, which the Rust side
 * (`cloud/deploy.rs`) proves against the CLI's own `--help` and its own rules
 * before a person sees them, and runs itself after the person has agreed.
 */

/** The clouds Aime can deploy to; only these show the button. */
export const DEPLOYABLE: ReadonlySet<string> = new Set(["gcp"]);

/** What the repository turned out to be, in the AI's reading of it. */
export interface AppProfile {
  name: string;
  /** web | api | worker | static | functions | database - or the AI's own word. */
  kind: string;
  stack: string;
  /** The port the process listens on, when the code says. */
  port: number | null;
  /** The path that answers when the service is healthy. */
  healthPath: string;
  /** How it is built into something deployable: a Dockerfile, buildpacks, a static bundle… */
  builds: string;
}

/** A resource in the inventory that already is this application, and what says so. */
export interface ExistingMatch {
  resourceId: string;
  role: string;
  evidence: string;
}

/** Step one's answer: the app, what of it already runs, and what to read next. */
export interface Survey {
  app: AppProfile;
  existing: ExistingMatch[];
  /** Reads Aime should run before the plan is written - a `describe` of what exists. */
  inspect: PlannedRead[];
  /** What could not be determined from the repository. */
  missing: string[];
}

/** One read the plan promises to leave as it was, and where its value sits. */
export interface KeepRead {
  label: string;
  read: PlannedRead;
  /** Dotted path into the read's JSON answer, `spec.template.spec.containers.0.env`. */
  path: string;
}

/** How "running" is shown: a read that answers the URL, and what to ask it. */
export interface ProveRead {
  read: PlannedRead;
  urlPath: string;
  path: string;
  expect: number;
}

/** One command Aime runs; mirrors the Rust `DeployStep`. */
export interface DeployStep {
  label: string;
  args: string[];
  changes: string;
}

/** A file the AI wants in the repository before the steps run. */
export interface PlannedFile {
  path: string;
  why: string;
}

/** What the AI proposes when nothing of the app exists on the cloud yet. */
export interface Proposal {
  architecture: string;
  cost: string;
  performance: string;
}

/** Step two's answer, the plan a person confirms. */
export interface DeployPlan {
  summary: string;
  target: {
    /** True when a service for this app already runs - the keep rule then applies. */
    existing: boolean;
    resourceId: string | null;
    region: string;
  };
  proposal: Proposal | null;
  keep: KeepRead[];
  steps: DeployStep[];
  files: PlannedFile[];
  prove: ProveRead | null;
}

/** What the AI answers when a step failed: the rest of the plan, rewritten. */
export interface Revision {
  steps: DeployStep[];
  files: PlannedFile[];
  /** Reads it wants answered before it can say more; Aime runs them and asks again. */
  inspect: PlannedRead[];
  /** Set when the AI sees no way on; the run then stops with these words. */
  giveUp: string | null;
}

/** One thing the Rust check refused; mirrors the Rust `Rejected`. */
export interface Rejected {
  part: "step" | "keep" | "prove";
  label: string;
  reason: string;
}

/** What survived the Rust check; mirrors the Rust `CheckedPlan`. */
export interface CheckedPlan {
  steps: DeployStep[];
  keep: KeepRead[];
  prove: ProveRead | null;
  rejected: Rejected[];
}

/** One HTTP request to the deployed service; mirrors the Rust `Probe`. */
export interface Probe {
  status: number;
  durationMs: number;
  bodyHead: string;
}

/** A read Aime ran for the AI, with what came back. */
export interface ReadAnswer {
  label: string;
  /** The JSON answer, or the CLI's own words when it refused. */
  json: string;
  ok: boolean;
}

/** How many inventory rows the survey prompt carries; a project rarely has more. */
const INVENTORY_LIMIT = 300;
/** How much of one read answer the plan prompt carries. */
const ANSWER_LIMIT = 6_000;
/** How much of a failed command's output the fix prompt carries - its tail, where it explains itself. */
const OUTPUT_LIMIT = 6_000;

/** The one program whose presence changes the shape of a plan: build here, or in the cloud. */
export const TOOLING_TO_REPORT = ["docker"];

/**
 * The rules of the `gcloud` command line that decide whether a step runs, as
 * the checker enforces them. They are about the CLI, not about the user's app.
 */
const GCLOUD_RULES = [
  "- `args` are the arguments after `gcloud`, one token each, in the order the CLI takes them: command " +
    "words, then positionals, then flags. A flag and its value are two tokens (`--region`, `asia-southeast1`), " +
    "never `--region=…`.",
  "- Aime itself adds `--project` and `--account` to every command and `--format json` to every read - " +
    "never include them, and never `--quiet`: prompts are already disabled, so anything the CLI would have " +
    "asked (enable an API, allow unauthenticated access) must be an explicit step or flag. A command or read " +
    "that needs a location names it itself (`--region`, `asia-southeast1`).",
  "- A deployment adds and updates. Never `delete`, `destroy`, `purge`, `undelete` or a `remove-*` command; " +
    "never the `projects`, `billing`, `organizations`, `auth`, `config` or `components` groups - with one " +
    "exception: `projects add-iam-policy-binding` IS allowed, because a source build needs its service " +
    "account to have the roles for it. Its `--member` must be a `serviceAccount:` (never a person, a group " +
    "or `allUsers`) and its `--role` must be the narrow role that job needs - `roles/owner`, `roles/editor` " +
    "and the IAM-admin roles are refused.",
  "- Values hold letters, digits and `_.:/=,*@+-` only - no spaces, no quotes, nothing a shell could misread.",
].join("\n");

const KEEP_RULE =
  "- When a service for this app ALREADY EXISTS, its settings are kept: use `--update-env-vars`, " +
  "`--update-labels`, `--update-secrets` and the other `--update-*` flags, which merge. `--set-*`, `--clear-*` " +
  "and `--remove-*` replace or wipe what is there and Aime refuses them for an existing service.";

/**
 * Step one: read the repository, recognise what of it already runs, ask for the
 * reads a person would make before deploying by hand.
 */
export function surveyPrompt(input: { inventory: CloudResource[]; tooling: string[] }): string {
  const rows = input.inventory.slice(0, INVENTORY_LIMIT).map(inventoryLine);
  return [
    "You are preparing to deploy THIS repository to Google Cloud, to the project Aime targets. You can read " +
      "the repository (files only - you have no shell and no cloud CLI; Aime runs every command). Answer " +
      "the questions below from what the code, its Dockerfile, CI, deploy scripts and infrastructure files say.",
    "",
    "What already runs in the target project (kind, name, region, labels), as its inventory lists it:",
    rows.length === 0 ? "(nothing - the project holds no resources yet)" : rows.join("\n"),
    input.inventory.length > INVENTORY_LIMIT
      ? `(+${String(input.inventory.length - INVENTORY_LIMIT)} more not shown)`
      : "",
    "",
    `Tools on this machine: ${input.tooling.length === 0 ? "docker is NOT installed" : input.tooling.join(", ")}.`,
    "",
    "Answer:",
    "1. `app`: what this repository is - `name`, `kind` (web | api | worker | static | functions | database), " +
      "`stack`, `port` (number the process listens on, or null), `healthPath` (a path that answers when it is " +
      "up, `/` if none is declared), `builds` (how it becomes deployable: Dockerfile, buildpacks, static bundle…).",
    "2. `existing`: the inventory rows that ARE this application - its service, its database, its bucket - " +
      "each with `resourceId` copied exactly from the inventory, `role`, and `evidence` (what in the repository " +
      "or the row says so: a matching name, a label, a CI file that deploys to it). An empty list when nothing " +
      "matches; do not guess.",
    "3. `inspect`: the READ commands Aime should run so you can plan - the `describe` of each existing " +
      "resource, its current revision, its settings. Read-only (`describe`, `list`, `get`): each with a `label` " +
      "and `args`. Empty when nothing exists.",
    "4. `missing`: what you could not determine and will have to assume.",
    "",
    "RULES:",
    GCLOUD_RULES,
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    '{"app":{"name":"…","kind":"web","stack":"…","port":8080,"healthPath":"/","builds":"…"},' +
      '"existing":[{"resourceId":"//run.googleapis.com/projects/p/locations/r/services/s","role":"the service","evidence":"…"}],' +
      '"inspect":[{"purpose":"overview","label":"gcloud run services describe","args":["run","services","describe","s","--region","r"]}],' +
      '"missing":["…"]}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Step two: with the reads answered, write the plan a person will confirm.
 * `rejected` carries what the checker refused in the previous attempt, so the
 * second answer can be different for a reason.
 */
export function planPrompt(input: {
  survey: Survey;
  answers: ReadAnswer[];
  tooling: string[];
  rejected: Rejected[];
}): string {
  const { survey } = input;
  const lines = [
    "Write the plan to deploy THIS repository to Google Cloud, to the project Aime targets. Aime will show " +
      "the plan to the person, run each step itself after they confirm, and prove the result by asking the " +
      "deployed service over HTTP. You have no shell and no cloud CLI: every command is a `gcloud` argument list.",
    "",
    "The application, as you read it:",
    JSON.stringify(survey.app),
    "",
    survey.existing.length === 0
      ? "Nothing of this application exists in the project yet."
      : `Already in the project:\n${survey.existing.map((one) => `- ${one.role}: ${one.resourceId} (${one.evidence})`).join("\n")}`,
    "",
    ...(input.answers.length === 0
      ? []
      : [
          "What the reads you asked for answered:",
          ...input.answers.map(
            (answer) =>
              `### ${answer.label}${answer.ok ? "" : " (the CLI refused)"}\n${answer.json.slice(0, ANSWER_LIMIT)}`,
          ),
          "",
        ]),
    `Tools on this machine: ${input.tooling.length === 0 ? "docker is NOT installed - build in the cloud" : input.tooling.join(", ")}.`,
    "",
    "Answer:",
    "- `summary`: one sentence - what is deployed, where, how.",
    "- `target`: `existing` (true when a service for this app already runs), `resourceId` (that service's " +
      "inventory id, or null), `region`.",
    "- `proposal`: ONLY when nothing exists yet - the architecture you propose for this app, `cost` (what it " +
      "will cost at this app's likely load, and why this is the cheap choice), `performance` (what the person " +
      "gets and what they give up). Otherwise null.",
    "- `keep`: for an existing service, the settings you promise to leave as they are, each as a read " +
      "(`label`, `read` with `args`) and the dotted `path` to that setting in the read's JSON answer - the " +
      "environment variables, the scaling limits, the IAM bindings. Aime reads them before and after and " +
      "reports any that changed. Empty when nothing exists.",
    "- `steps`: the commands, in order, each with `label`, `args`, `changes` (what it changes on the cloud). " +
      "Enable every API the steps need as an explicit step. Make the build a step or part of one; deploying " +
      "from source builds in the cloud and needs no docker here.",
    "- `files`: files that must exist in the repository first (a Dockerfile, a .gcloudignore), each with " +
      "`path` and `why`. Aime asks you to write them after the person confirms. Empty when none.",
    "- `prove`: the read that answers the deployed URL - `read` (`label`, `args`), `urlPath` (dotted path to " +
      "the URL in its JSON answer), `path` (the path to request, the health path), `expect` (the HTTP status " +
      "that means running).",
    "",
    "RULES:",
    GCLOUD_RULES,
    KEEP_RULE,
    "- Every step must be one the person can read and agree to; nothing the plan does not name will run.",
  ];
  if (input.rejected.length > 0) {
    lines.push(
      "",
      "Your previous plan had parts Aime refused. Write a plan without them - a different command, a " +
        "different flag, or nothing - and do not repeat any of these:",
      ...input.rejected.map((one) => `- ${one.part} \`${one.label}\`: ${one.reason}`),
    );
  }
  lines.push(
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    '{"summary":"…","target":{"existing":false,"resourceId":null,"region":"asia-southeast1"},' +
      '"proposal":{"architecture":"…","cost":"…","performance":"…"},' +
      '"keep":[{"label":"environment variables","read":{"purpose":"overview","label":"gcloud run services describe","args":["run","services","describe","web","--region","asia-southeast1"]},"path":"spec.template.spec.containers.0.env"}],' +
      '"steps":[{"label":"Enable the APIs","args":["services","enable","run.googleapis.com"],"changes":"the project\'s enabled APIs"}],' +
      '"files":[{"path":"Dockerfile","why":"…"}],' +
      '"prove":{"read":{"purpose":"overview","label":"gcloud run services describe","args":["run","services","describe","web","--region","asia-southeast1"]},"urlPath":"status.url","path":"/","expect":200}}',
  );
  return lines.join("\n");
}

/** The files-only edits turn that writes what the plan asked for. */
export function filesPrompt(files: PlannedFile[], plan: DeployPlan): string {
  return [
    "Write these files into this repository, exactly as the deployment plan below needs them. Write the " +
      "files and nothing else: do not run anything, do not change other files, do not commit.",
    "",
    ...files.map((file) => `- ${file.path}: ${file.why}`),
    "",
    "The plan:",
    plan.summary,
    ...plan.steps.map((step) => `- ${step.label}: gcloud ${step.args.join(" ")}`),
  ].join("\n");
}

/**
 * The fix loop's question: a step failed (or the service did not answer); here
 * is what it said, here is what was still to run - rewrite the remainder.
 */
export function fixPrompt(input: {
  plan: DeployPlan;
  failed: { label: string; command: string; output: string };
  remaining: DeployStep[];
  answers: ReadAnswer[];
  rejected: Rejected[];
}): string {
  const lines = [
    "A step of the deployment failed. Read what the CLI said, and rewrite the steps still to run so the " +
      "deployment completes. You may edit files in the repository (files only - no shell, no cloud CLI); " +
      "Aime runs every command.",
    "",
    "The plan:",
    input.plan.summary,
    "",
    `Failed: ${input.failed.label}`,
    `$ ${input.failed.command}`,
    input.failed.output.slice(-OUTPUT_LIMIT),
    "",
    input.remaining.length === 0
      ? "Every step had run; the failure is what happened after them."
      : `Still to run:\n${input.remaining.map((step) => `- ${step.label}: gcloud ${step.args.join(" ")}`).join("\n")}`,
    ...(input.answers.length === 0
      ? []
      : [
          "",
          "What the reads you asked for answered:",
          ...input.answers.map(
            (answer) =>
              `### ${answer.label}${answer.ok ? "" : " (the CLI refused)"}\n${answer.json.slice(0, ANSWER_LIMIT)}`,
          ),
        ]),
    "",
    "Answer:",
    "- `steps`: the steps to run now, from the failed one on - fixed, replaced or added. Same target, same " +
      "service; a different target is a different plan and needs the person again.",
    "- `files`: files to write or change first, each with `path` and `why`. You write them yourself in this turn.",
    "- `inspect`: reads you need answered before you can decide (logs, the service's state). Aime runs them " +
      "and asks you again with the answers; leave `steps` empty when you ask.",
    "- `giveUp`: a sentence when there is no way on - when the fix needs a person (billing, a quota, a " +
      "permission). Otherwise null.",
    "",
    "RULES:",
    GCLOUD_RULES,
    KEEP_RULE,
  ];
  if (input.rejected.length > 0) {
    lines.push(
      "",
      "Aime refused these from your previous answer; do not repeat them:",
      ...input.rejected.map((one) => `- ${one.part} \`${one.label}\`: ${one.reason}`),
    );
  }
  lines.push(
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    '{"steps":[{"label":"…","args":["run","deploy","web","--source",".","--region","asia-southeast1"],"changes":"…"}],' +
      '"files":[],"inspect":[],"giveUp":null}',
  );
  return lines.join("\n");
}

/** One inventory row as the prompt shows it: `kind  name  region  a=b,c=d`. */
function inventoryLine(resource: CloudResource): string {
  const labels = Object.entries(resource.tags)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return [shortKind(resource.kind), resource.name, resource.location || "-", labels || "-", resource.id].join(
    "  ",
  );
}

export function parseSurvey(reply: string): Survey | null {
  const raw = asRecord(extractObject(reply));
  const app = asRecord(raw.app);
  if (asString(app.name) === "" && asString(app.kind) === "") return null;
  const port = typeof app.port === "number" && Number.isFinite(app.port) ? app.port : null;
  return {
    app: {
      name: asString(app.name),
      kind: asString(app.kind),
      stack: asString(app.stack),
      port,
      healthPath: asString(app.healthPath) || "/",
      builds: asString(app.builds),
    },
    existing: asArray(raw.existing).flatMap((one) => {
      const match = asRecord(one);
      const resourceId = asString(match.resourceId);
      return resourceId === ""
        ? []
        : [{ resourceId, role: asString(match.role), evidence: asString(match.evidence) }];
    }),
    inspect: asArray(raw.inspect).flatMap(asRead),
    missing: asArray(raw.missing).map(asString).filter(Boolean),
  };
}

export function parsePlan(reply: string): DeployPlan | null {
  const raw = asRecord(extractObject(reply));
  const steps = asArray(raw.steps).flatMap(asStep);
  if (steps.length === 0) return null;
  const target = asRecord(raw.target);
  const proposal = raw.proposal === null || raw.proposal === undefined ? null : asRecord(raw.proposal);
  return {
    summary: asString(raw.summary),
    target: {
      existing: target.existing === true,
      resourceId: asString(target.resourceId) || null,
      region: asString(target.region),
    },
    proposal:
      proposal === null
        ? null
        : {
            architecture: asString(proposal.architecture),
            cost: asString(proposal.cost),
            performance: asString(proposal.performance),
          },
    keep: asArray(raw.keep).flatMap(asKeep),
    steps,
    files: asArray(raw.files).flatMap(asFile),
    prove: asProve(raw.prove),
  };
}

export function parseRevision(reply: string): Revision | null {
  const raw = asRecord(extractObject(reply));
  const revision: Revision = {
    steps: asArray(raw.steps).flatMap(asStep),
    files: asArray(raw.files).flatMap(asFile),
    inspect: asArray(raw.inspect).flatMap(asRead),
    giveUp: asString(raw.giveUp) || null,
  };
  const saysSomething = revision.steps.length > 0 || revision.inspect.length > 0 || revision.giveUp !== null;
  return saysSomething ? revision : null;
}

function asStep(value: unknown): DeployStep[] {
  const raw = asRecord(value);
  const args = asArray(raw.args).map(asString).filter(Boolean);
  if (args.length === 0) return [];
  return [{ label: asString(raw.label) || args.join(" "), args, changes: asString(raw.changes) }];
}

function asRead(value: unknown): PlannedRead[] {
  const raw = asRecord(value);
  const args = asArray(raw.args).map(asString).filter(Boolean);
  if (args.length === 0) return [];
  // The checker raises what looks sensitive; the plan's own word is the start.
  return [{ purpose: "overview", label: asString(raw.label) || args.join(" "), args }];
}

function asKeep(value: unknown): KeepRead[] {
  const raw = asRecord(value);
  const read = asRead(raw.read).at(0);
  const path = asString(raw.path);
  if (read === undefined || path === "") return [];
  return [{ label: asString(raw.label) || read.label, read, path }];
}

function asFile(value: unknown): PlannedFile[] {
  const raw = asRecord(value);
  const path = asString(raw.path);
  return path === "" ? [] : [{ path, why: asString(raw.why) }];
}

function asProve(value: unknown): ProveRead | null {
  const raw = asRecord(value);
  const read = asRead(raw.read).at(0);
  const urlPath = asString(raw.urlPath);
  if (read === undefined || urlPath === "") return null;
  const expect = typeof raw.expect === "number" && Number.isInteger(raw.expect) ? raw.expect : 200;
  const path = asString(raw.path) || "/";
  return { read, urlPath, path: path.startsWith("/") ? path : `/${path}`, expect };
}

/**
 * The value at a dotted path in a JSON document - `spec.template.spec.containers.0.env` -
 * or undefined when the path leaves the document. A segment that is all digits
 * indexes an array; anything else is a key.
 */
export function valueAt(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** The URL a prove read answered, or null when the document has none there. */
export function urlIn(json: string, urlPath: string): string | null {
  const value = valueAt(parseJson(json), urlPath);
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}

/**
 * The settings the plan promised to keep that did NOT survive: each `keep`
 * whose value differs between the read taken before the steps and the one
 * taken after. Compared as canonical JSON, so key order is not a difference.
 * A read that failed on either side counts as changed - a promise Aime could
 * not check is not a promise kept.
 */
export function overwritten(keeps: KeepRead[], before: ReadAnswer[], after: ReadAnswer[]): KeepRead[] {
  return keeps.filter((keep) => {
    const was = before.find((one) => one.label === keep.read.label);
    const now = after.find((one) => one.label === keep.read.label);
    if (was === undefined || now === undefined || !was.ok || !now.ok) return true;
    return (
      canonical(valueAt(parseJson(was.json), keep.path)) !==
      canonical(valueAt(parseJson(now.json), keep.path))
    );
  });
}

/** A step exactly as Aime runs it, for the confirm page and the log. */
export function commandLine(step: DeployStep, account: CloudAccount): string {
  const scoped = [...step.args, "--project", account.id];
  if (account.owner !== "") scoped.push("--account", account.owner);
  return ["gcloud", ...scoped].map(quoted).join(" ");
}

/** A read as Aime runs it. */
export function readLine(read: PlannedRead, account: CloudAccount): string {
  return commandLine({ label: read.label, args: read.args, changes: "" }, account) + " --format json";
}

function quoted(token: string): string {
  return /[\s"']/.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The first JSON object in a reply, however much prose or fencing surrounds it. */
function extractObject(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(reply.slice(start, end + 1)) as unknown;
  } catch {
    return {};
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
