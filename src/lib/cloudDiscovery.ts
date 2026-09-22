/**
 * What Aime asks the AI about a cloud it is signed into, and how the answer is
 * read back.
 *
 * Same shape as `aiRun.ts`, for the same reason: the prompt, the result type and
 * the parser live in one file so a change to what is asked cannot drift from
 * what is expected.
 *
 * Who runs what, and why it changed (2026-09-17). This used to ask the AI to
 * run the listing commands itself. Measured against the CLI Aime actually
 * spawns for a one-shot - `claude -p --tools ""` - that turn has NO tools, so
 * the model cannot run anything: it answered with an invented transcript,
 * complete with files the repository does not contain, and the parser threw the
 * whole thing away. Every discovery, on every cloud, ended as *the discovery
 * did not come back with anything readable*.
 *
 * It is also the wrong division of labour for this panel. Aime has already
 * asked the cloud - the inventory behind the Resources tab is the answer of the
 * cloud's own CLI - so the AI is handed that inventory and reads the repository
 * (files only: no shell, no cloud CLI) to say how the two are connected. Aime
 * runs the commands, the AI does the reading: the same shape as a read plan and
 * as a deploy.
 */

/** One thing that exists in the cloud, in that cloud's own vocabulary. */
export interface CloudService {
  name: string;
  /** What kind of thing it is: a web app, a bucket, a database, a queue. */
  kind: string;
  /** Region, project, resource group - wherever the cloud says it lives. */
  where: string;
  /** What a person would need to know before touching it. */
  notes: string;
}

/** The architecture one cloud account holds, as the discovery found it. */
export interface CloudArchitecture {
  /** How this project is deployed today, or an empty list when nothing says. */
  deploys: string[];
  services: CloudService[];
  /**
   * What the discovery could not see, and why.
   *
   * The field that keeps this honest. An account with permission to list two
   * of nine services must say so, or the note in the project's memory reads as
   * a complete map and the next question answered from it is answered wrongly.
   */
  gaps: string[];
  /** The reply as it arrived, kept for when the parse disappoints. */
  raw: string;
}

/** How many inventory rows the prompt carries; an account with more is summarised by kind. */
const ROWS_SHOWN = 200;

/** One row of the inventory, as the prompt lists it. */
export interface DiscoveredResource {
  name: string;
  kind: string;
  location: string;
  group: string;
}

/**
 * What the AI is asked, with the inventory Aime already read from the cloud.
 *
 * The turn is files-only, so every service in the answer has to come from the
 * rows below - which is also what makes the answer checkable.
 */
export function discoverPrompt(input: {
  cloud: string;
  cli: string;
  account: string;
  resources: DiscoveredResource[];
  /**
   * Whether this turn can read the repository at all.
   *
   * False for a CLI Aime cannot hold to a files-only turn: rather than run it
   * with every tool it has - a shell included, on somebody's cloud account -
   * the discovery asks only about the inventory, and says so in the brief so
   * the answer does not claim to know how the project deploys.
   */
  canReadRepo: boolean;
}): string {
  const rows = input.resources
    .slice(0, ROWS_SHOWN)
    .map((one) => `- ${one.kind}  ${one.name}  ${one.location}  ${one.group}`.trimEnd());
  const more =
    input.resources.length > ROWS_SHOWN
      ? [`(+${String(input.resources.length - ROWS_SHOWN)} more rows not shown)`]
      : [];
  return [
    input.canReadRepo ? DISCOVER_BRIEF : DISCOVER_BRIEF_NO_REPO,
    "",
    `The cloud: ${input.cloud}, read through its own CLI (\`${input.cli}\`) on this machine.`,
    `Signed in as: ${input.account}`,
    "",
    "What Aime found there (kind, name, region, resource group) - this IS the inventory, asked of the",
    "cloud itself just now:",
    rows.length === 0 ? "(nothing - the account holds no resources)" : rows.join("\n"),
    ...more,
  ].join("\n");
}

const SHARED_SCHEMA = `
{"deploys": ["how this project reaches this cloud today"],
 "services": [{"name": "...", "kind": "web app | database | bucket | queue | function | cluster - or the
               cloud's own word for it when none of those is the truth",
               "where": "region, project or resource group", "notes": "what to know before touching it"}],
 "gaps": ["what you could not see, and why"]}

Rules:
- Every service must be one of the inventory rows above. An account with two rows gets two services.
  Do not list what a project of this kind usually has, and do not invent a row.
- "gaps" is not optional politeness. A resource whose purpose the inventory cannot show, a connection
  the repository does not declare, a region or subscription outside this account - each one goes here.
  A map that does not say where it ends will be read as complete.
- "deploys" describes what is wired up now, read from the repository, not what would be a good idea.
  An empty list when the repository says nothing about deploying here.
- Names and identifiers exactly as the inventory spells them, so a later command can use them.
- Say nothing about credentials, keys or tokens, and never print one.`;

/** The same brief for a turn with no tools at all: the inventory, and nothing claimed beyond it. */
const DISCOVER_BRIEF_NO_REPO =
  `Write down what already exists in this cloud account, so that later work -
deploying, standing up infrastructure, chasing a bug into a running service - starts from what is really
there rather than from guesses.

You have NO shell and NO cloud CLI, and no way to read this repository either. Aime has already asked
the cloud, and its answer is the inventory below - that inventory is ALL you know. Leave "deploys"
empty unless the inventory itself shows how this project reaches the account, and say in "gaps" that
the repository could not be read here.

Answer ONLY with JSON, no prose and no code fence:` + SHARED_SCHEMA;

const DISCOVER_BRIEF =
  `Write down what already exists in this cloud account and how this project
reaches it, so that later work - deploying, standing up infrastructure, chasing a bug into a running
service - starts from what is really there rather than from guesses.

You have NO shell and NO cloud CLI: Aime has already asked the cloud, and its answer is the inventory
below. Read the repository (its CI configuration, Dockerfile, compose file, deploy script,
infrastructure-as-code) to work out how this project is wired to those resources. Do not write a file,
and do not commit anything.

Answer ONLY with JSON, no prose and no code fence:` + SHARED_SCHEMA;

/**
 * The architecture, or null when the reply was not one.
 *
 * Null on an empty answer as well as an unparseable one: a discovery that found
 * nothing at all and one that failed to answer look the same from here, and
 * writing "this account is empty" into a project's memory on the strength of a
 * shrug would be worse than writing nothing.
 */
export function parseArchitecture(reply: string): CloudArchitecture | null {
  const object = asRecord(extractObject(reply));
  const services = asArray(object.services)
    .map((entry) => {
      const row = asRecord(entry);
      return {
        name: asString(row.name),
        kind: asString(row.kind),
        where: asString(row.where),
        notes: asString(row.notes),
      };
    })
    // A row with no name is not a service: nothing could be looked up from it.
    .filter((service) => service.name !== "");
  const deploys = asArray(object.deploys).map(asString).filter(Boolean);
  const gaps = asArray(object.gaps).map(asString).filter(Boolean);
  if (services.length === 0 && deploys.length === 0 && gaps.length === 0) return null;
  return { deploys, services, gaps, raw: reply };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Pulls the first JSON object out of a reply.
 *
 * Models fence their JSON, apologise before it and explain after it. Taking the
 * outermost braces survives all three.
 */
function extractObject(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}
