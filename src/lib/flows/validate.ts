import { ERROR_PORT, OUT_PORT, RUNNABLE_ABILITIES, type Flow, type Step, type Wire } from "./model";

/**
 * What is wrong with a flow before it runs, each problem anchored to the
 * step or wire it is about so the canvas can point at it. A flow with a
 * problem of kind "error" does not run; a "warning" runs and is shown.
 */
export interface Problem {
  kind: "error" | "warning";
  /** The step, or `from->to` for a wire, or "flow". */
  at: string;
  message: string;
}

/** The longest a wait step may sleep: polling, not scheduling. */
export const MAX_WAIT_SECONDS = 3600;

/** Parts of a command line that only a shell understands. */
const SHELL_OPERATORS = new Set(["&&", "||", "|", ";", ">", ">>", "<", "2>", "2>&1", "&"]);
/** A part that is a variable or a wildcard pattern, which a shell would have expanded. */
const UNEXPANDED = /^(\$\w+|\$\{\w+\}|%\w+%|[^\s"']*\*[^\s"']*)$/;

export function validate(flow: Flow): Problem[] {
  const problems: Problem[] = [];
  const error = (at: string, message: string) => problems.push({ kind: "error", at, message });
  const warning = (at: string, message: string) => problems.push({ kind: "warning", at, message });

  const ids = new Set<string>();
  for (const step of flow.steps) {
    if (ids.has(step.id)) error(step.id, `two steps share the id "${step.id}"`);
    ids.add(step.id);
  }
  const inputs = flow.steps.filter((step) => step.config.ability === "input");
  if (inputs.length !== 1)
    error("flow", `a flow has exactly one input step, this one has ${String(inputs.length)}`);

  for (const step of flow.steps) checkStep(step, error, warning);

  const byId = new Map(flow.steps.map((step) => [step.id, step]));
  for (const wire of flow.wires) {
    const at = `${wire.from}->${wire.to}`;
    const from = byId.get(wire.from);
    const to = byId.get(wire.to);
    if (from === undefined) error(at, `the wire starts at "${wire.from}", which is no step`);
    if (to === undefined) error(at, `the wire ends at "${wire.to}", which is no step`);
    if (to?.config.ability === "input") error(at, "nothing wires into the input step");
    if (from !== undefined && !portsOf(from).includes(wire.port)) {
      error(at, `"${from.name}" has no port "${wire.port}"`);
    }
  }

  const loops = loopWires(flow);
  for (const wire of loops) {
    if (wire.maxRounds === undefined || wire.maxRounds < 1) {
      error(
        `${wire.from}->${wire.to}`,
        "a wire back to an earlier step is a loop and must say how many rounds at most",
      );
    }
  }

  const reached = reachable(flow, loops);
  for (const step of flow.steps) {
    if (step.config.ability !== "input" && !reached.has(step.id)) {
      warning(step.id, `"${step.name}" is not wired from the input and will never run`);
    }
  }
  return problems;
}

function checkStep(
  step: Step,
  error: (at: string, message: string) => void,
  warning: (at: string, message: string) => void,
) {
  if (!RUNNABLE_ABILITIES.includes(step.config.ability)) {
    error(step.id, `"${step.name}" uses "${step.config.ability}", which this version of Aime cannot run yet`);
  }
  if (step.retries < 0 || !Number.isInteger(step.retries)) error(step.id, "retries is a whole number");
  const { config } = step;
  switch (config.ability) {
    case "command": {
      const { command } = config;
      const arms = [command.all, command.windows, command.macos, command.linux].filter(
        (arm) => arm !== undefined && (typeof arm === "string" ? arm.trim() !== "" : arm.length > 0),
      );
      if (arms.length === 0) error(step.id, `"${step.name}" has no command`);
      if (command.all !== undefined) {
        for (const invocation of command.all) {
          if (invocation.program.trim() === "") error(step.id, "a shared command names a program");
          // Each part reaches the program as it is, so `x => y` for node -e or
          // `a|b` for grep is fine. A part that IS a shell operator was meant
          // for a shell; a bare variable or glob reaches the program unexpanded.
          const parts = [invocation.program, ...invocation.args].map((part) => part.trim());
          const operator = parts.find((part) => SHELL_OPERATORS.has(part));
          if (operator !== undefined) {
            error(
              step.id,
              `"${operator}" is shell syntax; a shared command runs without a shell - put it in a platform arm`,
            );
          }
          const unexpanded = parts.find((part) => UNEXPANDED.test(part));
          if (unexpanded !== undefined) {
            warning(
              step.id,
              `"${unexpanded}" reaches the program as written - nothing expands it without a shell`,
            );
          }
        }
      }
      if (config.cwd !== undefined && !isRelative(config.cwd)) {
        error(step.id, `"${config.cwd}" is not relative to the workspace, so it cannot survive a clone`);
      }
      break;
    }
    case "transform":
      if (config.program.trim() === "") error(step.id, `"${step.name}" has no jq program`);
      break;
    case "gate":
      if (config.branches.length === 0) error(step.id, `"${step.name}" has no branches`);
      for (const branch of config.branches) {
        if (branch.label.trim() === "" || branch.label === OUT_PORT || branch.label === ERROR_PORT) {
          error(step.id, `a branch of "${step.name}" needs a label of its own`);
        }
        if (branch.program.trim() === "")
          error(step.id, `branch "${branch.label}" of "${step.name}" has no condition`);
      }
      break;
    case "wait":
      if (!(config.seconds > 0 && config.seconds <= MAX_WAIT_SECONDS)) {
        error(step.id, `a wait is between 1 and ${String(MAX_WAIT_SECONDS)} seconds`);
      }
      break;
    case "human":
      if (config.mode === "choose" && (config.options === undefined || config.options.length < 2)) {
        error(step.id, `"${step.name}" asks to choose, but offers fewer than two options`);
      }
      break;
    case "ai":
      if (step.does.trim() === "") warning(step.id, `"${step.name}" does not say what the AI should do`);
      break;
    case "http":
      if (config.url.trim() === "") error(step.id, `"${step.name}" has no URL`);
      if (!/^https?:\/\//.test(config.url.trim()) && !config.url.trim().startsWith("{{")) {
        error(step.id, `"${config.url}" is not an http(s) URL`);
      }
      break;
    case "service":
      if (config.door === "mcp" && config.server.trim() === "")
        error(step.id, `"${step.name}" names no MCP server`);
      if (config.door === "cli")
        checkStep(
          { ...step, config: { ability: "command", command: config.command, cwd: config.cwd } },
          error,
          warning,
        );
      break;
    case "git":
      if (config.action === "branch" && (config.branch ?? "").trim() === "")
        error(step.id, `"${step.name}" names no branch`);
      if (config.action === "commit" && (config.message ?? "").trim() === "")
        error(step.id, `"${step.name}" has no commit message`);
      if (config.action === "pr" && (config.title ?? "").trim() === "")
        error(step.id, `"${step.name}" has no pull request title`);
      break;
    case "mail":
      if (config.connection.trim() === "") error(step.id, `"${step.name}" names no mail connection`);
      if (config.to.length === 0) error(step.id, `"${step.name}" has nobody to send to`);
      break;
    case "files":
      if (config.globs.length === 0) error(step.id, `"${step.name}" names no files`);
      for (const glob of config.globs)
        if (!isRelative(glob)) error(step.id, `"${glob}" is not relative to the workspace`);
      break;
    case "subflow":
      if (config.slug.trim() === "") error(step.id, `"${step.name}" names no flow`);
      break;
    default:
      break;
  }
}

/** Paths in a flow are relative to the workspace and never climb out of it. */
export function isRelative(path: string): boolean {
  return !/^([a-zA-Z]:|\\\\|\/)/.test(path) && !path.split(/[\\/]/).includes("..");
}

/** The ports a step's wires may leave from. */
export function portsOf(step: Step): string[] {
  const ports = [OUT_PORT, ERROR_PORT];
  if (step.config.ability === "gate") {
    return [...step.config.branches.map((branch) => branch.label), ERROR_PORT];
  }
  return ports;
}

/**
 * The wires that go back to an earlier step. A depth-first walk from the
 * input over the wires: a wire into a step still on the walk's stack is a
 * loop. Gates and errors are followed too; a loop is a loop whichever port
 * closes it.
 */
export function loopWires(flow: Flow): Wire[] {
  const outgoing = new Map<string, Wire[]>();
  for (const wire of flow.wires) {
    const list = outgoing.get(wire.from) ?? [];
    list.push(wire);
    outgoing.set(wire.from, list);
  }
  const input = flow.steps.find((step) => step.config.ability === "input");
  if (input === undefined) return [];
  const loops: Wire[] = [];
  const onStack = new Set<string>();
  const finished = new Set<string>();
  const walk = (id: string) => {
    onStack.add(id);
    for (const wire of outgoing.get(id) ?? []) {
      if (onStack.has(wire.to)) loops.push(wire);
      else if (!finished.has(wire.to)) walk(wire.to);
    }
    onStack.delete(id);
    finished.add(id);
  };
  walk(input.id);
  return loops;
}

/** The steps a run can reach from the input, loop wires aside. */
function reachable(flow: Flow, loops: Wire[]): Set<string> {
  const forward = flow.wires.filter((wire) => !loops.includes(wire));
  const input = flow.steps.find((step) => step.config.ability === "input");
  const reached = new Set<string>();
  if (input === undefined) return reached;
  const queue = [input.id];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || reached.has(id)) continue;
    reached.add(id);
    for (const wire of forward) if (wire.from === id) queue.push(wire.to);
  }
  return reached;
}
