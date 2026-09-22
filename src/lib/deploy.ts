import type { CloudAccount, CloudResource } from "../stores/cloud";
import { shortKind } from "./cloudIcons";
import type { PlannedRead } from "./cloudReads";
import { dialectOf, recipeOf } from "./deployDialect";

export { DEPLOYABLE } from "./deployDialect";

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
  /**
   * The scheme the endpoint answers on, when the read hands back a bare host.
   *
   * `https` unless the plan says otherwise, which is right for every managed
   * front end here - Cloud Run, App Engine, a global load balancer. It is
   * wrong for exactly the case that needs saying: a Kubernetes `type:
   * LoadBalancer` Service is an L4 address with no certificate on it, serving
   * plain HTTP, and asking it over https proves nothing about a deploy that
   * worked.
   */
  scheme?: string;
}

/** One command Aime runs; mirrors the Rust `DeployStep`. */
export interface DeployStep {
  /**
   * Which CLI runs this step; absent or empty for the cloud's own.
   *
   * Google Cloud is two CLIs for a deploy as it is for a read: `gcloud` makes
   * a GKE cluster and cannot put a workload in one, so a Kubernetes step says
   * `kubectl`. Rust is the gate (`cloud/k8s.rs`) - a name it does not allow for
   * that cloud, or a `kubectl` command that is not a deployment, is refused
   * there and never reaches a command line.
   */
  program?: string;
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

/** One exchange at the confirm page: what the person asked, what Aime answered. */
export interface DeployNote {
  asked: string;
  /** The AI's reply, empty only while the next plan is still being written. */
  answered: string;
}

/** Step two's answer, the plan a person confirms. */
export interface DeployPlan {
  summary: string;
  /**
   * The answer to the person's last note, in their terms rather than the
   * plan's.
   *
   * A revision used to come back as a new plan and nothing else: the person
   * said "cheaper tier", the page redrew, and whether that had been heard,
   * refused or quietly ignored had to be inferred by diffing two plans. The
   * plan now says it. Empty on the first plan, when nothing has been asked.
   */
  reply: string;
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
  /**
   * The answer to the person, when they said something while the run was going
   * on. Empty whenever they did not: a fix nobody asked for answers nobody.
   */
  reply: string;
}

/**
 * What the AI answers when the person speaks and nothing has failed.
 *
 * `steps` may be empty - "nothing to change" is a real answer to "put it in
 * eastasia" when it already is - so `reply` is what makes the answer an
 * answer, and one of the two must say something.
 */
export interface Steer {
  reply: string;
  /** The remainder, rewritten in full; empty leaves the confirmed steps as they are. */
  steps: DeployStep[];
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
 * Step one: read the repository, recognise what of it already runs, ask for the
 * reads a person would make before deploying by hand.
 */
export function surveyPrompt(input: {
  cloudId: string;
  inventory: CloudResource[];
  tooling: string[];
}): string {
  const dialect = dialectOf(input.cloudId);
  const recipe = recipeOf(input.cloudId);
  const rows = input.inventory.slice(0, INVENTORY_LIMIT).map(inventoryLine);
  return [
    `You are preparing to deploy THIS repository to ${dialect.cloud}, to the ${recipe.target} Aime ` +
      "targets. You can read the repository (files only - you have no shell and no cloud CLI; Aime runs " +
      "every command). Answer the questions below from what the code, its Dockerfile, CI, deploy scripts " +
      "and infrastructure files say.",
    "",
    `What already runs in the target ${recipe.target} (kind, name, region, labels), as its inventory lists it:`,
    rows.length === 0 ? `(nothing - the ${recipe.target} holds no resources yet)` : rows.join("\n"),
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
    recipe.rules,
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    '{"app":{"name":"…","kind":"web","stack":"…","port":8080,"healthPath":"/","builds":"…"},' +
      `"existing":[{"resourceId":"${recipe.resourceId}","role":"the service","evidence":"…"}],` +
      `"inspect":[${recipe.inspect}],` +
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
  cloudId: string;
  survey: Survey;
  answers: ReadAnswer[];
  tooling: string[];
  rejected: Rejected[];
  /**
   * What the person asked for after reading a plan, in their own words.
   *
   * The confirm page is where someone first sees what would actually run, and
   * it is the natural place to say "use the cheaper tier" or "put it in this
   * region". Each note is carried into every later plan, so the third revision
   * still honours the first request. A note is a REQUEST and not a permission:
   * it cannot widen what the checker will run, which the rules below say
   * plainly, because a model told to "just delete the old one" would otherwise
   * spend a turn writing a command that is refused.
   */
  notes: DeployNote[];
}): string {
  const { survey } = input;
  const dialect = dialectOf(input.cloudId);
  const recipe = recipeOf(input.cloudId);
  const lines = [
    `Write the plan to deploy THIS repository to ${dialect.cloud}, to the ${recipe.target} Aime targets. ` +
      "Aime will show the plan to the person, run each step itself after they confirm, and prove the " +
      "result by asking the deployed service over HTTP. You have no shell and no cloud CLI: every command " +
      `is an \`${dialect.program}\` argument list.`,
    "",
    "The application, as you read it:",
    JSON.stringify(survey.app),
    "",
    survey.existing.length === 0
      ? `Nothing of this application exists in the ${recipe.target} yet.`
      : `Already in the ${recipe.target}:\n${survey.existing.map((one) => `- ${one.role}: ${one.resourceId} (${one.evidence})`).join("\n")}`,
    "",
    ...(input.notes.length === 0
      ? []
      : [
          "What the person asked for after reading your last plan, in their own words, and what you " +
            "answered. Every request still applies to the plan you are about to write:",
          ...input.notes.flatMap((note) =>
            note.answered === ""
              ? [`- they asked: ${note.asked}`]
              : [`- they asked: ${note.asked}`, `  you answered: ${note.answered}`],
          ),
          "",
        ]),
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
    "- `reply`: what you say back to the person about their LAST request, in one or two sentences and in " +
      "their own terms - what you changed, or why you could not and what you did instead. Not a summary " +
      "of the plan; an answer to them. Empty string when they have asked for nothing yet.",
    "- `target`: `existing` (true when a service for this app already runs), `resourceId` (that service's " +
      "inventory id, or null), `region`.",
    "- `proposal`: ONLY when nothing exists yet - the architecture you propose for this app, `cost` (what it " +
      "will cost at this app's likely load, and why this is the cheap choice), `performance` (what the person " +
      "gets and what they give up). Otherwise null.",
    "- `keep`: for an existing service, the settings you promise to leave as they are, each as a read " +
      "(`label`, `read` with `args`) and the dotted `path` to that setting in the read's JSON answer - the " +
      "environment variables, the scaling limits, the IAM bindings. Aime reads them before and after and " +
      "reports any that changed. Empty when nothing exists.",
    "- `steps`: the commands, in order, each with `label`, `args`, `changes` (what it changes on the cloud) " +
      `and, only when it is not \`${dialect.program}\`, \`program\`. Whatever the cloud must have switched ` +
      "on before a step can work - an API, a resource provider - is an explicit step of its own. Make the " +
      "build a step or part of one; deploying from source builds in the cloud and needs no docker here.",
    "- `files`: files that must exist in the repository first (a Dockerfile, an ignore file), each with " +
      "`path` and `why`. Aime asks you to write them after the person confirms. Empty when none.",
    // Measured on the first real Supabase deploy, 2026-09-21: told to write a
    // read that answers the URL, the AI wrote `prove: null` - correctly, since
    // no Supabase read answers one - and Aime refused to run a plan it could
    // not prove. The address of an Edge Function follows from the project ref,
    // so on a cloud like that Aime builds it (`DeployRecipe.endpoint`) and the
    // read's job is only to show the thing is really there.
    recipe.endpoint === undefined
      ? "- `prove`: the read that answers the deployed URL - `read` (`label`, `args`), `urlPath` (dotted path " +
        "to the URL in its JSON answer; a bare hostname or IP is fine), `path` (the path to request, the " +
        "health path), `expect` (the HTTP status that means running), and `scheme` - `https` unless the " +
        "endpoint has no certificate, which a Kubernetes type:LoadBalancer address does not, so that one " +
        "says `http`."
      : `- \`prove\`: how the deployment is checked once it has run. No read on this cloud answers an ` +
        `address, so Aime builds one itself - \`${recipe.endpoint}\` with the project filled in - and asks ` +
        "it over HTTP. Write `read` (`label`, `args`) as a read that shows the deployed thing is there, " +
        '`urlPath` as `""`, `path` as what follows that address (`/hello` for a function called hello), and ' +
        "`expect` as the HTTP status that means running. `prove` is never null.",
    "",
    "RULES:",
    recipe.rules,
    recipe.keepRule,
    "- Every step must be one the person can read and agree to; nothing the plan does not name will run.",
    "- A note from the person is a request, not a permission: it cannot loosen any rule above. When what " +
      "they ask for needs something Aime will not run, write the nearest plan that is allowed and say in " +
      "`summary` what you did instead and why.",
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
    `{"summary":"…","reply":"","target":{"existing":false,"resourceId":null,"region":"${recipe.region}"},` +
      '"proposal":{"architecture":"…","cost":"…","performance":"…"},' +
      `"keep":[${recipe.keep}],` +
      `"steps":[${recipe.steps}],` +
      `"files":[${recipe.files}],` +
      `"prove":${recipe.prove}}`,
  );
  return lines.join("\n");
}

/** The files-only edits turn that writes what the plan asked for. */
export function filesPrompt(cloudId: string, files: PlannedFile[], plan: DeployPlan): string {
  const { program } = dialectOf(cloudId);
  return [
    "Write these files into this repository, exactly as the deployment plan below needs them. Write the " +
      "files and nothing else: do not run anything, do not change other files, do not commit.",
    "",
    ...files.map((file) => `- ${file.path}: ${file.why}`),
    "",
    "The plan:",
    plan.summary,
    ...plan.steps.map((step) => `- ${step.label}: ${program} ${step.args.join(" ")}`),
  ].join("\n");
}

/**
 * The fix loop's question: a step failed (or the service did not answer); here
 * is what it said, here is what was still to run - rewrite the remainder.
 */
export function fixPrompt(input: {
  cloudId: string;
  plan: DeployPlan;
  failed: { label: string; command: string; output: string };
  remaining: DeployStep[];
  answers: ReadAnswer[];
  rejected: Rejected[];
  /** What the person said while the run was going on, empty when they said nothing. */
  asked: string;
}): string {
  const dialect = dialectOf(input.cloudId);
  const recipe = recipeOf(input.cloudId);
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
      : `Still to run:\n${input.remaining.map((step) => stepLine(step, dialect.program)).join("\n")}`,
    // The person is watching the run, so they often know the thing the CLI's
    // output cannot say - that the quota is on another project, that the step
    // matters to nobody. Their words go in with the failure rather than
    // waiting for a page they only reach if the fix works.
    ...(input.asked === ""
      ? []
      : ["", "The person watching this run said, while it was failing:", `> ${input.asked}`]),
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
    input.asked === ""
      ? "- `reply`: empty string - nobody asked you anything."
      : "- `reply`: your answer to what the person just said, in one or two sentences and in their own " +
        "terms - what you did about it, or why you could not and what you did instead.",
    "",
    "RULES:",
    recipe.rules,
    recipe.keepRule,
    ...(input.asked === ""
      ? []
      : [
          "- What the person said is a request, not a permission: it cannot loosen any rule above. When " +
            "what they ask for needs something Aime will not run, write the nearest fix that is allowed " +
            "and say so in `reply`.",
        ]),
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
      '"files":[],"inspect":[],"giveUp":null,"reply":""}',
  );
  return lines.join("\n");
}

/**
 * What the person said while the deployment was running and nothing had failed.
 *
 * Asked between two steps, never during one: a command that is halfway through
 * putting a repository into a cloud is finished before anyone is consulted,
 * and Stop - not a sentence - is what ends a command in flight. So the AI is
 * told exactly what has already happened, because none of that can be taken
 * back by rewriting the rest.
 */
export function steerPrompt(input: {
  cloudId: string;
  plan: DeployPlan;
  asked: string;
  ran: string[];
  remaining: DeployStep[];
}): string {
  const dialect = dialectOf(input.cloudId);
  const recipe = recipeOf(input.cloudId);
  return [
    "A deployment of this repository is running and the person watching it said this:",
    `> ${input.asked}`,
    "",
    "Nothing has failed. Aime has paused between two steps to put it to you, and runs whatever you " +
      "answer once it has checked it. You have no shell and no cloud CLI: every command is an " +
      `\`${dialect.program}\` argument list, and you may edit files in this repository.`,
    "",
    "The plan they confirmed:",
    input.plan.summary,
    "",
    input.ran.length === 0
      ? "No step has run yet."
      : `Already run - this cannot be undone by rewriting anything:\n${input.ran.map((label) => `- ${label}`).join("\n")}`,
    "",
    input.remaining.length === 0
      ? "Every step has run; only asking the deployed service is left."
      : `Still to run:\n${input.remaining.map((step) => stepLine(step, dialect.program)).join("\n")}`,
    "",
    "Answer:",
    "- `reply`: your answer to them, in one or two sentences and in their own terms - what you changed, " +
      "or why you could not and what happens instead. An answer to the person, not a summary of the plan.",
    "- `steps`: the steps still to run, rewritten - ALL of them in order, including the ones you leave " +
      "as they are. An empty list means the deployment goes on exactly as confirmed, which is the right " +
      "answer whenever what they asked for is already true or cannot be done from here.",
    "",
    "RULES:",
    recipe.rules,
    recipe.keepRule,
    "- What they said is a request, not a permission: it cannot loosen any rule above, and it cannot " +
      "move the deployment to a different target. When it needs something Aime will not run, leave " +
      "`steps` empty and say so in `reply`.",
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    '{"reply":"…","steps":[]}',
  ].join("\n");
}

/**
 * One step as a prompt shows it, under the CLI that actually runs it - which
 * is not always the cloud's own (`DeployStep.program`).
 */
function stepLine(step: DeployStep, program: string): string {
  const named = step.program !== undefined && step.program !== "" ? step.program : program;
  return `- ${step.label}: ${named} ${step.args.join(" ")}`;
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

export function parsePlan(reply: string, urlFromRead = true): DeployPlan | null {
  const raw = asRecord(extractObject(reply));
  const steps = asArray(raw.steps).flatMap(asStep);
  if (steps.length === 0) return null;
  const target = asRecord(raw.target);
  const proposal = raw.proposal === null || raw.proposal === undefined ? null : asRecord(raw.proposal);
  return {
    summary: asString(raw.summary),
    reply: asString(raw.reply),
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
    prove: asProve(raw.prove, urlFromRead),
  };
}

export function parseRevision(reply: string): Revision | null {
  const raw = asRecord(extractObject(reply));
  const revision: Revision = {
    steps: asArray(raw.steps).flatMap(asStep),
    files: asArray(raw.files).flatMap(asFile),
    inspect: asArray(raw.inspect).flatMap(asRead),
    giveUp: asString(raw.giveUp) || null,
    reply: asString(raw.reply),
  };
  // A reply alone is not a fix: the run is stopped at a failed step and words
  // do not restart it.
  const saysSomething = revision.steps.length > 0 || revision.inspect.length > 0 || revision.giveUp !== null;
  return saysSomething ? revision : null;
}

export function parseSteer(reply: string): Steer | null {
  const raw = asRecord(extractObject(reply));
  const steer: Steer = { reply: asString(raw.reply), steps: asArray(raw.steps).flatMap(asStep) };
  return steer.reply === "" && steer.steps.length === 0 ? null : steer;
}

function asStep(value: unknown): DeployStep[] {
  const raw = asRecord(value);
  const args = asArray(raw.args).map(asString).filter(Boolean);
  if (args.length === 0) return [];
  const program = asString(raw.program);
  return [{ label: asString(raw.label) || args.join(" "), args, changes: asString(raw.changes), program }];
}

function asRead(value: unknown): PlannedRead[] {
  const raw = asRecord(value);
  const args = asArray(raw.args).map(asString).filter(Boolean);
  if (args.length === 0) return [];
  // The checker raises what looks sensitive; the plan's own word is the start.
  // `program` is carried for the same reason a step carries one: a cluster is
  // read with `kubectl`, and Rust is the gate (`cloud/k8s.rs`).
  return [
    {
      purpose: "overview",
      label: asString(raw.label) || args.join(" "),
      args,
      program: asString(raw.program),
    },
  ];
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

function asProve(value: unknown, urlFromRead: boolean): ProveRead | null {
  const raw = asRecord(value);
  const read = asRead(raw.read).at(0);
  const urlPath = asString(raw.urlPath);
  // A path into the answer is required exactly where the answer is where the
  // address comes from. On a cloud whose recipe carries an `endpoint` it is
  // not: Aime builds the address from the account, and the read only shows
  // the deployed thing is there. Measured on the first real Supabase deploy,
  // 2026-09-21 - the plan was good, the empty `urlPath` dropped it here, and
  // the run stopped saying nothing could prove the deployment.
  if (read === undefined || (urlFromRead && urlPath === "")) return null;
  const expect = typeof raw.expect === "number" && Number.isInteger(raw.expect) ? raw.expect : 200;
  const path = asString(raw.path) || "/";
  // Two schemes and no others: anything else is a plan Aime would be guessing
  // at, and https is the answer for every managed front end.
  const said = asString(raw.scheme).toLowerCase();
  const scheme = said === "http" || said === "https" ? said : "https";
  return { read, urlPath, path: path.startsWith("/") ? path : `/${path}`, expect, scheme };
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
      current = segment.includes("=") ? elementWhere(current, segment) : current[indexIn(segment)];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** An array segment that is not a `field=value` selector must be an index. */
function indexIn(segment: string): number {
  const index = Number(segment);
  return Number.isInteger(index) ? index : -1;
}

/**
 * The element of a list whose `field` is `value`, for a `field=value` segment.
 *
 * AWS answers in key-and-value lists - `Outputs`, `Parameters`, `Tags` - and
 * measured 2026-09-22 on a real stack, `describe-stacks` returns Outputs in
 * ALPHABETICAL order of their key, not in the order the template declares
 * them: a template whose first output was `SiteUrl` came back
 * `BucketName`, `DistributionId`, `SiteUrl`. So a position is not a way to
 * name one of them, and `Stacks.0.Outputs.OutputKey=SiteUrl.OutputValue` is.
 */
function elementWhere(list: unknown[], selector: string): unknown {
  const cut = selector.indexOf("=");
  const field = selector.slice(0, cut);
  const wanted = selector.slice(cut + 1);
  return list.find(
    (element) =>
      element !== null &&
      typeof element === "object" &&
      (element as Record<string, unknown>)[field] === wanted,
  );
}

/**
 * The URL a prove read answered, or null when the document has none there.
 *
 * Not every front end answers a URL. Measured 2026-09-12 on a real App Engine
 * deploy: `gcloud app describe` answers `defaultHostname:
 * <app>.as.r.appspot.com` - a HOST - where Cloud Run's `status.url` is a whole
 * `https://…`. The deploy had worked and the app was serving `hello from Aime`;
 * Aime called it unproved, asked the AI to rewrite the step, failed the same way
 * and stopped. A bare host is read as `https://<host>`: these front ends serve
 * on nothing else, and a host is the only other shape a describe answers.
 */
export function urlIn(json: string, urlPath: string, scheme = "https"): string | null {
  const value = valueAt(parseJson(json), urlPath);
  if (typeof value !== "string") return null;
  const answered = value.trim();
  if (/^https?:\/\//.test(answered)) return answered;
  return isHostname(answered) ? `${scheme}://${answered}` : null;
}

/**
 * Whether a value is a bare hostname - dotted labels and nothing else.
 *
 * Deliberately narrow: a scheme, a path, a port, a space or a single label all
 * fail it, so a field holding a bucket name, an id or a sentence is still "no
 * URL here" rather than something Aime would go on to request.
 */
function isHostname(value: string): boolean {
  // An IPv4 address passes this too, deliberately: a Kubernetes LoadBalancer
  // answers `status.loadBalancer.ingress[0].ip` and nothing else, and that
  // address is the only way to prove the workload is serving.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
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

/**
 * A step exactly as Aime runs it, for the confirm page and the log.
 *
 * The program comes first because it is not always the cloud's own CLI, and
 * the scope flags are how that CLI is told where to work - `--project` and
 * `--account` for `gcloud`, `--subscription` for `az`. A step that names its
 * own program is scoped by neither: `kubectl` is told by the kubeconfig the
 * cluster step wrote, and would refuse the flags outright.
 */
export function commandLine(cloudId: string, step: DeployStep, account: CloudAccount): string {
  const dialect = dialectOf(cloudId);
  const named = step.program !== undefined && step.program !== "" ? step.program : dialect.program;
  if (named !== dialect.program) return [named, ...step.args].map(quoted).join(" ");
  const scoped = [...step.args, dialect.scopeUnit, account.id];
  if (dialect.scopeOwner !== undefined && account.owner !== "") {
    scoped.push(dialect.scopeOwner, account.owner);
  }
  return [named, ...scoped].map(quoted).join(" ");
}

/** A read as Aime runs it. */
export function readLine(cloudId: string, read: PlannedRead, account: CloudAccount): string {
  const dialect = dialectOf(cloudId);
  const line = commandLine(cloudId, { label: read.label, args: read.args, changes: "" }, account);
  return `${line} ${dialect.jsonFlags.join(" ")}`;
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
