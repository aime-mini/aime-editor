/**
 * The operations a developer runs on a cloud resource, without leaving Aime.
 *
 * The point of the panel is that most of the work done in a cloud console can
 * be done here (asked for 2026-09-09: *"mục đích là hạn chế user truy cập
 * cloud? ngay trên aime có thể làm dc đa số công việc"*). Reading a
 * resource's configuration was already possible; this is the other half - tail
 * its logs, restart it, change an environment variable, move traffic.
 *
 * It is built the way Deploy is built, because that is the shape that has been
 * measured to hold (`ARCHITECTURE.md`, session 31): **the AI never holds the
 * cloud CLI**. It answers a LIST of operations for one KIND of resource,
 * written against placeholders rather than a real resource; Aime checks every
 * one against the CLI on this machine (`cloud_check_deploy`: the words must
 * exist per `--help`, nothing may delete or touch the account, no flag may
 * replace a running service's settings); the person sees the exact command and
 * confirms it; Aime runs it with the project and the account pinned.
 *
 * One AI call per kind, then never again - the same economy as the read plans.
 */

/** One operation the AI proposes for a kind of resource. */
import { dialectOf } from "./deployDialect";

export interface ProposedOp {
  /** What it does, in a developer's words - the button's label. */
  label: string;
  /** What it changes on the cloud, or that it changes nothing. */
  changes: string;
  /** Whether it writes: a read is run on click, a write waits for a confirm. */
  writes: boolean;
  /** The tokens after the program name, placeholders included. */
  args: string[];
}

/** What the checker kept and what it refused, per kind. */
export interface CheckedOps {
  ops: ProposedOp[];
  rejected: { label: string; reason: string }[];
}

/** The placeholders Aime fills in, the same set the read plans use. */
const NAME = "<name>";
const REGION = "<region>";
/**
 * The group a resource lives in - a resource group on Azure, the project on
 * Google Cloud.
 *
 * Measured in the app 2026-09-17, and it cost every operation on Azure: asked
 * for operations on a `Microsoft.Web/sites` with only `<name>` and `<region>`
 * to write against, the AI invented `<resource-group>` - because on Azure
 * almost nothing can be addressed without one - and Aime refused all six with
 * *holds something a shell could misread*. The read plans have had `<group>`
 * since session 28; the operations were simply missing it.
 */
const GROUP = "<group>";

/**
 * What the AI is asked for one kind of resource.
 *
 * Deliberately not a list of operations Aime knows about: the CLI's own
 * vocabulary is the AI's to bring, and hard-coding "restart is `sql instances
 * restart`" per service is exactly the table this project refuses to keep
 * (`aime-orchestrates-ai-decides`). What Aime states are the RULES, because
 * those are Aime's own: what it will refuse, what it adds itself, and the
 * placeholders it fills.
 */
export function opsPrompt(cloudId: string, kind: string, groups: string[] | null = null): string {
  const dialect = dialectOf(cloudId);
  return [
    `A developer is looking at one ${dialect.cloud} resource of type \`${kind}\` in an editor,`,
    "and wants to do the day-to-day work on it without opening the cloud console.",
    "",
    "Answer with the operations that are actually useful for THIS type - the ones a developer",
    "runs while building and running a service: read its recent logs, restart or redeploy it,",
    "change an environment variable, move traffic between revisions, scale it, and so on.",
    `Skip anything that is not offered by \`${dialect.program}\` for this type. Never invent a command.`,
    // Measured in the app 2026-09-21 on a Supabase database: the AI answered
    // `postgres logs`, `postgres restart` and `postgres connection-string`,
    // all three refused, the pane left empty - and there is no `postgres`
    // group in that CLI at all. Where the CLI publishes its own tree, the
    // question carries it, the same way an AWS read carries the service's
    // catalogue; Aime still says nothing about which command to pick.
    ...(groups === null
      ? []
      : [
          "",
          `Every command of this CLI begins with one of the words it lists about itself: ${groups
            .map((group) => `\`${group}\``)
            .join(", ")}. A first word outside that list does not exist and is thrown away.`,
        ]),
    "",
    "Rules Aime enforces, so a command that breaks one is thrown away:",
    `- Write the arguments after \`${dialect.program}\`, one token per array entry ("--flag" and its`,
    "  value are two entries). Use the placeholders " +
      `\`${NAME}\` (this resource's name), \`${REGION}\` (its region) and \`${GROUP}\` ` +
      `(${dialect.groupWord}) - never a real name, and never a placeholder of your own.`,
    // Measured in the app 2026-09-18 on an AWS log group: four of six
    // operations were lost to `<start>`, `<days>` and `<filter-name>`. The
    // prompt said not to invent a placeholder but never said what to write
    // instead, and those values are exactly the ones the person came to type -
    // so they belong in the editable fields the confirm page already shows.
    "- Those three are the ONLY placeholders there are. A value Aime cannot fill in - a retention in " +
      "days, a filter name, a time range - is written as a REAL, sensible default the person edits in " +
      "place before running it (`--retention-in-days`, `30`). A placeholder of your own is refused and " +
      "the whole operation is thrown away.",
    `- Aime adds ${dialect.ownFlags} itself; do not include any of them.`,
    "- Deleting IS allowed here and belongs in the list when the kind has it - it is day-to-day work,",
    "  and Aime makes the person type the resource's own name before it runs. Mark it `writes: true`.",
    `- Nothing under ${dialect.refusedGroups}.`,
    ...dialect.opsNotes,
    dialect.opsKeepRule,
    "",
    'Answer with JSON only: {"ops":[{"label":"…","changes":"…","writes":true,"args":["…"]}]}',
    "- `label`: what it does, four words at most, in a developer's words.",
    "- `changes`: what it changes on the cloud - or say plainly that it changes nothing.",
    "- `writes`: false only if the command cannot change anything (a read, a log tail).",
    "At most six operations, the most useful first. No prose, no markdown fence.",
  ].join("\n");
}

/** The JSON shape `opsPrompt` asks for. */
interface OpsReply {
  ops?: unknown;
}

/**
 * The operations in an AI answer, or none.
 *
 * Anything that is not the shape asked for is dropped rather than repaired: an
 * operation Aime cannot read is one it would run a guess about.
 */
export function parseOps(reply: string): ProposedOp[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: OpsReply;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1)) as OpsReply;
  } catch (error: unknown) {
    console.warn("the AI's operations did not parse:", error);
    return [];
  }
  if (!Array.isArray(parsed.ops)) return [];
  return parsed.ops.flatMap((entry) => {
    const op = entry as Partial<ProposedOp>;
    if (typeof op.label !== "string" || op.label.trim() === "") return [];
    if (!Array.isArray(op.args) || op.args.length === 0) return [];
    if (!op.args.every((token): token is string => typeof token === "string")) return [];
    return [
      {
        label: op.label.trim(),
        changes: typeof op.changes === "string" ? op.changes.trim() : "",
        // Unstated means it writes: the safer reading of an unclear answer.
        writes: op.writes !== false,
        args: op.args,
      },
    ];
  });
}

/**
 * Whether the AI answered properly and said there is nothing here.
 *
 * `{"ops":[]}` is an answer; prose, an apology or an error from the CLI is
 * not, and the two must not read the same on screen.
 */
export function sawEmptyList(reply: string): boolean {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return false;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as OpsReply;
    return Array.isArray(parsed.ops);
  } catch {
    return false;
  }
}

/**
 * The operation as it will run on THIS resource, placeholders filled in.
 *
 * `cliName` rather than `name`, for the reason the read plans use it: five
 * kinds in twenty answer a display label where the command line wants an
 * identifier. It falls back to the shown name for a resource listed before
 * Aime told the two apart.
 */
export function fillOp(
  op: ProposedOp,
  resource: { name: string; cliName?: string; location: string; group?: string },
): string[] {
  const name = resource.cliName !== undefined && resource.cliName !== "" ? resource.cliName : resource.name;
  return op.args.map((token) =>
    token
      .replaceAll(NAME, name)
      .replaceAll(REGION, resource.location)
      .replaceAll(GROUP, resource.group ?? ""),
  );
}

/** The command line Aime will run, exactly as the confirm has to show it. */
export function opCommand(cloudId: string, args: string[], project: string, account: string): string {
  const dialect = dialectOf(cloudId);
  const scoped = [dialect.program, ...args, dialect.scopeUnit, project];
  if (dialect.scopeOwner !== undefined && account !== "") scoped.push(dialect.scopeOwner, account);
  return scoped.join(" ");
}

/**
 * The words that mean an operation takes something away for good.
 *
 * Aime's own reading of the command, never the AI's claim about it: an
 * operation is destructive because of what it says, not because it was
 * labelled so. The list is the one `cloud/deploy.rs` refuses a deployment
 * (`REFUSED_WORDS`), and it is what puts the typed-name confirmation in front
 * of the button.
 */
const REMOVING = ["delete", "destroy", "undelete", "purge", "abandon"];

/** Whether this operation takes the resource, or part of it, away for good. */
export function destroys(args: string[]): boolean {
  return args.some((token) => REMOVING.includes(token) || token.startsWith("remove-"));
}

/** Whether every placeholder in an operation can be filled for this resource. */
export function fillable(
  op: ProposedOp,
  resource: { name: string; location: string; group?: string },
): boolean {
  const needs = (placeholder: string) => op.args.some((token) => token.includes(placeholder));
  if (needs(REGION) && resource.location === "") return false;
  return !needs(GROUP) || (resource.group ?? "") !== "";
}
