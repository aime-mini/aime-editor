/**
 * What a workspace is reopened with: the tabs, where each one was looked at,
 * the text that had not been saved yet, and how the tree was left.
 *
 * Pure on purpose - the store gathers the pieces and applies the result, and
 * every decision about what comes back, and how, is made here where a test
 * can see it.
 */

/** Bumped when the shape changes; a file of another version is not read. */
export const SNAPSHOT_VERSION = 1;

/** A file's text that had not reached the disk, and what the disk held then. */
export interface UnsavedText {
  content: string;
  savedContent: string;
}

export interface WorkspaceSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** In tab order, the cloud panel's tab included. */
  tabs: string[];
  /** The file that was in front, or null when none was. */
  active: string | null;
  cloudOpen: boolean;
  /** Only the files with something unsaved: the rest are read again from disk. */
  unsaved: Record<string, UnsavedText>;
  /** Monaco's own view state per file - cursor, selection, scroll, folds. Opaque here. */
  views: Record<string, unknown>;
  /** Folders open in the file tree. */
  expanded: string[];
  sidebarView: string;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnsavedText = (value: unknown): value is UnsavedText =>
  isRecord(value) && typeof value.content === "string" && typeof value.savedContent === "string";

/**
 * Whether a stored value is a snapshot this version can use.
 *
 * Checked field by field, because the file outlives the code that wrote it: a
 * snapshot of another version, or one edited by hand, is ignored rather than
 * allowed to put something that is not a path into the tab strip.
 */
export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return (
    isRecord(value) &&
    value.version === SNAPSHOT_VERSION &&
    isStringArray(value.tabs) &&
    (value.active === null || typeof value.active === "string") &&
    typeof value.cloudOpen === "boolean" &&
    isRecord(value.unsaved) &&
    Object.values(value.unsaved).every(isUnsavedText) &&
    isRecord(value.views) &&
    isStringArray(value.expanded) &&
    typeof value.sidebarView === "string"
  );
}

/**
 * How the file on disk compares with what the unsaved text was written against.
 * "missing" is a file that can no longer be read - moved, deleted or locked; the
 * failed read cannot tell those apart, so neither does the notice.
 */
export type DiskState = "unchanged" | "changed" | "missing";

/** What one tab comes back as. */
export type RestoredTab =
  | { kind: "clean"; path: string; content: string }
  | { kind: "unsaved"; path: string; content: string; savedContent: string; disk: DiskState }
  | { kind: "gone"; path: string };

/**
 * Decides how one tab comes back, from what was left unsaved and what the disk
 * holds now (`null` when the file can no longer be read).
 *
 * The one rule: text that was never saved is never thrown away. A file edited
 * or deleted by something else while Aime was closed keeps the unsaved text and
 * says so, and `savedContent` is set to what the disk holds *now*, so the dot
 * and the next save both measure against the file as it really is.
 */
export function restoreTab(path: string, unsaved: UnsavedText | undefined, disk: string | null): RestoredTab {
  if (unsaved === undefined) {
    // Nothing of ours to keep: the disk is the truth, and a file that is gone
    // takes its tab with it.
    return disk === null ? { kind: "gone", path } : { kind: "clean", path, content: disk };
  }
  if (disk === null) {
    return { kind: "unsaved", path, content: unsaved.content, savedContent: "", disk: "missing" };
  }
  if (unsaved.content === disk) {
    // Whoever changed the file made the same change: nothing is unsaved any more.
    return { kind: "clean", path, content: disk };
  }
  return {
    kind: "unsaved",
    path,
    content: unsaved.content,
    savedContent: disk,
    disk: disk === unsaved.savedContent ? "unchanged" : "changed",
  };
}
