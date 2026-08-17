/**
 * Handing a language Aime does not support yet to the AI.
 *
 * The editor knows exactly what it looked for and did not find: a language
 * server command, a debug adapter, or both. That is a far better brief than a
 * user typing "set up C++ for me" — and it is the difference between an AI
 * editor and a manual one, where the same gap ends in a documentation link.
 *
 * The prompt is built here, as a pure function, so it can be read and tested
 * without a running agent. It deliberately names the *checks* Aime performs
 * rather than the packages to install: which package serves a language changes
 * with the platform and the year, and the agent can find that out. What it
 * cannot guess is how Aime decides the gap is closed.
 */

/** The debug adapter Aime launches for a language, missing from this machine. */
export interface MissingDebugger {
  /** Aime launches this one; installing a different adapter changes nothing. */
  adapterId: string;
  /** What Aime would run to get it. */
  installHint: string;
}

/** A language server that is on this machine but would not serve. */
export interface FailedServer {
  /** The command Aime ran — it refused to start, or started and then died. */
  command: string;
  /** The failure exactly as Aime saw it: the CLI's own words, unedited. */
  reason: string;
}

export interface SetupRequest {
  /** Monaco's language id — the same one the whole app keys off. */
  languageId: string;
  /** The file that exposed the gap, so the agent can look at real code. */
  relativePath: string;
  /** The command Aime probes for a language server, when it has one to probe. */
  serverCommand: string | null;
  /** What Aime would run to install that server, when it knows. */
  serverInstallHint: string | null;
  /**
   * A server that is installed yet failed to run — the opposite gap from
   * `serverCommand`, and one an install hint cannot close: the agent has to
   * read the failure and fix the machine around the server.
   */
  failedServer: FailedServer | null;
  /**
   * The adapter Aime drives for this language when this machine has not got it.
   * Null whenever no install here would change anything — `lib/dap/availability.ts`
   * holds which answers that covers, and why each one is silent.
   */
  missingDebugger: MissingDebugger | null;
  /**
   * True when Aime drives no adapter for this language at all, so no install
   * alone can make F5 work — but writing one down can (see `TEACH_ADAPTER`).
   */
  teachDebugger: boolean;
  /**
   * Why Aime's check of a taught adapter failed, when it did. The agent gets its
   * own entry back together with the protocol-level reason, which is the only
   * way an iteration is worth anything.
   */
  verifyFailure?: string | null;
}

/**
 * The contract for teaching Aime a debugger it does not ship.
 *
 * Written out in full, in the prompt, because the agent has no other way to
 * learn it — and precise about the rules Aime enforces, since an entry that
 * misses one fails verification and costs another turn. The shape is the one
 * `dap/learned.rs` parses; its tests read the same literal, so the prompt and
 * the parser cannot drift apart quietly.
 */
const TEACH_ADAPTER = [
  "I have no debug adapter for this language at all, so F5 cannot work here until I am taught one.",
  "If this is a language people run and step through - not a document, a stylesheet or a data format -",
  "then teach me. Install the Debug Adapter Protocol adapter it uses, and write",
  "`.aime/debug-adapters.json` in this project:",
  "",
  '{ "adapters": [{',
  '  "id": "<the adapter\'s own name>",',
  '  "languageIds": ["<my language id>"],',
  '  "configType": "<the `type` its launch configuration needs>",',
  '  "transport": "stdio" | "tcpServer",',
  '  "program": "<what starts it>", "args": [...], "probeArgs": [...],',
  '  "launch": { "<fields this adapter requires>": "..." },',
  '  "prepare": { "command": "<compile step, if it needs one>" },',
  '  "installHint": "<how to install it, for when it goes missing>",',
  '  "verifyWith": { "program": "<a program in this project>", "line": <a line that runs> }',
  "}] }",
  "",
  "The rules I enforce, so aim at them:",
  "- `stdio` means the adapter speaks DAP on its own pipes; `tcpServer` means it prints the address",
  "  it bound to and I dial in. Getting this wrong looks exactly like a hung adapter.",
  "- `probeArgs` are arguments that make it print something and exit - I run them to tell whether it",
  "  is installed. Leave them out and I only look for the program on PATH, which is weaker.",
  "- `launch` is for fields the adapter itself requires (`mainClass`, `classPaths`, and so on). I add",
  "  `type`, `request`, `program` and `cwd` myself; do not repeat them.",
  "- `verifyWith` has to point at a program in this project and a line that really executes. I then",
  "  start the adapter, set a breakpoint there, launch, and only believe the entry if it stops.",
  "- Never write the `verified` field. I write that, and only after I have seen the stop myself.",
].join("\n");

/** Long enough to be unambiguous, short enough that the agent reads all of it. */
export function buildSetupPrompt(request: SetupRequest): string {
  const { languageId, relativePath, serverCommand, serverInstallHint, missingDebugger } = request;
  const { failedServer, teachDebugger } = request;

  const gaps: string[] = [];
  if (serverCommand !== null) {
    gaps.push(
      `- Code intelligence: I probe for \`${serverCommand}\` on PATH and it is not there.` +
        (serverInstallHint === null ? "" : ` My own hint for it is \`${serverInstallHint}\`.`),
    );
  }
  if (failedServer !== null) {
    gaps.push(
      `- Code intelligence: \`${failedServer.command}\` is installed here, but it failed to serve. ` +
        `What I saw, in its own words: ${failedServer.reason}`,
    );
  }
  if (missingDebugger !== null) {
    gaps.push(
      `- Debugging: I drive the \`${missingDebugger.adapterId}\` Debug Adapter Protocol adapter for ` +
        "this language and it is not on this machine, so F5 does nothing. My own hint for it is " +
        `\`${missingDebugger.installHint}\`.`,
    );
  }
  // The teach-only case: code intelligence is fine and there is no adapter to
  // install, because none exists in me at all. Without this line the prompt
  // would open with a "what is missing" heading over an empty list.
  if (serverCommand === null && missingDebugger === null && teachDebugger) {
    gaps.push(
      "- Debugging: I drive no Debug Adapter Protocol adapter for this language and this project " +
        "teaches me none, so F5 cannot work here at all.",
    );
  }

  return [
    `Set this machine up so I can work on ${languageId} properly. I have ${relativePath} open.`,
    "",
    "What is missing, from my own checks:",
    ...gaps,
    "",
    "Please:",
    "1. Read the open file and the project around it to see which toolchain this really is",
    "   (framework, version, build system) rather than assuming the default one.",
    "2. Work out what this operating system needs, check what is already installed, and install",
    "   only what is missing. Prefer the package manager this machine already uses.",
    "3. Verify each install by running the tool itself and showing me its version output.",
    "4. If something cannot be installed without a decision from me - a licence, a multi-gigabyte",
    "   download, an administrator prompt - stop and tell me instead of guessing.",
    "",
    serverCommand === null
      ? ""
      : `When you are done, \`${serverCommand}\` must be runnable from a new shell: that is exactly ` +
        "what I probe for, and until it is on PATH I will keep reporting the language as unsupported.",
    failedServer === null
      ? ""
      : `When you are done, \`${failedServer.command}\` must start and keep running. Diagnose the ` +
        "failure above before reinstalling anything - a server that dies on startup is usually " +
        "missing a runtime, a dependency or a compatible version, not the package itself. I retry " +
        "a failed server the next time a file of its language is opened, so no restart is needed.",
    missingDebugger === null
      ? ""
      : `For debugging, I look for \`${missingDebugger.adapterId}\` itself rather than for the runtime ` +
        "around it - a machine that has Python is not a machine that has debugpy - so install it into " +
        "the toolchain this project actually uses, and tell me where it ended up.",
    teachDebugger ? TEACH_ADAPTER : "",
    request.verifyFailure == null
      ? ""
      : "There is already an entry for this language in `.aime/debug-adapters.json`, and my own check " +
        "of it failed. Read that entry, fix it, and leave the `verified` field alone. What I saw:\n" +
        request.verifyFailure,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
