import type { TaskDef, TaskKind } from "../stores/tasks";

/**
 * Finding out how a project is run, by asking an AI to read it.
 *
 * Aime detects the common stacks itself — Node, .NET, Cargo, Go, Python,
 * Docker — because a `package.json` script is a fact, not an opinion, and a
 * detected task costs nothing and is instant. That set will never be complete:
 * Maven, Gradle, CMake, Make, Bazel, Composer, Flutter, Rails, and whatever a
 * team wrote in a script of their own are all real projects a user will open.
 * Hard-coding one arm per ecosystem loses that race by design.
 *
 * So the two halves are split by what each is good at (ARCHITECTURE.md §5):
 * Aime says which OUTCOME it needs — run, build, test, check, publish — and the
 * AI reads the actual repository to say how this project spells it. Nothing it
 * answers is taken on trust: `check_task_commands` confirms the tool exists on
 * this machine and the folder exists in this repository before a command is
 * ever offered, because a command that cannot run is worse than no command.
 */

/** One command the AI read out of the project. */
export interface DiscoveredTask {
  kind: TaskKind;
  /** Short human label, e.g. "mvn package". */
  label: string;
  /** Exactly what has to be typed, in `dir`. */
  command: string;
  /** Folder relative to the project root; "." is the root. */
  dir: string;
  /** Where in the repository this was read — a file, so a person can check it. */
  source: string;
}

const KINDS: TaskKind[] = ["run", "build", "test", "check", "publish"];

/** What each outcome means, in the words the model has to decide from. */
const KIND_BRIEF = [
  "- `run`: starts the application for a person to use. May never terminate (a dev server) — that is fine.",
  "- `build`: compiles or bundles the code. Must terminate.",
  "- `test`: runs the automated tests. Must terminate.",
  "- `check`: judges the code WITHOUT rewriting it — a linter, a type check, a formatter in report mode. " +
    "Never a command that reformats files.",
  "- `publish`: produces the release artifact or package.",
].join("\n");

/**
 * The brief.
 *
 * It asks for a citation per command, which is the whole point: a plausible
 * `mvn package` for a project with no `pom.xml` is exactly the failure this is
 * meant to avoid, and a command that has to name the file it came from cannot
 * be recalled from the model's general knowledge of "how Java projects work".
 */
export function buildDiscoverTasksPrompt(wanted: TaskKind[]): string {
  return [
    "Read this repository and report how it is actually run, built and tested.",
    "",
    `Aime already knows the common stacks and found nothing for: ${wanted.join(", ")}.`,
    "Report every outcome you can support, not only those - the rest are useful too.",
    "",
    "The five outcomes:",
    KIND_BRIEF,
    "",
    "RULES - a wrong command costs the user a failed run, so:",
    "- Read the repository. Manifests, CI configuration, Dockerfiles, Makefiles, scripts, the README.",
    "- Every command must come from something in the repository. Never write a command because it is " +
      "how projects of this kind usually work; if the repository does not say, leave that outcome out.",
    "- `source` names the file you read it from. A command you cannot cite does not belong in the answer.",
    "- Prefer the project's own script over the raw tool underneath it.",
    "- `command` is typed verbatim in `dir`, so include every argument it needs. Quote paths with spaces.",
    "- One command per outcome per folder. In a repository with several applications, one per application.",
    "- `dir` is relative to the repository root, forward slashes, `.` for the root itself.",
    "- Do not run anything that changes the repository, and do not install anything.",
    "",
    "Answer with ONLY this JSON, no prose and no code fence:",
    '{"tasks":[{"kind":"build","label":"mvn package","command":"mvn -q package","dir":".","source":"pom.xml"}]}',
    "",
    "An empty list is the right answer when the repository does not say how it is built.",
  ].join("\n");
}

/** One entry as it arrives, before anything about it is believed. */
interface RawTask {
  kind?: unknown;
  label?: unknown;
  command?: unknown;
  dir?: unknown;
  source?: unknown;
}

function asDiscovered(raw: RawTask): DiscoveredTask | null {
  const { kind, label, command, dir, source } = raw;
  if (typeof kind !== "string" || !KINDS.includes(kind as TaskKind)) return null;
  if (typeof command !== "string" || command.trim() === "") return null;
  if (typeof source !== "string" || source.trim() === "") return null;
  return {
    kind: kind as TaskKind,
    label: typeof label === "string" && label.trim() !== "" ? label.trim() : command.trim(),
    command: command.trim(),
    dir: typeof dir === "string" && dir.trim() !== "" ? dir.trim() : ".",
    source: source.trim(),
  };
}

/**
 * Reads the answer, keeping only entries that are complete.
 *
 * A reply that is prose rather than JSON yields an empty list, never a throw:
 * the caller's next move is the same either way, and it already has to handle
 * a model that found nothing.
 */
export function parseDiscoveredTasks(reply: string): DiscoveredTask[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((entry) => asDiscovered(entry as RawTask))
    .filter((task): task is DiscoveredTask => task !== null);
}

/**
 * The task as Aime stores it, tagged so a person can tell it apart from a
 * detected one and so a later discovery replaces it instead of duplicating it.
 */
export function asTaskDef(task: DiscoveredTask): TaskDef {
  return {
    id: `ai.${task.kind}.${task.dir === "." ? "root" : task.dir.replaceAll("/", ".")}`,
    label: task.label,
    kind: task.kind,
    command: task.command,
    ...(task.dir === "." ? {} : { cwd: task.dir }),
  };
}
