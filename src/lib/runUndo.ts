import type { Checkpoint } from "./types";

/**
 * What puts the person's tree back as it stood before a task run.
 *
 * Taken before the run takes its branch, from git rather than from anything
 * the AI says it did: a checkpoint of every repository the run works in
 * (`checkpoint.rs`, the same one a chat turn's undo uses), and the branch
 * each of them was on - the run moves them to a branch of its own, and
 * undoing it moves them back. A run in a worktree of its own has none: it
 * never touched the person's tree, and its worktree is cleaned up instead.
 */
export interface RunUndo {
  checkpoint: Checkpoint;
  /** The branch each repository was on before the run took its own. */
  branches: RepositoryBranch[];
  /** When the run was undone; absent while it stands. */
  undoneAt?: number;
}

export interface RepositoryBranch {
  tree: string;
  /** Null for a detached HEAD, which nothing is switched back to. */
  branch: string | null;
}

/** What undoing a run did, and what it did not manage - one line per step that refused. */
export interface UndoOutcome {
  /** Whether the files were put back; nothing else is tried when they were not. */
  restored: boolean;
  failed: string[];
}
