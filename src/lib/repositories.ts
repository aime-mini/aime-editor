import { normalizePath } from "./dap/paths";

/**
 * The repositories of a workspace, and the one translation every git feature
 * needs: git names a file relative to *its* repository's root, the editor by
 * its path on disk, and the workspace root is only sometimes the same folder.
 *
 * Every path here is spelled the way the workspace's own path is spelled
 * (`git_repositories` keeps it), so a repository root is a prefix of the files
 * under it as written - only the separators and, on Windows, the case can
 * differ, and `normalizePath` settles both without changing the length.
 */

const withoutTrailingSeparator = (path: string) => path.replace(/[\\/]+$/, "");

/** Whether `path` is `folder` itself or somewhere under it. */
export function isWithin(path: string, folder: string): boolean {
  const target = normalizePath(path);
  const prefix = normalizePath(withoutTrailingSeparator(folder));
  return target === prefix || target.startsWith(`${prefix}/`);
}

/** The repository a path belongs to: the deepest one holding it, or null. */
export function repositoryOf(path: string, repositories: readonly string[]): string | null {
  let owner: string | null = null;
  for (const root of repositories) {
    if (isWithin(path, root) && (owner === null || root.length > owner.length)) owner = root;
  }
  return owner;
}

/** A path as git names it inside `repository`: relative, with forward slashes. */
export function relativeTo(repository: string, path: string): string {
  return path.slice(withoutTrailingSeparator(repository).length + 1).replaceAll("\\", "/");
}

/** A path git reported, relative to `repository`, back as a path on disk. */
export function inRepository(repository: string, relative: string): string {
  const root = withoutTrailingSeparator(repository);
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${relative.replaceAll("/", separator)}`;
}

/**
 * What a repository is called beside the others: its folder below the
 * workspace (`frontend`, `apps/web`), or its own name for the one the workspace
 * sits inside of.
 */
export function repositoryLabel(repository: string, workspace: string): string {
  const below = isWithin(repository, workspace) && normalizePath(repository) !== normalizePath(workspace);
  return below
    ? relativeTo(workspace, repository)
    : (withoutTrailingSeparator(repository).split(/[\\/]/).pop() ?? repository);
}

/**
 * The folders between a file and the workspace root, nearest first - the ones
 * the tree marks so a change shows while they are collapsed. The workspace
 * root itself is not among them: it is the tree, not a row in it.
 */
export function foldersUpTo(path: string, workspace: string): string[] {
  const folders: string[] = [];
  let current = withoutTrailingSeparator(path);
  for (;;) {
    const cut = Math.max(current.lastIndexOf("\\"), current.lastIndexOf("/"));
    if (cut <= 0) return folders;
    current = current.slice(0, cut);
    if (!isWithin(current, workspace) || normalizePath(current) === normalizePath(workspace)) return folders;
    folders.push(current);
  }
}
