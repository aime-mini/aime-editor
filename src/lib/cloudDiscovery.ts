/**
 * What Aime asks the AI about a cloud it is signed into, and how the answer is
 * read back.
 *
 * Same shape as `aiRun.ts`, for the same reason: the prompt, the result type and
 * the parser live in one file so a change to what is asked cannot drift from
 * what is expected.
 *
 * Why the AI runs the discovery rather than Aime: four clouds have four CLIs
 * with four inventory surfaces, and only two of them are on this machine to be
 * measured. Hard-coding `az resource list` and then guessing the other three
 * would be the exact mistake the project's rule against inventing CLI schemas
 * exists to stop. So Aime measures what it can measure - which CLI is here and
 * who it is signed in as - states the requirement, and the AI, which can read
 * that CLI's own help on this machine, chooses the commands.
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

export const DISCOVER_PROMPT = `Find out what already exists in this cloud account, so that later work -
deploying this project, standing up infrastructure, chasing a bug into a running service - starts from
what is really there rather than from guesses.

Read only. Run listing and describe commands and nothing else: no create, no delete, no update, no
scale, no restart, no permission change. Do not write a file, and do not commit anything.

How to look is your call, because you can read this CLI's own help on this machine and Aime cannot.
Start from what the project itself says (its CI configuration, Dockerfile, compose file, deploy script,
infrastructure-as-code) and then ask the cloud what is actually running.

Answer ONLY with JSON, no prose and no code fence:
{"deploys": ["how this project reaches this cloud today"],
 "services": [{"name": "...", "kind": "web app | database | bucket | queue | function | cluster",
               "where": "region, project or resource group", "notes": "what to know before touching it"}],
 "gaps": ["what you could not see, and why"]}

Rules:
- Every service must be one you SAW in the output of a command you ran. An account with two services
  gets two rows. Do not list what a project of this kind usually has.
- "gaps" is not optional politeness. A command that failed, a permission you do not have, a region you
  did not check, a service you can see the name of but nothing else - each one goes here. A map that
  does not say where it ends will be read as complete.
- "deploys" describes what is wired up now, not what would be a good idea.
- Names and identifiers exactly as the cloud spells them, so a later command can use them.
- Say nothing about credentials, keys or tokens, and never print one.`;

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
