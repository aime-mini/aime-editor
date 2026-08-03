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

export interface SetupRequest {
  /** Monaco's language id — the same one the whole app keys off. */
  languageId: string;
  /** The file that exposed the gap, so the agent can look at real code. */
  relativePath: string;
  /** The command Aime probes for a language server, when it has one to probe. */
  serverCommand: string | null;
  /** What Aime would run to install that server, when it knows. */
  serverInstallHint: string | null;
  /** True when Aime has no verified debug adapter for this language. */
  debuggerMissing: boolean;
}

/** Long enough to be unambiguous, short enough that the agent reads all of it. */
export function buildSetupPrompt(request: SetupRequest): string {
  const { languageId, relativePath, serverCommand, serverInstallHint, debuggerMissing } = request;

  const gaps: string[] = [];
  if (serverCommand !== null) {
    gaps.push(
      `- Code intelligence: I probe for \`${serverCommand}\` on PATH and it is not there.` +
        (serverInstallHint === null ? "" : ` My own hint for it is \`${serverInstallHint}\`.`),
    );
  }
  if (debuggerMissing) {
    gaps.push(
      "- Debugging: I have no verified Debug Adapter Protocol adapter for this language, so F5 does nothing.",
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
    debuggerMissing
      ? "For debugging, tell me which DAP adapter this language uses and where it now lives - I " +
        "cannot offer stepping until an adapter has been verified against this project."
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
