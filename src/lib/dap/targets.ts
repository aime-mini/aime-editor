/**
 * Which program F5 runs.
 *
 * Aime scans the project's own manifests for candidates (`dap_targets`, Rust),
 * and this module decides which of them a run uses. The rules are pure so the
 * decision can be read and tested without a project on disk — and so that the
 * one place an agent will eventually answer instead is a single function.
 *
 * The order matters, and each step exists for a measured reason:
 *  1. the program the open file lives inside, when it is more specific than what
 *     the user picked — the file in front of you is the clearest statement of
 *     what you are working on, so moving between two services switches target
 *     and its arguments by itself.
 *  2. what the user picked, while it still exists — a choice, once made, is not
 *     quietly overridden by a rescan, nor by a file that merely sits above it.
 *  3. the only candidate, when there is exactly one — no question to ask.
 *  4. among several, one whose language matches the file in front of the user —
 *     the least surprising guess, and the panel says which it took.
 *  5. the open file itself, when the project offered nothing.
 */

import { fileNameOf } from "./paths";

/** Mirror of the Rust `DebugTarget` (dap/targets.rs). */
export interface DebugTarget {
  id: string;
  label: string;
  languageId: string;
  /** A file, a Go package directory, or a .NET project. Absolute. */
  program: string;
  /** The folder the program - and the adapter - runs in. */
  cwd: string;
}

/** Mirror of the Rust `LaunchOptions` (dap/options.rs). */
export interface TargetLaunchOptions {
  args?: string[];
  env?: Record<string, string>;
}

/** Where a resolved target came from, which is what the panel explains. */
export type TargetOrigin =
  /** The open file lives inside this program's folder. */
  | "nearest"
  /** The user picked this one from the project's candidates. */
  | "chosen"
  /** The only program the project offers. */
  | "only"
  /** One of several: the one that matches the open file's language. */
  | "matched"
  /** One of several and none matched, so the outermost was taken. */
  | "assumed"
  /** The project offered nothing; the open file is the program. */
  | "file";

export interface ResolvedTarget {
  target: DebugTarget;
  origin: TargetOrigin;
}

/**
 * The open file as a target of its own.
 *
 * Not a project entry point, and deliberately available anyway: a one-off
 * script is a real thing to debug, and it is the only answer left for a
 * language whose project layout Aime cannot read (a TypeScript entry needing a
 * loader, for one). The working directory stays the workspace root, which is
 * what running the file by hand from a terminal would do.
 */
export function fileTarget(path: string, languageId: string, root: string): DebugTarget {
  return {
    id: `file:${path}`,
    label: fileNameOf(path),
    languageId,
    program: path,
    cwd: root,
  };
}

export interface Resolution {
  targets: DebugTarget[];
  chosenId: string | null;
  openFilePath: string | null;
  openLanguageId: string | null;
  root: string;
}

/** Path pieces, case-insensitively and separator-insensitively — this is Windows too. */
function pieces(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .filter((piece) => piece !== "");
}

/** Whether `folder` holds `file`, anywhere below it. */
function holds(folder: string[], file: string[]): boolean {
  return folder.length < file.length && folder.every((piece, index) => piece === file[index]);
}

/**
 * The program the open file lives inside, taking the most specific one.
 *
 * `cwd` is the folder a candidate *is* - a Go package, a .NET project, the
 * directory of a `package.json`. In a monorepo those nest, so the deepest match
 * is the one that means something: editing `services/api/main.go` is working on
 * the api, not on the repository.
 *
 * A candidate that sits *at* the project root is deliberately not counted. It
 * holds every file there is, so counting it would make this rule fire for
 * everything - including a README - and would silence the language match and the
 * honest "assumed" label below.
 */
function nearestTarget(
  targets: DebugTarget[],
  openFilePath: string | null,
  root: string,
): DebugTarget | null {
  if (openFilePath === null) return null;
  const file = pieces(openFilePath);
  const rootDepth = pieces(root).length;
  let best: DebugTarget | null = null;
  let bestDepth = rootDepth;
  for (const target of targets) {
    const folder = pieces(target.cwd);
    if (!holds(folder, file) || folder.length <= bestDepth) continue;
    best = target;
    bestDepth = folder.length;
  }
  return best;
}

/** What a run would launch right now, and why — null when there is nothing. */
export function resolveTarget(resolution: Resolution): ResolvedTarget | null {
  const { targets, chosenId, openFilePath, openLanguageId, root } = resolution;

  const openFile =
    openFilePath !== null && openLanguageId !== null ? fileTarget(openFilePath, openLanguageId, root) : null;
  // A choice can also be "the open file", and nothing is more specific than the
  // file itself - a one-off script stays the target while it is the one open.
  if (openFile && chosenId === openFile.id) return { target: openFile, origin: "chosen" };

  const chosen = targets.find((target) => target.id === chosenId);
  const nearest = nearestTarget(targets, openFilePath, root);
  /**
   * How specifically the choice covers the open file - and -1 when it does not
   * cover it at all. A pick only survives a file that belongs somewhere else if
   * that file is inside the pick too: editing `services/api` while `worker` is
   * picked means the api, but opening a shared module means nothing new.
   */
  const chosenDepth =
    chosen && openFilePath !== null && holds(pieces(chosen.cwd), pieces(openFilePath))
      ? pieces(chosen.cwd).length
      : -1;
  if (nearest && pieces(nearest.cwd).length > chosenDepth) {
    return { target: nearest, origin: "nearest" };
  }
  if (chosen) return { target: chosen, origin: "chosen" };

  if (targets.length === 0) {
    return openFile === null ? null : { target: openFile, origin: "file" };
  }
  // The outermost program, which the scan puts first.
  const [first] = targets;
  if (targets.length === 1) return { target: first, origin: "only" };

  const matching = targets.find((target) => target.languageId === openLanguageId);
  return matching ? { target: matching, origin: "matched" } : { target: first, origin: "assumed" };
}
