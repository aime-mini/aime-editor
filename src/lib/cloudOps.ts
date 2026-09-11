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
export interface ProposedOp {
  /** What it does, in a developer's words - the button's label. */
  label: string;
  /** What it changes on the cloud, or that it changes nothing. */
  changes: string;
  /** Whether it writes: a read is run on click, a write waits for a confirm. */
  writes: boolean;
  /** The `gcloud` tokens after the program name, placeholders included. */
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
 * What the AI is asked for one kind of resource.
 *
 * Deliberately not a list of operations Aime knows about: the CLI's own
 * vocabulary is the AI's to bring, and hard-coding "restart is `sql instances
 * restart`" per service is exactly the table this project refuses to keep
 * (`aime-orchestrates-ai-decides`). What Aime states are the RULES, because
 * those are Aime's own: what it will refuse, what it adds itself, and the
 * placeholders it fills.
 */
export function opsPrompt(kind: string): string {
  return [
    `A developer is looking at one Google Cloud resource of type \`${kind}\` in an editor,`,
    "and wants to do the day-to-day work on it without opening the cloud console.",
    "",
    "Answer with the operations that are actually useful for THIS type - the ones a developer",
    "runs while building and running a service: read its recent logs, restart or redeploy it,",
    "change an environment variable, move traffic between revisions, scale it, and so on.",
    "Skip anything that is not offered by `gcloud` for this type. Never invent a command.",
    "",
    "Rules Aime enforces, so a command that breaks one is thrown away:",
    `- Write the arguments after \`gcloud\`, one token per array entry ("--flag" and its value are`,
    "  two entries). Use the placeholders " +
      `\`${NAME}\` (this resource's name) and \`${REGION}\` (its region) - never a real name.`,
    "- Aime adds `--project` and `--account` itself; do not include them, or `--format`.",
    "- Deleting IS allowed here and belongs in the list when the kind has it - it is day-to-day work,",
    "  and Aime makes the person type the resource's own name before it runs. Mark it `writes: true`.",
    "- Nothing under `projects`, `billing`, `organizations`, `auth`, `config` or `components`.",
    "- To change a setting of something already running, use an `--update-*` flag; a `--set-*`,",
    "  `--clear-*` or `--remove-*` flag replaces or wipes what is there and will be refused.",
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

/** The operation as it will run on THIS resource, placeholders filled in. */
export function fillOp(op: ProposedOp, resource: { name: string; location: string }): string[] {
  return op.args.map((token) => token.replaceAll(NAME, resource.name).replaceAll(REGION, resource.location));
}

/** The command line Aime will run, exactly as the confirm has to show it. */
export function opCommand(args: string[], project: string, account: string): string {
  return ["gcloud", ...args, "--project", project, "--account", account].join(" ");
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
export function fillable(op: ProposedOp, resource: { name: string; location: string }): boolean {
  const needsRegion = op.args.some((token) => token.includes(REGION));
  return !needsRegion || resource.location !== "";
}
