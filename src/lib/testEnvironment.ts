import { invoke } from "@tauri-apps/api/core";
import { execCancel, execRun, type CommandOutcome } from "./exec";

/**
 * What a project's suites need running before they can say anything about the
 * code: a web server a Playwright suite drives, a database an API suite talks
 * to, the browser binaries a runner downloads once.
 *
 * Without it a suite fails for the machine's reasons and the run cannot tell
 * that apart from the change's: the baseline is red, the repair round is handed
 * "connection refused" as though it were a bug to fix, and a case that only a
 * browser can prove never gets proved. A repository that declares its own
 * `webServer` needed nothing; every other one was on its own.
 *
 * The split is the one the whole run keeps (ARCHITECTURE.md §5): Aime says what
 * it needs - these suites failed before any change, here is what they printed -
 * and the AI, reading the repository, says what has to be running and how this
 * project starts it. Nothing it says is believed: every service has to answer
 * on the address it was given, and the environment is kept only when the suites
 * say something different with it than without it.
 */

/** One process a suite needs alive while it runs, and where it answers once it is up. */
export interface Service {
  command: string;
  /** Where it runs, relative to the repository root; "." is the root itself. */
  dir: string;
  /** The address that answers once the service is ready - `http://localhost:5173`. */
  ready: string;
}

/** One command that prepares the machine once, before any service starts. */
export interface SetupCommand {
  command: string;
  dir: string;
}

/** What the AI said the suites need, and why. */
export interface TestEnvironment {
  setup: SetupCommand[];
  services: Service[];
  /** The AI's reason, in a sentence - what the report tells the reader. */
  why: string;
}

/** A suite that failed before the change, as the AI is shown it. */
export interface FailingSuite {
  command: string;
  output: string;
}

/** How much of a failing suite's output the AI is shown: its tail, where runners put the reasons. */
const OUTPUT_TAIL_LINES = 80;

const ENVIRONMENT_PROMPT = `Before any change was made, these test suites of this repository failed.
Decide whether they failed because the code is wrong or because something they need is not running,
and if it is the second, say what has to be running and how THIS repository starts it.

Look at the repository: the test runner's configuration (a baseURL, a webServer block, a database
URL), the package scripts, docker compose files, Makefiles, the README, the CI configuration. Do not
answer from what projects like this usually need - only from what this one declares.

Answer ONLY with JSON, no prose and no code fence:
{"why": "one sentence a developer would say",
 "setup": [{"command": "npx playwright install chromium", "dir": "."}],
 "services": [{"command": "npm run dev", "dir": ".", "ready": "http://localhost:5173"}]}

Rules:
- If the failures are the code's own - an assertion that does not hold, a compile error, a missing
  export - answer {"why": "...", "setup": [], "services": []}. Starting things would not change them.
- "services" are processes that stay up while the suites run: a dev server, an API, a database. Each
  one is a command this repository already declares (a script, a compose service, a make target),
  run from "dir" relative to the repository root, and "ready" is the address the suites reach it on -
  the one in their own configuration. Aime starts it, waits until that address answers, runs the
  suites, and stops it afterwards.
- "setup" is for commands that prepare the machine once and exit: downloading a test browser,
  applying migrations, seeding a test database. Only what the failures show is missing.
- Never a command that edits the repository's source, deploys anything, or needs a person to answer
  a prompt. Commands run through the system shell of this machine.

The suites that failed, each with the end of what it printed:
`;

/** The prompt for one baseline's failing suites. */
export function environmentPrompt(failing: FailingSuite[]): string {
  return [
    ENVIRONMENT_PROMPT,
    ...failing.flatMap((suite) => [`$ ${suite.command}`, tail(suite.output), ""]),
  ].join("\n");
}

function tail(output: string): string {
  return output.split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
}

/**
 * The AI's answer, keeping only entries that are complete; null when there is
 * no JSON object in it at all.
 *
 * A service whose `ready` is not an address Aime can knock on is dropped here
 * rather than started: there would be no way to tell it came up, and starting
 * something that cannot be waited for means running the suites against a
 * server that may not be there yet.
 */
export function parseEnvironment(reply: string): TestEnvironment | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { why, setup, services } = parsed as { why?: unknown; setup?: unknown; services?: unknown };
  return {
    why: typeof why === "string" ? why.trim() : "",
    setup: listOf(setup).flatMap((entry) => {
      const command = textOf(entry, "command");
      return command === "" ? [] : [{ command, dir: textOf(entry, "dir") || "." }];
    }),
    services: listOf(services).flatMap((entry) => {
      const command = textOf(entry, "command");
      const ready = textOf(entry, "ready");
      return command === "" || addressOf(ready) === null
        ? []
        : [{ command, dir: textOf(entry, "dir") || ".", ready }];
    }),
  };
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(entry: unknown, key: string): string {
  if (typeof entry !== "object" || entry === null) return "";
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Whether the AI said anything needs doing at all. */
export function needsAnything(environment: TestEnvironment): boolean {
  return environment.setup.length > 0 || environment.services.length > 0;
}

/** Where to knock to see whether a service is up. */
export interface Address {
  host: string;
  port: number;
}

/** Default ports of the schemes a `ready` address is written in. */
const DEFAULT_PORTS = new Map([
  ["http:", 80],
  ["https:", 443],
]);

/**
 * The host and port a `ready` address names, or null when it names none.
 *
 * `localhost:5432` - how a database address is usually written - is read as a
 * host and a port too, since that is what it is; only the knock matters, not
 * the protocol spoken after it.
 */
export function addressOf(ready: string): Address | null {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(ready) ? ready : `tcp://${ready}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const port = parsed.port === "" ? DEFAULT_PORTS.get(parsed.protocol) : Number(parsed.port);
  if (parsed.hostname === "" || port === undefined || !Number.isInteger(port)) return null;
  return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port };
}

/** How long a service is given to answer on its address. */
export const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 500;

/**
 * What starting and stopping processes takes, injected so the lifecycle below
 * can be tested without a machine to start things on.
 */
export interface Launcher {
  /** Starts a command that is expected to keep running; settles when it ends. */
  start: (id: string, command: string, cwd: string) => Promise<CommandOutcome>;
  /** Ends a command started above, and what it started. */
  stop: (id: string) => Promise<void>;
  /** Whether something accepts connections at this address right now. */
  reachable: (address: Address) => Promise<boolean>;
  /** A fresh command id. */
  nextId: () => string;
  /** Resolves after this long - the clock, so a test can run it fast. */
  sleep: (ms: number) => Promise<void>;
}

/** The launcher that starts things on this machine: `exec_run`, `exec_cancel` and a TCP knock. */
export function machineLauncher(nextId: () => string): Launcher {
  return {
    start: (id, command, cwd) => execRun(id, command, cwd),
    stop: (id) => execCancel(id),
    reachable: (address) => invoke<boolean>("net_reachable", { host: address.host, port: address.port }),
    nextId,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

/** Why the environment could not be brought up. */
export interface EnvironmentFailure {
  service: Service;
  /** The service's own last words when it exited, or null when it was still up and silent. */
  output: string | null;
}

/**
 * Runs `work` with every service up, and stops them all afterwards - whatever
 * `work` does, including throwing.
 *
 * Scoped to one pass over the suites rather than to the run on purpose: a run
 * can sit at the confirmation gate for an afternoon, be cancelled, or be
 * resumed after a restart, and a server left running through any of those is a
 * process nobody will stop. Starting it again for each pass costs seconds; a
 * suite pass costs minutes anyway.
 */
export async function withServices<T>(
  services: Service[],
  root: string,
  launcher: Launcher,
  work: () => Promise<T>,
): Promise<{ result: T } | { failure: EnvironmentFailure }> {
  const running: string[] = [];
  try {
    for (const service of services) {
      const id = launcher.nextId();
      running.push(id);
      const failure = await startAndWait(service, root, id, launcher);
      if (failure !== null) return { failure };
    }
    return { result: await work() };
  } finally {
    for (const id of running.reverse()) await launcher.stop(id);
  }
}

async function startAndWait(
  service: Service,
  root: string,
  id: string,
  launcher: Launcher,
): Promise<EnvironmentFailure | null> {
  const address = addressOf(service.ready);
  if (address === null) return { service, output: null };
  // A service that exits before it answers is not going to answer; waiting out
  // the whole timeout for it would only hide the reason it printed.
  const exit: { words: string | null } = { words: null };
  launcher.start(id, service.command, folderIn(root, service.dir)).then(
    (outcome) => {
      exit.words = lastWords(outcome);
    },
    (error: unknown) => {
      exit.words = String(error);
    },
  );
  for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
    if (await launcher.reachable(address)) return null;
    if (exit.words !== null) return { service, output: exit.words };
    await launcher.sleep(READY_POLL_MS);
  }
  return { service, output: null };
}

function lastWords(outcome: CommandOutcome): string {
  return tail([outcome.stdout, outcome.stderr].filter((part) => part.trim() !== "").join("\n"));
}

/** A directory the AI named relative to the repository, as a path to run in. */
export function folderIn(root: string, dir: string): string {
  return dir === "." || dir === "" ? root : `${root}/${dir.replace(/^\.\//, "")}`;
}
