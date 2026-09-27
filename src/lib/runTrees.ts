import type { TaskDef } from "../stores/tasks";
import { isWithin, relativeTo, repositoryLabel, repositoryOf } from "./repositories";

/**
 * A task run across the repositories a ticket touches.
 *
 * A folder holding a frontend and a backend is one product, and a ticket that
 * changes an endpoint and the screen calling it lands in both. A run starts in
 * the repository on screen - its branch, its baseline - and when reading the
 * code shows the change reaching another repository of the workspace, that
 * repository joins the run before anything is written: a branch of the same
 * name, its untracked files, its suites and checks as they stand. From then on
 * every git operation and every pass over the suites covers all of them.
 *
 * Two places keep apart what used to be one: where the agent works and files
 * are named from (`workRoot` - the workspace folder, so every repository is in
 * reach), and the repositories git runs in (`trees`).
 */

/** One repository of a run beyond its first, and what stood in it before the change. */
export interface JoinedTree {
  tree: string;
  /** Git's untracked list there when it joined - the "was already there" side of cleanup. */
  untrackedBefore: string[];
}

/**
 * A repository outside the run as it stood when the run began: its changed
 * files as git lists them, one line each, sorted - so "it is the same now" is
 * one comparison of strings.
 */
export interface TreeStatus {
  tree: string;
  status: string;
}

/** The status line a snapshot compares: each changed file with its two status letters. */
export function statusLine(files: readonly { path: string; staged: string; unstaged: string }[]): string {
  return files
    .map((file) => `${file.staged}${file.unstaged} ${file.path}`)
    .sort()
    .join("\n");
}

/**
 * The repositories of the workspace that files named by the AI land in, other
 * than the ones the run already has, in the order the files named them.
 *
 * The files are relative to where the agent worked; a file outside every
 * repository, or in one the run already covers, adds nothing.
 */
export function treesReached(
  files: readonly string[],
  workRoot: string,
  repositories: readonly string[],
  already: readonly string[],
): string[] {
  const reached: string[] = [];
  for (const file of files) {
    const tree = repositoryOf(`${workRoot.replace(/[\\/]+$/, "")}/${file}`, repositories);
    if (tree === null || already.some((known) => sameFolder(known, tree))) continue;
    if (!reached.some((known) => sameFolder(known, tree))) reached.push(tree);
  }
  return reached;
}

function sameFolder(left: string, right: string): boolean {
  return isWithin(left, right) && isWithin(right, left);
}

/**
 * A joined repository's own tasks as the run runs them: from that repository's
 * folder, and named after it so a suite in the backend and one in the frontend
 * can never be mistaken for each other - the gate matches suites by id.
 */
export function tasksOfTree(tasks: readonly TaskDef[], tree: string, workRoot: string): TaskDef[] {
  const label = repositoryLabel(tree, workRoot);
  const below = isWithin(tree, workRoot) && !sameFolder(tree, workRoot) ? relativeTo(workRoot, tree) : "";
  return tasks.map((task) => {
    const cwd = [below, task.cwd ?? ""].filter((part) => part !== "").join("/");
    return {
      ...task,
      id: `${label}:${task.id}`,
      label: `${label} · ${task.label}`,
      ...(cwd === "" ? {} : { cwd }),
    };
  });
}
