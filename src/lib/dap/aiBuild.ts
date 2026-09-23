/**
 * Finding out how a project builds the program about to be debugged.
 *
 * A debugger attaches to what a build produced, so the build is part of the
 * run - and Aime's built-in step per language is a rule about the ordinary
 * shape of a project. Real repositories are regularly not that shape: a
 * nopCommerce plugin writes its assembly into the web project's `Plugins/`
 * folder and is referenced by nothing, so building the web project rebuilds
 * everything except the code being edited, and the solution is the unit there.
 *
 * No rule in Aime can tell those repositories apart - which is the same split
 * `aiTasks.ts` already makes (ARCHITECTURE.md §5): Aime says which OUTCOME it
 * needs, the AI reads the actual repository to say how this one spells it.
 * Nothing it answers is taken on trust; the caller checks the tool exists
 * before a command is stored, and the build itself is the final judge.
 */

/** What the AI read out of the repository, once it is worth believing. */
export interface DiscoveredBuild {
  /** Typed verbatim at the repository root. */
  command: string;
  /** Where in the repository this was read - a file, so a person can check it. */
  source: string;
}

/** The program about to be debugged, so the AI can say "the usual build is right". */
export interface DefaultBuild {
  /** The program being debugged, relative to the root. */
  target: string;
  /** The folder Aime builds it in, relative to the root. */
  dir: string;
}

/**
 * The brief.
 *
 * It asks for a citation, for the same reason `aiTasks.ts` does: a plausible
 * `dotnet build App.sln` for a repository with no solution file is exactly the
 * failure this is meant to avoid, and a command that has to name the file it
 * came from cannot be recalled from general knowledge of "how .NET projects
 * work". And it says outright that "the default is right" is an answer, so a
 * model with nothing to add does not invent something to say.
 */
export function buildDiscoverBuildPrompt(fallback: DefaultBuild): string {
  return [
    "A debugger is about to be attached to a program in this repository, and it can only attach to",
    "what a build produced. Read this repository and say the one command that builds that program.",
    "",
    `The program: ${fallback.target}`,
    `Its folder:  ${fallback.dir}`,
    "Without an answer, Aime builds that program alone - its own project and whatever it references -",
    "with the language's usual build command, in that folder.",
    "",
    "What matters is that every part of this repository the program loads is rebuilt - not only the",
    "project the program is in. A repository where the code being edited lives in a project that",
    "nothing references, and whose output is copied next to the program, is the case this exists for:",
    "building the program's own project there leaves yesterday's code running.",
    "",
    "Answer with JSON and nothing else:",
    '{"command":"dotnet build src/Whole.sln","source":"src/Whole.sln"}',
    "",
    'Answer {"command":""} if the command Aime would run is already the right one. That is a real',
    "answer, not a failure - most repositories are the ordinary shape.",
    "",
    "RULES - a wrong command costs the user a failed run, so:",
    "- Read the repository. Solution files, project references, build scripts, CI configuration, the README.",
    "- `source` names the file you read it from. A command you cannot cite does not belong in the answer.",
    "- The command is typed at the repository root, so write every path relative to it.",
    "- The command must terminate. It must not run the tests, publish, or start the program.",
    "- Never write a command because it is how projects of this kind usually work. Only what THIS",
    "  repository says.",
  ].join("\n");
}

/** One answer as it arrives, before anything about it is believed. */
interface RawBuild {
  command?: unknown;
  source?: unknown;
}

/**
 * Reads the answer.
 *
 * `null` covers both "the default is right" and "that reply was prose": the
 * caller's next move is the same either way - run the build Aime already had.
 */
export function parseDiscoveredBuild(reply: string): DiscoveredBuild | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const { command, source } = parsed as RawBuild;
  if (typeof command !== "string" || command.trim() === "") return null;
  // A command with no citation is the one thing this brief refuses, because it
  // is indistinguishable from the model's general knowledge of the ecosystem.
  if (typeof source !== "string" || source.trim() === "") return null;
  return { command: command.trim(), source: source.trim() };
}
