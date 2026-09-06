import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { translate } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { aiOneshot } from "../lib/aiOneshot";
import { formatProviderError } from "../lib/providerErrors";
import { parseReview, REVIEW_PROMPT, type Review } from "../lib/aiReview";
import { useWorkspace } from "./workspace";

export interface GitFile {
  path: string;
  orig_path: string | null;
  staged: string;
  unstaged: string;
  conflicted: boolean;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitLogEntry {
  hash: string;
  short: string;
  author: string;
  when: string;
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  /** A remote-tracking branch (`origin/feature`): checkout-only. */
  remote: boolean;
}

export interface GitStashEntry {
  index: number;
  message: string;
}

const LOG_PAGE = 30;

/** True when the index holds something for this file. */
export function isStaged(file: GitFile): boolean {
  return file.staged !== " " && file.staged !== "." && file.staged !== "?";
}

/** True when the worktree differs from the index (or the file is untracked). */
export function isUnstaged(file: GitFile): boolean {
  return file.unstaged !== " " && file.unstaged !== ".";
}

interface GitState {
  status: GitStatus | null;
  log: GitLogEntry[];
  /** Current history page size; grows via loadMoreLog. */
  logLimit: number;
  loadMoreLog: () => Promise<void>;
  stashes: GitStashEntry[];
  /**
   * Repo-relative paths git ignores, a fully ignored directory collapsed into
   * one entry. The file tree greys them out; everything under such a directory
   * inherits, which is why the list stays a dozen entries instead of thousands.
   */
  ignored: string[];
  busy: boolean;
  /** What that operation is, named for the user; null when idle. */
  busyLabel: string | null;
  lastError: string | null;
  commitMessage: string;
  /** true = the next commit rewrites the last one (--amend). */
  amend: boolean;
  setAmend: (amend: boolean) => void;
  generating: boolean;
  stashPush: (message: string) => Promise<void>;
  stashApply: (index: number) => Promise<void>;
  stashPop: (index: number) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;

  refresh: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (file: GitFile) => Promise<void>;
  discardMany: (files: GitFile[]) => Promise<void>;
  ignore: (paths: string[]) => Promise<void>;
  /** Drops paths git already tracks out of the index, then ignores them. */
  untrackAndIgnore: (paths: string[]) => Promise<void>;
  commit: () => Promise<void>;
  push: () => Promise<void>;
  pull: () => Promise<void>;
  init: () => Promise<void>;
  listBranches: () => Promise<GitBranch[]>;
  checkout: (name: string) => Promise<void>;
  /** Checks a remote branch out as a local branch that tracks it. */
  checkoutTracking: (name: string) => Promise<void>;
  createBranch: (name: string) => Promise<void>;
  renameBranch: (from: string, to: string) => Promise<void>;
  /** "unmerged" means git refused because the branch holds unmerged work. */
  deleteBranch: (name: string, force?: boolean) => Promise<"deleted" | "unmerged" | "failed">;
  mergeBranch: (name: string) => Promise<void>;
  fetch: () => Promise<void>;
  listRemotes: () => Promise<GitRemote[]>;
  setRemote: (name: string, url: string) => Promise<void>;
  listTags: () => Promise<string[]>;
  createTag: (name: string, message: string) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
  pushTags: () => Promise<void>;
  revertCommit: (sha: string) => Promise<void>;
  cherryPick: (sha: string) => Promise<void>;
  resetTo: (sha: string, mode: ResetMode) => Promise<void>;
  setCommitMessage: (message: string) => void;
  generateCommitMessage: () => Promise<void>;
  /** A second opinion on what is about to be committed. */
  reviewing: boolean;
  review: Review | null;
  reviewChanges: () => Promise<void>;
  dismissReview: () => void;
  clear: () => void;
}

/** Mirror of the Rust `GitRemote` (git/mod.rs). */
export interface GitRemote {
  name: string;
  url: string;
}

/**
 * What a reset does with the work that came after the target commit:
 * `soft` keeps it staged, `mixed` keeps it in the working tree, `hard` throws
 * it away - which is why the panel confirms that one twice.
 */
export type ResetMode = "soft" | "mixed" | "hard";

/**
 * Serializes a git operation: run, surface errors, then re-read status.
 *
 * `busy` is not enough on its own, which is what `busyLabel` is for. Fetch,
 * pull, push and merge talk to a remote and take seconds on a real repository,
 * and before this the panel showed nothing at all while they did - the button
 * simply did not respond, which reads as an editor that is not working rather
 * than one that is. Every op therefore says what it is doing, by name.
 */
async function runOp(
  set: (partial: Partial<GitState>) => void,
  label: TranslationKey,
  op: () => Promise<unknown>,
) {
  set({ busy: true, busyLabel: translate(label), lastError: null });
  try {
    await op();
  } catch (err: unknown) {
    set({ lastError: String(err) });
  } finally {
    set({ busy: false, busyLabel: null });
    await useGit.getState().refresh();
  }
}

const DIFF_PROMPT_LIMIT = 12_000;

const COMMIT_MESSAGE_PROMPT =
  "Write a git commit message for the changes below. Output ONLY the message - no quotes, no code fences. " +
  "Imperative subject line under 72 characters; add a short body only when the change needs explanation.\n\n";

/**
 * The uncommitted change, ready for a prompt: an empty string when there is
 * nothing to describe, so callers test one thing instead of trimming twice.
 */
async function pendingDiff(root: string): Promise<string> {
  const diff = (await invoke<string>("git_pending_diff", { root })).trim();
  if (!diff) return "";
  return diff.length > DIFF_PROMPT_LIMIT ? `${diff.slice(0, DIFF_PROMPT_LIMIT)}\n[diff truncated]` : diff;
}

/**
 * Auto-refresh: treeVersion bumps on every fs change (watcher + tree ops),
 * rootPath changes on open/close folder — both mean git state may be stale.
 */
useWorkspace.subscribe((state, prev) => {
  if (state.rootPath !== prev.rootPath) {
    useGit.getState().clear();
  }
  if (state.rootPath !== prev.rootPath || state.treeVersion !== prev.treeVersion) {
    void useGit.getState().refresh();
  }
});

export const useGit = create<GitState>((set, get) => {
  /**
   * One repo read at a time, latecomers folded into a single trailing pass.
   *
   * Every trigger lands on refresh(): the watcher fires several debounced
   * bursts while a checkout is still rewriting the worktree, and runOp adds
   * its own call when the command returns. Uncoalesced, each call was four
   * more git processes racing the others for .git/index.lock on a large
   * repository — the loser skips its index write, so the index stayed stale
   * and every later status paid the full re-stat again ("git got slow"), and
   * when the last pass was the loser the panel kept showing the old branch
   * until the app was restarted. The trailing pass reads the final state, so
   * whoever asked last still gets the truth.
   */
  let inFlight: Promise<void> | null = null;
  let queued = false;
  /** Asked, never remembered: the compiler narrows a boolean across an await. */
  const takeQueued = () => {
    const was = queued;
    queued = false;
    return was;
  };

  const readRepo = async () => {
    const root = useWorkspace.getState().rootPath;
    if (!root) {
      set({ status: null, log: [] });
      return;
    }
    try {
      const [status, log, stashes, ignored] = await Promise.all([
        invoke<GitStatus>("git_status", { root }),
        invoke<GitLogEntry[]>("git_log", { root, limit: get().logLimit }),
        invoke<GitStashEntry[]>("git_stash_list", { root }),
        invoke<string[]>("git_ignored", { root }),
      ]);
      set({ status, log, stashes, ignored });
    } catch (err: unknown) {
      set({ lastError: String(err) });
    }
  };

  return {
    status: null,
    log: [],
    logLimit: LOG_PAGE,
    stashes: [],
    ignored: [],
    busy: false,
    busyLabel: null,
    lastError: null,
    commitMessage: "",
    amend: false,
    generating: false,
    reviewing: false,
    review: null,

    setAmend: (amend) => {
      set({ amend });
    },

    refresh: async () => {
      if (inFlight) {
        queued = true;
        return inFlight;
      }
      inFlight = (async () => {
        do {
          await readRepo();
        } while (takeQueued());
      })();
      try {
        await inFlight;
      } finally {
        inFlight = null;
      }
    },

    loadMoreLog: async () => {
      set((s) => ({ logLimit: s.logLimit + LOG_PAGE }));
      await get().refresh();
    },

    stage: async (paths) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.stage", () => invoke("git_stage", { root, paths }));
    },

    unstage: async (paths) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.unstage", () => invoke("git_unstage", { root, paths }));
    },

    discard: async (file) => {
      const root = useWorkspace.getState().rootPath;
      if (!root) return;
      await runOp(set, "git.busy.discard", () =>
        invoke("git_discard", { root, path: file.path, untracked: file.unstaged === "?" }),
      );
    },

    discardMany: async (files) => {
      const root = useWorkspace.getState().rootPath;
      if (!root || files.length === 0) return;
      await runOp(set, "git.busy.discard", async () => {
        for (const file of files) {
          await invoke("git_discard", { root, path: file.path, untracked: file.unstaged === "?" });
        }
      });
    },

    ignore: async (paths) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.ignore", () => invoke("git_ignore", { root, paths }));
    },

    untrackAndIgnore: async (paths) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.untrack", () => invoke("git_untrack_and_ignore", { root, paths }));
    },

    commit: async () => {
      const root = useWorkspace.getState().rootPath;
      const message = get().commitMessage.trim();
      if (!root || (!message && !get().amend)) return; // amend may reuse the old message
      await runOp(set, "git.busy.commit", async () => {
        // Smart commit (VS Code parity): nothing staged → stage all changes first.
        const files = get().status?.files ?? [];
        if (!files.some(isStaged)) {
          const everything = files.filter(isUnstaged).map((f) => f.path);
          if (everything.length > 0) await invoke("git_stage", { root, paths: everything });
        }
        await invoke("git_commit", { root, message, amend: get().amend });
        set({ commitMessage: "", amend: false });
      });
    },

    push: async () => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.push", () => invoke("git_push", { root }));
    },

    pull: async () => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.pull", () => invoke("git_pull", { root }));
    },

    init: async () => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.init", () => invoke("git_init", { root }));
    },

    stashPush: async (message) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.stash", () => invoke("git_stash_push", { root, message }));
    },

    stashApply: async (index) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.stash", () => invoke("git_stash_apply", { root, index }));
    },

    stashPop: async (index) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.stash", () => invoke("git_stash_pop", { root, index }));
    },

    stashDrop: async (index) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.stash", () => invoke("git_stash_drop", { root, index }));
    },

    listBranches: async () => {
      const root = useWorkspace.getState().rootPath;
      if (!root) return [];
      try {
        return await invoke<GitBranch[]>("git_branches", { root });
      } catch (err: unknown) {
        set({ lastError: String(err) });
        return [];
      }
    },

    checkout: async (name) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.checkout", () => invoke("git_checkout", { root, name }));
    },

    checkoutTracking: async (name) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.checkout", () => invoke("git_checkout_tracking", { root, name }));
    },

    createBranch: async (name) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.branch", () => invoke("git_create_branch", { root, name }));
    },

    renameBranch: async (from, to) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.branch", () => invoke("git_rename_branch", { root, from, to }));
    },

    deleteBranch: async (name, force = false) => {
      const root = useWorkspace.getState().rootPath;
      if (!root) return "failed";
      set({ busy: true, lastError: null });
      try {
        await invoke("git_delete_branch", { root, name, force });
        return "deleted";
      } catch (err: unknown) {
        const message = String(err);
        // git's own wording; the panel turns it into an explicit "delete anyway"
        // rather than force-deleting behind the user's back.
        if (/not fully merged/i.test(message)) return "unmerged";
        set({ lastError: message });
        return "failed";
      } finally {
        set({ busy: false });
        await get().refresh();
      }
    },

    mergeBranch: async (name) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.merge", () => invoke("git_merge_branch", { root, name }));
    },

    fetch: async () => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.fetch", () => invoke("git_fetch", { root }));
    },

    listRemotes: async () => {
      const root = useWorkspace.getState().rootPath;
      if (!root) return [];
      try {
        return await invoke<GitRemote[]>("git_remotes", { root });
      } catch (err: unknown) {
        set({ lastError: String(err) });
        return [];
      }
    },

    setRemote: async (name, url) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.remote", () => invoke("git_set_remote", { root, name, url }));
    },

    listTags: async () => {
      const root = useWorkspace.getState().rootPath;
      if (!root) return [];
      try {
        return await invoke<string[]>("git_tags", { root });
      } catch (err: unknown) {
        set({ lastError: String(err) });
        return [];
      }
    },

    createTag: async (name, message) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.tag", () => invoke("git_create_tag", { root, name, message }));
    },

    deleteTag: async (name) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.tag", () => invoke("git_delete_tag", { root, name }));
    },

    pushTags: async () => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.pushTags", () => invoke("git_push_tags", { root }));
    },

    revertCommit: async (sha) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.revert", () => invoke("git_revert_commit", { root, sha }));
    },

    cherryPick: async (sha) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.cherryPick", () => invoke("git_cherry_pick", { root, sha }));
    },

    resetTo: async (sha, mode) => {
      const root = useWorkspace.getState().rootPath;
      if (root) await runOp(set, "git.busy.reset", () => invoke("git_reset_to", { root, sha, mode }));
    },

    reviewChanges: async () => {
      const root = useWorkspace.getState().rootPath;
      if (!root || get().reviewing) return;
      set({ reviewing: true, lastError: null, review: null });
      try {
        const diff = await pendingDiff(root);
        if (!diff) {
          set({ lastError: translate("git.clean") });
          return;
        }
        set({ review: parseReview(await aiOneshot(REVIEW_PROMPT + diff, root)) });
      } catch (err: unknown) {
        set({ lastError: formatProviderError(err) });
      } finally {
        set({ reviewing: false });
      }
    },

    dismissReview: () => {
      set({ review: null });
    },

    setCommitMessage: (message) => {
      set({ commitMessage: message });
    },

    generateCommitMessage: async () => {
      const root = useWorkspace.getState().rootPath;
      if (!root || get().generating) return;
      set({ generating: true, lastError: null });
      try {
        const diff = await pendingDiff(root);
        if (!diff) {
          set({ lastError: translate("git.nothingToDescribe") });
          return;
        }
        const message = await aiOneshot(COMMIT_MESSAGE_PROMPT + diff, root, true);
        set({ commitMessage: message });
      } catch (err: unknown) {
        set({ lastError: formatProviderError(err) });
      } finally {
        set({ generating: false });
      }
    },

    clear: () => {
      set({
        status: null,
        log: [],
        logLimit: LOG_PAGE,
        stashes: [],
        ignored: [],
        commitMessage: "",
        amend: false,
        busyLabel: null,
        lastError: null,
      });
    },
  };
});
