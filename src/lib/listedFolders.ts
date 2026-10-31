/** One spelling for a path from the watcher, the tree or the store: forward slashes, no trailing one. */
function normalised(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Whether any of `changed` sits directly in a folder the file tree lists -
 * its root, or a folder that is open - so that the listing on screen is out
 * of date.
 */
export function touchesListedFolder(changed: readonly string[], listed: readonly string[]): boolean {
  const folders = new Set(listed.map(normalised));
  return changed.some((path) => folders.has(parentOf(normalised(path))));
}
