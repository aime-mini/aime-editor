import { invoke } from "@tauri-apps/api/core";
import { agentTurn, cancelAgentTurn, failureOf } from "../agentTurn";
import { execCancel, type CommandOutcome } from "../exec";
import type { WorkItem, WorkItemDetail } from "../../stores/trackers";
import {
  describe,
  runFlow,
  summarize,
  type Ask,
  type Executors,
  type RunEvent,
  type StepContext,
  type StepResult,
} from "./engine";
import {
  stepReachesOut,
  type AiConfig,
  type CommandConfig,
  type FilesConfig,
  type Flow,
  type GateConfig,
  type GitConfig,
  type HttpConfig,
  type InputBundle,
  type Invocation,
  type MailConfig,
  type ServiceConfig,
  type Step,
  type StepOutput,
  type SubflowConfig,
  type TransformConfig,
  type WaitConfig,
} from "./model";
import { globToRegExp } from "./glob";
import { fill, type TemplateScope } from "./template";

/**
 * What a step of each ability does when it runs for real: the AI CLI through
 * an agent turn, a command through the backend with no shell (or a
 * platform's shell for a platform arm), jq in-process, HTTP and mail with
 * the secrets filled in by the backend, the work tracker Aime is connected
 * to, git, files of the repository, another flow. The engine never knows
 * which; it sees a result or an error.
 *
 * In a preview (`context.preview`) a step that reaches outside - a mail, a
 * call that is not a read, a push, a comment - shows what it would send and
 * sends nothing; everything else runs as usual.
 */

/** What the executors need from the app beyond the step itself. */
export interface Services {
  /** A sub-flow's own human steps are asked through the same screen. */
  ask: (step: Step, ask: Ask) => Promise<unknown>;
  /** The flow a sub-flow step names, from the project. */
  flow: (slug: string) => Flow | undefined;
  /** Where a sub-flow's journal goes. */
  journal: (runId: string, event: RunEvent) => Promise<void>;
  /** The tracker connection bound to the project, when there is one. */
  trackerConnection: () => Promise<string | null>;
}

export function realExecutors(services: Services): Executors {
  return {
    run: (context) => {
      const { config } = context.step;
      switch (config.ability) {
        case "input":
          return Promise.resolve(inputStep(context.bundle));
        case "ai":
          return aiStep(context, config);
        case "command":
          return commandStep(context, config);
        case "transform":
          return transformStep(context, config);
        case "gate":
          return gateStep(context, config);
        case "wait":
          return waitStep(context, config);
        case "http":
          return httpStep(context, config);
        case "service":
          return serviceStep(context, config, services);
        case "git":
          return gitStep(context, config);
        case "mail":
          return mailStep(context, config);
        case "files":
          return filesStep(context, config);
        case "subflow":
          return subflowStep(context, config, services);
        case "human":
          return Promise.reject(new Error("a human step is answered by the run, not an executor"));
        default:
          return Promise.reject(new Error(`"${config.ability}" cannot run in this version of Aime`));
      }
    },
  };
}

function scopeOf(context: StepContext): TemplateScope {
  return { outputs: context.settled, bundle: context.bundle };
}

/** `{{…}}` in a step's text, with what could not be found said in the log. */
function filled(text: string, context: StepContext): string {
  return fill(text, scopeOf(context), (path) => {
    context.log(`{{${path}}} names nothing this step was given; left empty`);
  });
}

/** The output of a step that only shows what it would do. */
function previewed(what: string, value: Record<string, unknown>): StepResult {
  return { output: { value: { preview: true, ...value }, files: [], summary: `preview: ${what}` } };
}

// ---- input --------------------------------------------------------------------------

function inputStep(bundle: InputBundle): StepResult {
  return {
    output: {
      value: bundle,
      files: bundle.items
        .filter((item) => item.kind === "file" || item.kind === "folder")
        .map((item) => item.ref),
      summary: summarize(bundle.text || `${String(bundle.items.length)} items`),
    },
  };
}

// ---- ai ----------------------------------------------------------------------------

/** How much of an item's content or a step's value goes into a prompt. */
const PROMPT_VALUE_CHARS = 6_000;
const SUMMARY_LINE = /^SUMMARY:\s*(.+)$/m;
const FILE_LINE = /^FILE:\s*(.+)$/gm;

async function aiStep(context: StepContext, config: AiConfig, extra: string[] = []): Promise<StepResult> {
  const prompt = aiPrompt(context, config, extra);
  let runId: string | null = null;
  const onAbort = () => {
    if (runId !== null) void cancelAgentTurn(runId);
  };
  context.signal.addEventListener("abort", onAbort);
  try {
    const outcome = await agentTurn({
      prompt,
      cwd: context.workRoot,
      permission: context.preview ? "readOnly" : config.permission,
      tools: config.tools,
      model: config.model,
      onToolCall: (line) => {
        context.log(line);
      },
      onStarted: (id) => {
        runId = id;
      },
    });
    if (context.signal.aborted) throw abortReason(context);
    if (outcome.code !== 0) throw new Error(failureOf(outcome));
    return { output: readAnswer(outcome.text, config), costUsd: outcome.costUsd ?? undefined };
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}

export function aiPrompt(context: StepContext, config: AiConfig, extra: string[] = []): string {
  const { bundle } = context;
  const parts = [filled(context.step.does, context), ...extra];
  const items = bundle.items.map((item) => {
    const content = item.content === undefined ? "" : `\n${clip(item.content, PROMPT_VALUE_CHARS)}`;
    return `- ${item.kind}: ${item.ref}${content}`;
  });
  const params = Object.entries(bundle.params).map(([name, value]) => `- ${name}: ${value}`);
  parts.push(
    "## What this run was given",
    bundle.text.trim() === "" ? "(no text)" : bundle.text,
    ...(items.length > 0 ? ["Items:", ...items] : []),
    ...(params.length > 0 ? ["Parameters:", ...params] : []),
  );
  const earlier = Object.entries(context.input).filter(([id]) => id !== "input");
  if (earlier.length > 0) {
    parts.push("## What earlier steps produced");
    for (const [id, output] of earlier) {
      const name = context.flow.steps.find((step) => step.id === id)?.name ?? id;
      parts.push(
        `### ${name} (${id})`,
        output.summary,
        `value: ${clip(output.value === undefined ? "null" : JSON.stringify(output.value, null, 2), PROMPT_VALUE_CHARS)}`,
      );
      if (output.files.length > 0) parts.push(`files: ${output.files.join(", ")}`);
    }
  }
  parts.push(
    "## How to answer",
    "Work in the folder you are in; paths are relative to it.",
    config.json === true
      ? "Reply with one JSON value and nothing else: no prose, no code fence."
      : "End with one line `SUMMARY: <one sentence on what you did or found>`.",
    "For every file you created or changed, add a line `FILE: <relative path>` at the very end.",
  );
  if (context.preview) parts.push("This is a preview: read and plan, change nothing, send nothing.");
  return parts.join("\n\n");
}

function readAnswer(text: string, config: AiConfig): StepOutput {
  const files = [...text.matchAll(FILE_LINE)].map((match) => match[1].trim());
  const body = text.replace(FILE_LINE, "").trim();
  if (config.json === true) {
    const value = parseJson(body);
    return { value, files, summary: summarize(value) };
  }
  const summary = SUMMARY_LINE.exec(body)?.[1].trim() ?? firstLine(body);
  return { value: body.replace(SUMMARY_LINE, "").trim(), files, summary };
}

/** The JSON in an answer, with or without a code fence around it. */
export function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.search(/[[{]/);
    if (start === -1) throw new Error("the answer holds no JSON");
    return JSON.parse(candidate.slice(start)) as unknown;
  }
}

// ---- command -------------------------------------------------------------------------

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;

interface ProgramRequest {
  cwd: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number | null;
}

function commandStep(context: StepContext, config: CommandConfig): Promise<StepResult> {
  const invocations = invocationsFor(context, config);
  const cwd = config.cwd === undefined ? context.workRoot : `${context.workRoot}/${config.cwd}`;
  const env = Object.fromEntries(
    Object.entries(config.env ?? {}).map(([name, value]) => [name, filled(value, context)]),
  );
  return runPrograms(context, invocations, cwd, env);
}

async function runPrograms(
  context: StepContext,
  invocations: Invocation[],
  cwd: string,
  env: Record<string, string>,
): Promise<StepResult> {
  const outcomes: CommandOutcome[] = [];
  for (const [index, invocation] of invocations.entries()) {
    const id = `flow-${context.step.id}-${String(context.round)}-${String(context.attempt)}-${String(index)}`;
    const onAbort = () => {
      void execCancel(id);
    };
    context.signal.addEventListener("abort", onAbort);
    try {
      context.log(`$ ${[invocation.program, ...invocation.args].join(" ")}`);
      const request: ProgramRequest = {
        cwd,
        program: invocation.program,
        args: invocation.args,
        env,
        timeoutMs: context.step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      };
      const outcome = await invoke<CommandOutcome>("flow_run_program", { id, request });
      outcomes.push(outcome);
      if (context.signal.aborted) throw abortReason(context);
      if (outcome.timedOut) throw new Error(`timed out after ${String(outcome.durationMs)} ms`);
      if (outcome.code !== 0) {
        throw new Error(
          `exit ${String(outcome.code)}: ${lastLine(outcome.stderr) || lastLine(outcome.stdout) || "no output"}`,
        );
      }
    } finally {
      context.signal.removeEventListener("abort", onAbort);
    }
  }
  const last = outcomes.at(-1);
  const stdout = outcomes.map((outcome) => outcome.stdout).join("");
  return {
    output: {
      value: { code: last?.code ?? 0, stdout, stderr: outcomes.map((outcome) => outcome.stderr).join("") },
      files: [],
      summary: lastLine(stdout) || lastLine(last?.stderr ?? "") || "done",
    },
  };
}

/** The programs to run here: the shared form, else this platform's arm through its shell. */
export function invocationsFor(context: StepContext, config: CommandConfig): Invocation[] {
  const { command } = config;
  if (command.all !== undefined && command.all.length > 0) {
    return command.all.map((invocation) => ({
      program: filled(invocation.program, context),
      args: invocation.args.map((arg) => filled(arg, context)),
    }));
  }
  const arm = command[context.platform];
  if (arm === undefined || arm.trim() === "") {
    const has = (["windows", "macos", "linux"] as const).filter(
      (platform) => command[platform] !== undefined,
    );
    throw new Error(
      `no command for ${context.platform}; the step has one for ${has.join(", ") || "no platform"}`,
    );
  }
  const line = filled(arm, context);
  return context.platform === "windows"
    ? [{ program: "powershell", args: ["-NoProfile", "-Command", line] }]
    : [{ program: "/bin/sh", args: ["-c", line] }];
}

// ---- transform and gate ---------------------------------------------------------------

async function transformStep(context: StepContext, config: TransformConfig): Promise<StepResult> {
  const outputs = await invoke<unknown[]>("flow_jq", { program: config.program, input: context.settled });
  const value = outputs.length === 1 ? outputs[0] : outputs;
  return { output: { value, files: [], summary: summarize(value) } };
}

async function gateStep(context: StepContext, config: GateConfig): Promise<StepResult> {
  for (const branch of config.branches) {
    const outputs = await invoke<unknown[]>("flow_jq", { program: branch.program, input: context.settled });
    if (outputs[0] === true) {
      return { output: { value: branch.label, files: [], summary: branch.label }, branch: branch.label };
    }
  }
  throw new Error(`no branch held: ${config.branches.map((branch) => branch.label).join(", ")}`);
}

// ---- wait -------------------------------------------------------------------------------

function waitStep(context: StepContext, config: WaitConfig): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        context.signal.removeEventListener("abort", onAbort);
        const value = Object.fromEntries(
          Object.entries(context.input).map(([id, output]) => [id, output.value]),
        );
        resolve({ output: { value, files: [], summary: `waited ${String(config.seconds)} s` } });
      },
      context.preview ? 0 : config.seconds * 1000,
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(context));
    };
    context.signal.addEventListener("abort", onAbort);
  });
}

// ---- http -------------------------------------------------------------------------------

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function httpStep(context: StepContext, config: HttpConfig): Promise<StepResult> {
  const request = {
    method: config.method,
    url: filled(config.url, context),
    headers: Object.fromEntries(
      Object.entries(config.headers ?? {}).map(([name, value]) => [name, filled(value, context)]),
    ),
    body: config.body === undefined ? null : filled(config.body, context),
    parse: config.parse ?? "json",
    timeoutMs: context.step.timeoutMs ?? null,
  };
  if (context.preview && stepReachesOut(context.step)) {
    return previewed(`${config.method} ${request.url}`, {
      request: { ...request, headers: maskSecrets(request.headers) },
    });
  }
  context.log(`${config.method} ${request.url}`);
  const response = await invoke<HttpResponse>("flow_http", { request });
  if (response.status >= 400) {
    throw new Error(
      `${config.method} ${request.url} answered ${String(response.status)}: ${summarize(response.body)}`,
    );
  }
  return {
    output: {
      value: response.body,
      files: [],
      summary: `${String(response.status)} · ${summarize(response.body)}`,
    },
  };
}

/** Header values that name a secret stay named, not shown, in a preview. */
function maskSecrets(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      value.replace(/\{\{\s*secret\.[\w.-]+\s*\}\}/g, "{{secret}}"),
    ]),
  );
}

// ---- service: tracker, mcp, cli -------------------------------------------------------

function serviceStep(context: StepContext, config: ServiceConfig, services: Services): Promise<StepResult> {
  switch (config.door) {
    case "cli":
      return runPrograms(
        context,
        invocationsFor(context, { command: config.command, cwd: config.cwd }),
        config.cwd === undefined ? context.workRoot : `${context.workRoot}/${config.cwd}`,
        {},
      );
    case "mcp":
      return aiStep(context, { permission: config.permission ?? "readOnly" }, [
        `Use the tools of the MCP server "${config.server}" for this; it is configured in your CLI.`,
      ]);
    case "tracker":
      return trackerStep(context, config, services);
  }
}

type TrackerConfig = Extract<ServiceConfig, { door: "tracker" }>;

async function trackerStep(
  context: StepContext,
  config: TrackerConfig,
  services: Services,
): Promise<StepResult> {
  const connectionId = config.connectionId ?? (await services.trackerConnection());
  if (connectionId === null)
    throw new Error("this project is not connected to a work tracker (Work items in the sidebar)");
  const itemOf = async (): Promise<WorkItem> => {
    const wanted = filled(config.itemId ?? "{{input.items.0.ref}}", context).trim();
    if (wanted === "") throw new Error("the step names no ticket: set an item id, or hand the run a ticket");
    const items = await invoke<WorkItem[]>("tracker_work_items", {
      connectionId,
      query: { mineOnly: false, includeFinished: true },
    });
    const item = items.find((candidate) => candidate.id === wanted || candidate.displayId === wanted);
    if (item === undefined) throw new Error(`no ticket "${wanted}" on the board`);
    return item;
  };
  switch (config.action) {
    case "list": {
      const items = await invoke<WorkItem[]>("tracker_work_items", {
        connectionId,
        query: { mineOnly: false, includeFinished: false },
      });
      return { output: { value: items, files: [], summary: `${String(items.length)} tickets` } };
    }
    case "detail": {
      const item = await itemOf();
      const detail = await invoke<WorkItemDetail>("tracker_item_detail", { connectionId, item });
      return {
        output: {
          value: { ...item, ...detail },
          files: [],
          summary: `${item.displayId ?? item.id} · ${item.title}`,
        },
      };
    }
    case "comment": {
      const item = await itemOf();
      const text = filled(config.text ?? "", context);
      if (context.preview)
        return previewed(`comment on ${item.displayId ?? item.id}`, { item: item.id, text });
      await invoke("tracker_add_comment", { connectionId, item, text });
      return {
        output: {
          value: { item: item.id, text },
          files: [],
          summary: `commented on ${item.displayId ?? item.id}`,
        },
      };
    }
    case "setState": {
      const item = await itemOf();
      const state = filled(config.state ?? "", context);
      if (context.preview)
        return previewed(`${item.displayId ?? item.id} → ${state}`, { item: item.id, state });
      const updated = await invoke<WorkItem>("tracker_set_state", { connectionId, item, state });
      return {
        output: {
          value: updated,
          files: [],
          summary: `${updated.displayId ?? updated.id} → ${updated.state}`,
        },
      };
    }
  }
}

// ---- git --------------------------------------------------------------------------------

interface LogEntry {
  hash: string;
  short: string;
  author: string;
  when: string;
  subject: string;
}

async function gitStep(context: StepContext, config: GitConfig): Promise<StepResult> {
  const root = context.workRoot;
  switch (config.action) {
    case "branch": {
      const name = filled(config.branch ?? "", context).trim();
      if (name === "") throw new Error("the branch has no name");
      const said = await invoke<string>("git_create_branch", { root, name });
      return { output: { value: { branch: name, said }, files: [], summary: `on ${name}` } };
    }
    case "commit": {
      const message = filled(config.message ?? "", context).trim();
      if (message === "") throw new Error("the commit has no message");
      const said = await invoke<string>("git_commit_all", { root, message });
      return { output: { value: { message, said }, files: [], summary: firstLine(message) } };
    }
    case "push": {
      if (context.preview) return previewed("git push", { root });
      const said = await invoke<string>("git_push", { root });
      return { output: { value: { said }, files: [], summary: "pushed" } };
    }
    case "diff": {
      const diff = await invoke<string>("git_pending_diff", { root });
      return {
        output: { value: diff, files: [], summary: `${String(diff.split("\n").length)} lines of diff` },
      };
    }
    case "log": {
      const entries = await invoke<LogEntry[]>("git_log", { root, limit: config.count ?? 20 });
      return { output: { value: entries, files: [], summary: `${String(entries.length)} commits` } };
    }
    case "pr": {
      const title = filled(config.title ?? "", context).trim();
      const body = filled(config.body ?? "", context);
      const base = config.base ?? "main";
      if (title === "") throw new Error("the pull request has no title");
      if (context.preview) return previewed(`pull request "${title}"`, { title, body, base });
      // `gh` is the one tool that opens a PR on GitHub without a token of
      // Aime's own; a machine without it is told so rather than guessed around.
      return runPrograms(
        context,
        [{ program: "gh", args: ["pr", "create", "--title", title, "--body", body, "--base", base] }],
        root,
        {},
      );
    }
  }
}

// ---- mail -------------------------------------------------------------------------------

interface MailOutcome {
  sent: boolean;
  from: string;
  to: string[];
  subject: string;
}

async function mailStep(context: StepContext, config: MailConfig): Promise<StepResult> {
  const request = {
    connection: config.connection,
    to: config.to.map((to) => filled(to, context)),
    subject: filled(config.subject, context),
    body: filled(config.body, context),
    preview: context.preview,
  };
  const outcome = await invoke<MailOutcome>("flow_mail", { request });
  return {
    output: {
      value: { ...outcome, body: request.body },
      files: [],
      summary: outcome.sent
        ? `sent "${outcome.subject}" to ${outcome.to.join(", ")}`
        : `preview: "${outcome.subject}" to ${outcome.to.join(", ")}`,
    },
  };
}

// ---- files ------------------------------------------------------------------------------

const FILE_CHARS_DEFAULT = 20_000;
const MOST_FILES = 200;

async function filesStep(context: StepContext, config: FilesConfig): Promise<StepResult> {
  const all = await invoke<string[]>("list_files", { root: context.workRoot });
  const matchers = config.globs.map((glob) => globToRegExp(filled(glob, context)));
  const chosen = all.filter((path) => matchers.some((matcher) => matcher.test(path))).slice(0, MOST_FILES);
  const limit = config.limit ?? FILE_CHARS_DEFAULT;
  const value: Record<string, string> = {};
  for (const path of chosen) {
    const text = await invoke<string>("read_file", { path: `${context.workRoot}/${path}` });
    value[path] =
      text.length > limit
        ? `${text.slice(0, limit)}\n… (${String(text.length - limit)} more characters)`
        : text;
  }
  return { output: { value, files: chosen, summary: `${String(chosen.length)} files` } };
}

// ---- subflow ------------------------------------------------------------------------------

async function subflowStep(
  context: StepContext,
  config: SubflowConfig,
  services: Services,
): Promise<StepResult> {
  const flow = services.flow(config.slug);
  if (flow === undefined) throw new Error(`no flow "${config.slug}" in this project`);
  if (flow.steps.some((step) => step.config.ability === "subflow" && step.config.slug === config.slug)) {
    throw new Error(`"${config.slug}" would run itself`);
  }
  const runId = `${context.step.id}-${String(context.round)}`;
  const text = filled(config.text ?? context.step.does, context);
  const bundle: InputBundle = {
    text,
    items: context.bundle.items,
    params: Object.fromEntries(
      flow.input.hints
        .filter((hint) => hint.default !== undefined)
        .map((hint) => [hint.name, hint.default ?? ""]),
    ),
  };
  const outcome = await runFlow({
    flow,
    bundle,
    root: context.root,
    workRoot: context.workRoot,
    platform: context.platform,
    executors: realExecutors(services),
    ask: services.ask,
    confirmCost: () => Promise.resolve(true),
    journal: (event) => services.journal(runId, event),
    signal: context.signal,
    preview: context.preview,
  });
  if (outcome.status !== "done") throw new Error(outcome.error ?? `the sub-flow ${outcome.status}`);
  const last = lastOutput(flow, outcome.outputs);
  return { output: last ?? { value: null, files: [], summary: "done" }, costUsd: outcome.costUsd };
}

/** A sub-flow's result: the output of its last step by wiring, else of the last one run. */
function lastOutput(flow: Flow, outputs: Map<string, StepOutput>): StepOutput | undefined {
  const ends = flow.steps.filter((step) => !flow.wires.some((wire) => wire.from === step.id));
  for (const step of ends) {
    const output = outputs.get(step.id);
    if (output !== undefined) return output;
  }
  return [...outputs.values()].at(-1);
}

// ---- helpers ----------------------------------------------------------------------------

function abortReason(context: StepContext): Error {
  const reason: unknown = context.signal.reason;
  return reason instanceof Error ? reason : new Error(describe(reason ?? "cancelled"));
}

function clip(text: string, most: number): string {
  return text.length > most
    ? `${text.slice(0, most)}\n… (${String(text.length - most)} more characters)`
    : text;
}

function firstLine(text: string): string {
  return summarize(text.split("\n").find((line) => line.trim() !== "") ?? "");
}

export function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return summarize(lines.at(-1) ?? "");
}
