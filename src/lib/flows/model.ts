/**
 * What a flow is: steps on a canvas joined by wires,
 * run on demand, fed whatever the person hands it.
 *
 * The file is the model: `.aime/flows/<slug>.json` holds exactly a `Flow`,
 * and so does a run's journal in its first line. Everything here is plain
 * data, so a flow can be drawn by hand, by the AI, or shared through git
 * without any of them knowing about the others.
 */

export const FLOW_VERSION = 1;

/** What a step can do. The palette is a shortcut to these, not a fence. */
export type Ability =
  | "input"
  | "ai"
  | "command"
  | "transform"
  | "gate"
  | "wait"
  | "human"
  | "http"
  | "service"
  | "git"
  | "mail"
  | "files"
  | "subflow"
  | "free";

/** The abilities this build can run; the rest validate as "not yet". */
export const RUNNABLE_ABILITIES: readonly Ability[] = [
  "input",
  "ai",
  "command",
  "transform",
  "gate",
  "wait",
  "human",
  "http",
  "service",
  "git",
  "mail",
  "files",
  "subflow",
];

export type ItemKind = "file" | "folder" | "image" | "ticket" | "pr" | "link" | "run";

/** A guide for the run dialog, never a gate: a run may bring anything else. */
export interface InputHint {
  name: string;
  kind?: ItemKind;
  note?: string;
  /** With a default the hint becomes a filled-in field - a run parameter. */
  default?: string;
  choices?: string[];
}

export interface InputSpec {
  hints: InputHint[];
}

/** One thing handed to a run beside the text. */
export interface InputItem {
  kind: ItemKind;
  /** A path, a ticket key, a PR number, a URL, a run id. */
  ref: string;
  /** What it held when the run started, where that is small enough to carry. */
  content?: string;
}

/** Everything a run was given. */
export interface InputBundle {
  text: string;
  items: InputItem[];
  /** The hints with a default, as filled in for this run. */
  params: Record<string, string>;
}

export type Permission = "readOnly" | "edits" | "full";

/** A program with its arguments: run with no shell, so it means the same thing everywhere. */
export interface Invocation {
  program: string;
  args: string[];
}

/**
 * A command step's command. `all` is the shared form; a shell line per
 * platform is for what needs a shell, and is run by that platform's shell
 * only (PowerShell 5.1 on Windows, /bin/sh elsewhere).
 */
export interface PlatformCommand {
  all?: Invocation[];
  windows?: string;
  macos?: string;
  linux?: string;
}

export interface AiConfig {
  model?: string;
  permission: Permission;
  tools?: "everything" | "filesOnly";
  /** Ask for a JSON answer, which becomes the step's value. */
  json?: boolean;
}

export interface CommandConfig {
  command: PlatformCommand;
  /** Relative to the workspace; a monorepo's package. */
  cwd?: string;
  env?: Record<string, string>;
}

/** A jq program over the step's input; its outputs are the value (one, or a list). */
export interface TransformConfig {
  program: string;
}

/** The first branch whose jq program answers `true` is taken. */
export interface GateBranch {
  label: string;
  program: string;
}

export interface GateConfig {
  branches: GateBranch[];
}

export interface WaitConfig {
  seconds: number;
}

export type HumanMode = "approve" | "choose" | "edit" | "form";

export interface HumanConfig {
  mode: HumanMode;
  /** For `choose`: what can be picked. */
  options?: string[];
  /** For `form`: the fields to fill. */
  fields?: { name: string; note?: string }[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** An HTTP call; secrets as `{{secret.NAME}}` are filled in by the backend only. */
export interface HttpConfig {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** How the answer is read into the step's value. */
  parse?: "json" | "text";
}

/**
 * One of the doors to a service: a work tracker Aime is connected to, an
 * MCP server the AI CLI has (an AI turn told to use it), or a CLI on the
 * machine (a command).
 */
export type ServiceConfig =
  | {
      door: "tracker";
      action: "list" | "detail" | "comment" | "setState";
      connectionId?: string;
      itemId?: string;
      text?: string;
      state?: string;
    }
  | { door: "mcp"; server: string; permission?: Permission }
  | { door: "cli"; command: PlatformCommand; cwd?: string };

export interface GitConfig {
  action: "branch" | "commit" | "push" | "pr" | "diff" | "log";
  branch?: string;
  message?: string;
  title?: string;
  body?: string;
  base?: string;
  /** For `log`: how many commits; for `diff`: against what (default: the pending change). */
  count?: number;
  against?: string;
}

export interface MailConfig {
  connection: string;
  to: string[];
  subject: string;
  body: string;
}

/** Files of the repository, read as the step's value: `{ path: content }`. */
export interface FilesConfig {
  globs: string[];
  /** Characters kept per file. */
  limit?: number;
}

export interface SubflowConfig {
  slug: string;
  /** What the sub-flow is handed as text; its own hints' defaults otherwise. */
  text?: string;
}

export type StepConfig =
  | { ability: "input" }
  | ({ ability: "ai" } & AiConfig)
  | ({ ability: "command" } & CommandConfig)
  | ({ ability: "transform" } & TransformConfig)
  | ({ ability: "gate" } & GateConfig)
  | ({ ability: "wait" } & WaitConfig)
  | ({ ability: "human" } & HumanConfig)
  | ({ ability: "http" } & HttpConfig)
  | ({ ability: "service" } & ServiceConfig)
  | ({ ability: "git" } & GitConfig)
  | ({ ability: "mail" } & MailConfig)
  | ({ ability: "files" } & FilesConfig)
  | ({ ability: "subflow" } & SubflowConfig)
  | { ability: "free" };

export type OnError = "stop" | "errorWire" | "skipItems";

export interface Step {
  id: string;
  name: string;
  /** What the step does, in the person's words; what the compiler reads. */
  does: string;
  config: StepConfig;
  onError: OnError;
  retries: number;
  timeoutMs?: number;
  /** Run once per item of a list input, `settings.parallel` at a time. */
  forEach?: boolean;
  /** A join that runs on the first input to arrive rather than all of them. */
  joinFirst?: boolean;
  /** The text the config was compiled from (`lib/flows/compiler.ts`); stale when `does` changed since. */
  compiled?: { from: string; at: number };
}

/** The port a wire leaves from: the step's output, its error, or a gate's branch. */
export const OUT_PORT = "out";
export const ERROR_PORT = "error";

export interface Wire {
  from: string;
  port: string;
  to: string;
  /** A wire back to an earlier step is a loop and must say how many rounds at most. */
  maxRounds?: number;
}

/** The round limit a newly closed loop gets until the person sets another: three is the usual ask. */
export const DEFAULT_LOOP_ROUNDS = 3;

export type RunPlacement = "auto" | "worktree" | "inPlace";

export interface FlowSettings {
  /** How many items of a for-each run at once. */
  parallel: number;
  /** How many AI steps run at once across the whole run. */
  aiConcurrency: number;
  costLimitUsd?: number;
  where: RunPlacement;
}

export interface Flow {
  version: typeof FLOW_VERSION;
  name: string;
  description: string;
  input: InputSpec;
  steps: Step[];
  wires: Wire[];
  settings: FlowSettings;
  /** Where each step sits on the canvas; a step without one is laid out by Arrange. */
  layout?: Record<string, { x: number; y: number }>;
}

/** What every step produces. */
export interface StepOutput {
  value: unknown;
  files: string[];
  summary: string;
}

export const DEFAULT_SETTINGS: FlowSettings = {
  parallel: 3,
  aiConcurrency: 2,
  where: "auto",
};

export const DEFAULT_RETRIES: Record<Ability, number> = {
  input: 0,
  ai: 1,
  command: 0,
  transform: 0,
  gate: 0,
  wait: 0,
  human: 0,
  http: 1,
  service: 1,
  git: 0,
  mail: 1,
  files: 0,
  subflow: 0,
  free: 0,
};

/** A flow with nothing but its input step. */
export function emptyFlow(name: string): Flow {
  return {
    version: FLOW_VERSION,
    name,
    description: "",
    input: { hints: [] },
    steps: [
      {
        id: "input",
        name: "Input",
        does: "",
        config: { ability: "input" },
        onError: "stop",
        retries: 0,
      },
    ],
    wires: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** The file name a flow is stored under: lowercase, dashes, nothing else. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug === "" ? "flow" : slug;
}

/** Whether a step may change files, which decides where a run is placed. */
export function stepWrites(step: Step): boolean {
  switch (step.config.ability) {
    case "ai":
      return step.config.permission !== "readOnly";
    case "service":
      return (
        step.config.door === "cli" ||
        (step.config.door === "mcp" &&
          step.config.permission !== undefined &&
          step.config.permission !== "readOnly")
      );
    case "command":
    case "git":
    case "subflow":
    case "free":
      return true;
    default:
      return false;
  }
}

/**
 * Whether a step acts on the outside world - something a try or a preview
 * must show rather than do: a mail, a call that is not a read, a push, a
 * comment on a ticket.
 */
export function stepReachesOut(step: Step): boolean {
  switch (step.config.ability) {
    case "http":
      return step.config.method !== "GET";
    case "mail":
      return true;
    case "git":
      return step.config.action === "push" || step.config.action === "pr";
    case "service":
      return (
        step.config.door === "tracker" &&
        (step.config.action === "comment" || step.config.action === "setState")
      );
    default:
      return false;
  }
}

/** The hosts a flow calls and the connections it needs, for the trust gate. */
export function reachesOf(flow: Flow): { hosts: string[]; secrets: string[]; commands: string[] } {
  const hosts = new Set<string>();
  const secrets = new Set<string>();
  const commands = new Set<string>();
  const text = JSON.stringify(flow);
  for (const match of text.matchAll(/\{\{\s*secret\.([\w.-]+)\s*\}\}/g)) secrets.add(match[1]);
  for (const step of flow.steps) {
    const { config } = step;
    if (config.ability === "http") {
      try {
        hosts.add(new URL(config.url.replace(/\{\{[^}]*\}\}/g, "x")).host);
      } catch {
        hosts.add(config.url);
      }
    }
    if (config.ability === "mail") secrets.add(`mail.${config.connection}`);
    const command =
      config.ability === "command"
        ? config.command
        : config.ability === "service" && config.door === "cli"
          ? config.command
          : null;
    if (command !== null) {
      for (const invocation of command.all ?? [])
        commands.add([invocation.program, ...invocation.args].join(" "));
      for (const platform of ["windows", "macos", "linux"] as const) {
        const arm = command[platform];
        if (arm !== undefined && arm.trim() !== "") commands.add(`${platform}: ${arm}`);
      }
    }
    if (config.ability === "git" && (config.action === "push" || config.action === "pr"))
      commands.add(`git ${config.action}`);
  }
  return { hosts: [...hosts], secrets: [...secrets], commands: [...commands] };
}

export function flowWrites(flow: Flow): boolean {
  return flow.steps.some(stepWrites);
}
