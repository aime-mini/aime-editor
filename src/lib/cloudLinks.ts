import type { CloudResource } from "../stores/cloud";

/**
 * Which resources a resource's own configuration names - the dependencies a
 * diagram can draw as facts rather than as tiers.
 *
 * No listing carries them: `resourcegroupstaggingapi`, `az resource list` and
 * Cloud Asset all answer what exists, never what uses what. What does carry
 * them is each resource's configuration, which the panel already reads through
 * the plans the AI made per kind: a Lambda's `get-function` names the queue it
 * writes to in an environment variable, an event source mapping names both its
 * queue and its function, a web app names its App Service plan. So a link here
 * is one resource's configuration holding another resource's identifier - read,
 * never guessed, and every link keeps where in the answer it was found so a
 * reader can check it.
 */

/** One resource whose configuration names another. */
export interface CloudLink {
  /** The resource whose configuration holds the reference. */
  from: string;
  /** The resource it names. */
  to: string;
  /** Where in that configuration: `Configuration.Environment.Variables.QUEUE_URL`. */
  where: string;
}

/** A resource's configuration as the CLI answered it, one read at a time. */
export interface ReadAnswer {
  resource: CloudResource;
  json: string;
}

/**
 * The shortest unpunctuated name worth matching as a whole value. A table
 * called `CustomerInvoices` named in an environment variable is a link; a
 * function called `test` and a stage called `test` are a coincidence.
 */
const DISTINCT_NAME_LENGTH = 8;

/**
 * The shapes an identifier takes inside a configuration value, one per cloud.
 * Each match is then looked up exactly, trimmed back one segment at a time:
 * `...:function:Foo:$LATEST` is the function `...:function:Foo`, and an ARM id
 * `.../sites/app/config/web` lives under the site `.../sites/app`.
 */
const IDENTIFIER_SHAPES = [
  /arn:aws[\w-]*:[^\s"',;]+/g,
  /\/subscriptions\/[^\s"',;?]+/gi,
  /https:\/\/sqs\.[^\s"',;]+/g,
  /(?:\/\/[a-z0-9.-]+\/)?projects\/[^\s"',;?]+/g,
];

/**
 * Every link the answers show between resources of this account.
 *
 * Two ways a value names a resource, both exact:
 * - **its identifier inside the value** - an ARN, an ARM id, a Google full name
 *   or the relative name it ends in, an SQS queue URL - trimmed back to a
 *   segment boundary, so `function:Foo` never matches inside `function:FooBar`.
 *   Azure ids are compared without case, because ARM treats them that way and
 *   its CLI prints them both ways.
 * - **its name as the whole value**, when that name is distinctive: unique in
 *   the account and long or punctuated enough not to be a common word.
 */
export function linksOf(answers: ReadAnswer[], resources: CloudResource[]): CloudLink[] {
  const byIdentifier = new Map<string, CloudResource>();
  for (const resource of resources) {
    for (const alias of aliasesOf(resource)) byIdentifier.set(keyOf(alias), resource);
  }
  const byName = distinctNames(resources);
  const found = new Map<string, CloudLink>();
  for (const answer of answers) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.json);
    } catch {
      continue;
    }
    for (const { path, value } of stringsIn(parsed, "")) {
      const named = [...identifiersIn(value, byIdentifier)];
      const byItsName = byName.get(value);
      if (byItsName !== undefined) named.push(byItsName);
      for (const target of named) {
        if (target.id === answer.resource.id) continue;
        const key = `${answer.resource.id} -> ${target.id}`;
        if (!found.has(key)) found.set(key, { from: answer.resource.id, to: target.id, where: path });
      }
    }
  }
  return [...found.values()];
}

/** The spellings a resource's identifier appears in inside another resource's configuration. */
function aliasesOf(resource: CloudResource): string[] {
  const { id } = resource;
  const spellings = [id];
  // A Google full resource name `//service/projects/...` is written without its
  // service head almost everywhere a configuration refers to it.
  if (id.startsWith("//")) {
    const slash = id.indexOf("/", 2);
    if (slash !== -1) spellings.push(id.slice(slash + 1));
  }
  // An SQS queue is listed by its ARN and configured by its URL.
  const queue = /^arn:aws[\w-]*:sqs:([^:]+):(\d+):(.+)$/.exec(id);
  if (queue !== null) spellings.push(`https://sqs.${queue[1]}.amazonaws.com/${queue[2]}/${queue[3]}`);
  return spellings;
}

/** How an identifier is looked up: ARM ids without case, everything else exactly. */
function keyOf(identifier: string): string {
  return identifier.toLowerCase().startsWith("/subscriptions/") ? identifier.toLowerCase() : identifier;
}

/** The resources a value names by identifier. */
function* identifiersIn(value: string, byIdentifier: Map<string, CloudResource>): Generator<CloudResource> {
  for (const shape of IDENTIFIER_SHAPES) {
    for (const match of value.matchAll(shape)) {
      const found = longestKnownPrefix(match[0], byIdentifier);
      if (found !== null) yield found;
    }
  }
}

function longestKnownPrefix(
  candidate: string,
  byIdentifier: Map<string, CloudResource>,
): CloudResource | null {
  for (let rest = candidate.replace(/[/.]+$/, ""); rest !== "";) {
    const found = byIdentifier.get(keyOf(rest));
    if (found !== undefined) return found;
    const cut = Math.max(rest.lastIndexOf(":"), rest.lastIndexOf("/"));
    if (cut <= 0) return null;
    rest = rest.slice(0, cut);
  }
  return null;
}

/** Names that can stand for one resource on their own: unique in the account, and distinctive. */
function distinctNames(resources: CloudResource[]): Map<string, CloudResource> {
  const byName = new Map<string, CloudResource[]>();
  for (const resource of resources) {
    const name = resource.cliName === "" ? resource.name : resource.cliName;
    if (name.length < DISTINCT_NAME_LENGTH && !/[-_.]/.test(name)) continue;
    byName.set(name, [...(byName.get(name) ?? []), resource]);
  }
  return new Map(
    [...byName].flatMap(([name, holders]) => (holders.length === 1 ? [[name, holders[0]] as const] : [])),
  );
}

/**
 * Keys whose values describe a resource rather than configure it. Measured on a
 * real account (2026-09-25): tracing an application of 57 resources found 73
 * links, and 60 of them were `Tags.aws:cloudformation:stack-id` - every
 * function pointing at the stack that created it. That is who made it, not
 * what it uses.
 */
const METADATA_KEYS = /^(tags|labels)$/i;

/** Every configuration string in a JSON value, with the path of keys that leads to it. */
function* stringsIn(value: unknown, path: string): Generator<{ path: string; value: string }> {
  if (typeof value === "string") {
    yield { path, value };
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringsIn(item, `${path}[${String(index)}]`);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (METADATA_KEYS.test(key)) continue;
      yield* stringsIn(item, path === "" ? key : `${path}.${key}`);
    }
  }
}
