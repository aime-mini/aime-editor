import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  History,
  Loader2,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import { useAi } from "../stores/ai";
import {
  isStaged,
  isUnstaged,
  useGit,
  type GitBranch as GitBranchInfo,
  type GitFile,
  type ResetMode,
} from "../stores/git";
import { useWorkspace } from "../stores/workspace";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { PromptModal } from "./PromptModal";

/**
 * Confirmations and prompts this panel can raise. Modelled as a union so a
 * dialog cannot exist without the data it acts on - "delete which branch?" is
 * unrepresentable.
 */
type GitDialog =
  | { kind: "renameBranch"; from: string }
  | { kind: "deleteBranch"; name: string; force: boolean }
  | { kind: "mergeBranch"; name: string; into: string }
  | { kind: "createTag" }
  | { kind: "tagMessage"; name: string }
  | { kind: "deleteTag"; name: string }
  | { kind: "setRemote"; name: string; url: string }
  | { kind: "revert"; sha: string; short: string }
  | { kind: "cherryPick"; sha: string; short: string }
  | { kind: "reset"; sha: string; short: string; mode: ResetMode };

/**
 * What the AI thinks of the changes, shown above the commit box.
 *
 * It is an opinion, not a gate: nothing is blocked, the panel can be dismissed,
 * and each finding jumps to the file it is about. Findings the AI could not
 * place on a line still appear, because "this file needs tests" is useful even
 * without a line number.
 */
function ReviewPanel() {
  const review = useGit((s) => s.review);
  const dismissReview = useGit((s) => s.dismissReview);
  const rootPath = useWorkspace((s) => s.rootPath);
  const openFile = useWorkspace((s) => s.openFile);
  const t = useT();
  if (!review) return null;

  const issues = review.findings.filter((finding) => finding.severity === "issue");

  return (
    <div className="rounded-lg border border-line bg-elevated/60 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <Sparkles size={11} className="shrink-0 text-accent" />
        <span className="flex-1 font-medium">
          {review.findings.length === 0
            ? t("git.reviewClean")
            : t("git.reviewSummary", {
                issues: String(issues.length),
                total: String(review.findings.length),
              })}
        </span>
        <button onClick={dismissReview} className="rounded p-0.5 text-muted hover:text-fg">
          <X size={11} />
        </button>
      </div>

      {review.findings.length === 0 && review.text && review.text !== "[]" && (
        <p className="mt-1 text-[11px] whitespace-pre-wrap text-muted">{review.text}</p>
      )}

      <div className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {review.findings.map((finding, index) => (
          <button
            key={index}
            onClick={() => {
              if (rootPath && finding.file) void openFile(`${rootPath}/${finding.file}`);
            }}
            className="flex items-start gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-elevated"
          >
            <span className={finding.severity === "issue" ? "text-danger" : "text-muted"}>
              {finding.severity === "issue" ? "!" : "\u00b7"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-muted">
                {finding.file}
                {finding.line > 0 && `:${String(finding.line)}`}
              </span>{" "}
              {finding.message}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Status letter with VS Code-ish coloring. */
function StatusLetter({ file, staged }: { file: GitFile; staged: boolean }) {
  const letter = staged ? file.staged : file.unstaged === "?" ? "U" : file.unstaged;
  const color = file.conflicted
    ? "text-danger"
    : letter === "D"
      ? "text-danger"
      : letter === "U" || letter === "A"
        ? "text-ok"
        : "text-accent";
  return <span className={`w-3 shrink-0 text-center font-mono text-[11px] ${color}`}>{letter}</span>;
}

function FileRow({
  file,
  staged,
  selected,
  onRowClick,
  onRowContextMenu,
}: {
  file: GitFile;
  staged: boolean;
  selected: boolean;
  onRowClick: (e: React.MouseEvent, file: GitFile, staged: boolean) => void;
  onRowContextMenu: (e: React.MouseEvent, file: GitFile, staged: boolean) => void;
}) {
  const { stage, unstage, discard } = useGit();
  const t = useT();
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        onRowContextMenu(e, file, staged);
      }}
      className={`group flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-elevated ${
        selected ? "bg-accent-soft" : ""
      }`}
    >
      <StatusLetter file={file} staged={staged} />
      <button
        onClick={(e) => {
          onRowClick(e, file, staged);
        }}
        className="min-w-0 flex-1 truncate text-left"
        title={file.path}
      >
        {file.path.split("/").pop()}
        <span className="ml-1.5 text-[11px] text-muted">{file.path}</span>
      </button>
      {!staged && (
        <button
          onClick={() => void discard(file)}
          title={t("git.discard")}
          className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-danger"
        >
          <Undo2 size={12} />
        </button>
      )}
      <button
        onClick={() => (staged ? void unstage([file.path]) : void stage([file.path]))}
        title={staged ? t("git.unstage") : t("git.stage")}
        className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-accent"
      >
        {staged ? <Minus size={12} /> : <Plus size={12} />}
      </button>
    </div>
  );
}

export function GitPanel() {
  const git = useGit();
  const providerHealth = useAi((s) => s.providerHealth);
  const openDiff = useWorkspace((s) => s.openDiff);
  const openCommit = useWorkspace((s) => s.openCommit);
  const openConflict = useWorkspace((s) => s.openConflict);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [newBranchModal, setNewBranchModal] = useState(false);
  /**
   * Every confirm/prompt this panel can raise. One state instead of ten flags:
   * only one dialog is ever open, and each carries exactly what it acts on.
   */
  const [dialog, setDialog] = useState<GitDialog | null>(null);
  const [stashModal, setStashModal] = useState(false);
  // History has its own scroll area so a long log never shrinks the panel scrollbar.
  const [historyOpen, setHistoryOpen] = useState(true);
  // Multi-select over change rows: keys are "s:path" / "u:path" per section.
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<{ staged: boolean; index: number } | null>(null);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const t = useT();

  const keyOf = (file: GitFile, staged: boolean) => `${staged ? "s" : "u"}:${file.path}`;

  const handleRowClick = (
    e: React.MouseEvent,
    file: GitFile,
    staged: boolean,
    list: GitFile[],
    index: number,
  ) => {
    if (e.shiftKey && anchor && anchor.staged === staged) {
      const [from, to] = [Math.min(anchor.index, index), Math.max(anchor.index, index)];
      setSelection(new Set(list.slice(from, to + 1).map((f) => keyOf(f, staged))));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      const key = keyOf(file, staged);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelection(next);
      setAnchor({ staged, index });
      return;
    }
    setSelection(new Set([keyOf(file, staged)]));
    setAnchor({ staged, index });
    openDiff(file.path);
  };

  const handleRowContextMenu = (e: React.MouseEvent, file: GitFile, staged: boolean, list: GitFile[]) => {
    // Right-clicking outside the current selection retargets it to that row.
    let active = selection;
    if (!selection.has(keyOf(file, staged))) {
      active = new Set([keyOf(file, staged)]);
      setSelection(active);
    }
    const files = list.filter((f) => active.has(keyOf(f, staged)));
    const n = files.length;
    const items: MenuItem[] = [];
    if (n === 1) {
      items.push({
        label: t("git.openDiff"),
        onClick: () => {
          openDiff(files[0].path);
        },
      });
    }
    if (staged) {
      items.push({
        label: t("git.unstageSelected", { n }),
        onClick: () => void git.unstage(files.map((f) => f.path)),
      });
    } else {
      items.push(
        {
          label: t("git.stageSelected", { n }),
          onClick: () => void git.stage(files.map((f) => f.path)),
        },
        {
          label: t("git.discardSelected", { n }),
          danger: true,
          onClick: () => void git.discardMany(files),
        },
      );
    }
    setFileMenu({ x: e.clientX, y: e.clientY, items });
  };

  const showBranchMenu = async (x: number, y: number) => {
    const branches = await git.listBranches();
    const items: MenuItem[] = branches.map((branch) => ({
      label: branch.name,
      icon: branch.current ? (
        <Check size={13} className="text-accent" />
      ) : (
        <span className="inline-block w-[13px]" />
      ),
      onClick: () => {
        if (!branch.current) void git.checkout(branch.name);
      },
    }));
    const others = branches.filter((branch) => !branch.current);
    // git names the checked-out branch itself; the status is only a fallback
    // for the moment right after a checkout, before it is re-read.
    const current = branches.find((branch) => branch.current)?.name ?? git.status?.branch ?? "";
    items.push(
      {
        label: t("git.newBranch"),
        icon: <GitBranchPlus size={13} />,
        onClick: () => {
          setNewBranchModal(true);
        },
      },
      {
        label: t("git.renameBranch"),
        icon: <Pencil size={13} />,
        onClick: () => {
          if (current) setDialog({ kind: "renameBranch", from: current });
        },
      },
      {
        label: t("git.mergeBranch"),
        icon: <GitMerge size={13} />,
        onClick: () => {
          pickBranch(x, y, others, (name) => {
            setDialog({ kind: "mergeBranch", name, into: current });
          });
        },
      },
      {
        label: t("git.deleteBranch"),
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          // The current branch is absent from the list on purpose: git cannot
          // delete the branch you are standing on.
          pickBranch(x, y, others, (name) => {
            setDialog({ kind: "deleteBranch", name, force: false });
          });
        },
      },
    );
    setBranchMenu({ x, y, items });
  };

  const closeDialog = () => {
    setDialog(null);
  };

  /** Second-level menu for actions that need another branch as their target. */
  const pickBranch = (x: number, y: number, branches: GitBranchInfo[], onPick: (name: string) => void) => {
    setBranchMenu({
      x,
      y,
      items:
        branches.length === 0
          ? [{ label: t("git.noOtherBranches"), onClick: () => undefined }]
          : branches.map((branch) => ({
              label: branch.name,
              icon: <GitBranch size={13} />,
              onClick: () => {
                onPick(branch.name);
              },
            })),
    });
  };

  /** Remotes and tags - the last reasons a user would open another Git app. */
  const showRepoMenu = (x: number, y: number) => {
    setBranchMenu({
      x,
      y,
      items: [
        {
          label: t("git.remotes"),
          icon: <Cloud size={13} />,
          onClick: () => {
            void git.listRemotes().then((remotes) => {
              setBranchMenu({
                x,
                y,
                items: [
                  ...remotes.map((remote) => ({
                    label: `${remote.name} - ${remote.url}`,
                    icon: <Pencil size={13} />,
                    onClick: () => {
                      setDialog({ kind: "setRemote", name: remote.name, url: remote.url });
                    },
                  })),
                  {
                    label: t("git.addRemote"),
                    icon: <Plus size={13} />,
                    onClick: () => {
                      setDialog({ kind: "setRemote", name: "origin", url: "" });
                    },
                  },
                ],
              });
            });
          },
        },
        {
          label: t("git.newTag"),
          icon: <Tag size={13} />,
          onClick: () => {
            setDialog({ kind: "createTag" });
          },
        },
        {
          label: t("git.tags"),
          icon: <Tag size={13} />,
          onClick: () => {
            void git.listTags().then((tags) => {
              setBranchMenu({
                x,
                y,
                items:
                  tags.length === 0
                    ? [{ label: t("git.noTags"), onClick: () => undefined }]
                    : tags.map((tag) => ({
                        label: tag,
                        icon: <Trash2 size={13} />,
                        danger: true,
                        onClick: () => {
                          setDialog({ kind: "deleteTag", name: tag });
                        },
                      })),
              });
            });
          },
        },
        {
          label: t("git.pushTags"),
          icon: <ArrowUp size={13} />,
          onClick: () => void git.pushTags(),
        },
      ],
    });
  };

  /** Right-click on a commit: the operations that act on history itself. */
  const showCommitMenu = (x: number, y: number, sha: string, short: string) => {
    setBranchMenu({
      x,
      y,
      items: [
        {
          label: t("git.copySha"),
          icon: <Copy size={13} />,
          onClick: () => void navigator.clipboard.writeText(sha),
        },
        {
          label: t("git.revertCommit"),
          icon: <Undo2 size={13} />,
          onClick: () => {
            setDialog({ kind: "revert", sha, short });
          },
        },
        {
          label: t("git.cherryPick"),
          icon: <GitMerge size={13} />,
          onClick: () => {
            setDialog({ kind: "cherryPick", sha, short });
          },
        },
        {
          label: t("git.resetSoft"),
          icon: <History size={13} />,
          onClick: () => {
            setDialog({ kind: "reset", sha, short, mode: "soft" });
          },
        },
        {
          label: t("git.resetMixed"),
          icon: <History size={13} />,
          onClick: () => {
            setDialog({ kind: "reset", sha, short, mode: "mixed" });
          },
        },
        {
          label: t("git.resetHard"),
          icon: <TriangleAlert size={13} />,
          danger: true,
          onClick: () => {
            setDialog({ kind: "reset", sha, short, mode: "hard" });
          },
        },
      ],
    });
  };

  useEffect(() => {
    void git.refresh();
    // Re-read when the window regains focus — commits from outside (terminal) show up.
    const onFocus = () => void useGit.getState().refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = git.status;
  if (!status) return null;

  if (!status.is_repo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <GitBranch size={20} className="text-muted" />
        <p className="text-muted">{t("git.notRepo")}</p>
        <button
          onClick={() => void git.init()}
          className="rounded-lg border border-line px-3 py-1.5 text-muted hover:border-accent hover:text-fg"
        >
          {t("git.initRepo")}
        </button>
      </div>
    );
  }

  const conflictedFiles = status.files.filter((f) => f.conflicted);
  const stagedFiles = status.files.filter((f) => !f.conflicted && isStaged(f));
  const unstagedFiles = status.files.filter((f) => !f.conflicted && isUnstaged(f));
  const canUseAi = providerHealth === "ok"; // AI-optional: the button simply disappears without a CLI

  return (
    <div className="flex h-full flex-col gap-2 p-2 select-none">
      {/* Everything above History scrolls on its own; History gets the rest. */}
      <div className="flex min-h-0 shrink flex-col gap-2 overflow-y-auto">
        <div className="flex items-center gap-1.5 px-1 text-xs">
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              void showBranchMenu(rect.left, rect.bottom + 4);
            }}
            title={t("git.switchBranch")}
            className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-elevated"
          >
            <GitBranch size={13} className="shrink-0 text-accent" />
            <span className="truncate font-semibold">{status.branch ?? "?"}</span>
            <ChevronDown size={10} className="shrink-0 opacity-60" />
          </button>
          {status.ahead > 0 && (
            <span className="flex items-center text-muted">
              {status.ahead}
              <ArrowUp size={11} />
            </span>
          )}
          {status.behind > 0 && (
            <span className="flex items-center text-muted">
              {status.behind}
              <ArrowDown size={11} />
            </span>
          )}
          <span className="flex-1" />
          <button
            onClick={() => void git.fetch()}
            title={t("git.fetch")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <ArrowDownToLine size={12} />
          </button>
          <button
            onClick={() => void git.pull()}
            title={t("git.pull")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <ArrowDown size={12} />
          </button>
          <button
            onClick={() => void git.push()}
            title={t("git.push")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <ArrowUp size={12} />
          </button>
          <button
            onClick={() => void git.refresh()}
            title={t("git.refresh")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              showRepoMenu(rect.right, rect.bottom + 4);
            }}
            title={t("git.repoMenu")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <MoreHorizontal size={12} />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <ReviewPanel />
          <div className="relative">
            <textarea
              value={git.commitMessage}
              onChange={(e) => {
                git.setCommitMessage(e.target.value);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void git.commit();
                }
              }}
              placeholder={t("git.commitPlaceholder")}
              rows={3}
              className="w-full resize-none rounded-lg border border-line bg-elevated px-2 py-1.5 outline-none placeholder:text-muted focus:border-accent"
            />
            {canUseAi && (
              <button
                onClick={() => void git.generateCommitMessage()}
                disabled={git.generating}
                title={t("git.aiMessage")}
                className="absolute right-1.5 bottom-2.5 rounded p-1 text-accent hover:bg-panel disabled:opacity-50"
              >
                {git.generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canUseAi && (
              <button
                onClick={() => void git.reviewChanges()}
                disabled={git.reviewing || git.busy}
                title={t("git.reviewHint")}
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-muted hover:border-accent hover:text-fg disabled:opacity-50"
              >
                {git.reviewing ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                {t("git.review")}
              </button>
            )}
            <button
              onClick={() => void git.commit()}
              disabled={
                git.busy || (git.amend ? false : !git.commitMessage.trim() || status.files.length === 0)
              }
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              <Check size={13} /> {git.amend ? t("git.amendCommit") : t("git.commit")}
            </button>
            <label
              className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted"
              title={t("git.amendHint")}
            >
              <input
                type="checkbox"
                checked={git.amend}
                onChange={(e) => {
                  git.setAmend(e.target.checked);
                }}
                className="accent-(--accent)"
              />
              {t("git.amend")}
            </label>
          </div>
        </div>

        {git.lastError && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-[12px] break-words text-danger">
            {git.lastError}
          </div>
        )}

        {conflictedFiles.length > 0 && (
          <section>
            <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold tracking-wider text-danger uppercase">
              <TriangleAlert size={11} /> {t("git.conflicts")} ({conflictedFiles.length})
            </div>
            {conflictedFiles.map((f) => (
              <div
                key={`x-${f.path}`}
                className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-elevated"
              >
                <span className="w-3 shrink-0 text-center font-mono text-[11px] text-danger">!</span>
                <button
                  onClick={() => {
                    openConflict(f.path);
                  }}
                  className="min-w-0 flex-1 truncate text-left"
                  title={f.path}
                >
                  {f.path.split("/").pop()}
                  <span className="ml-1.5 text-[11px] text-muted">{f.path}</span>
                </button>
                <button
                  onClick={() => {
                    openConflict(f.path);
                  }}
                  className="shrink-0 rounded border border-danger/50 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10"
                >
                  {t("git.resolve")}
                </button>
              </div>
            ))}
          </section>
        )}

        {stagedFiles.length > 0 && (
          <section>
            <div className="flex items-center justify-between px-1 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
              {t("git.staged")} ({stagedFiles.length})
              <button
                onClick={() => void git.unstage(stagedFiles.map((f) => f.path))}
                title={t("git.unstage")}
                className="rounded p-0.5 hover:bg-elevated hover:text-fg"
              >
                <Minus size={12} />
              </button>
            </div>
            {stagedFiles.map((f, index) => (
              <FileRow
                key={`s-${f.path}`}
                file={f}
                staged
                selected={selection.has(keyOf(f, true))}
                onRowClick={(e, file) => {
                  handleRowClick(e, file, true, stagedFiles, index);
                }}
                onRowContextMenu={(e, file) => {
                  handleRowContextMenu(e, file, true, stagedFiles);
                }}
              />
            ))}
          </section>
        )}

        <section>
          <div className="flex items-center justify-between px-1 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
            {t("git.changes")} ({unstagedFiles.length})
            <span className="flex items-center gap-0.5">
              {status.files.length > 0 && (
                <button
                  onClick={() => {
                    setStashModal(true);
                  }}
                  title={t("git.stashSave")}
                  className="rounded p-0.5 hover:bg-elevated hover:text-fg"
                >
                  <Archive size={12} />
                </button>
              )}
              {unstagedFiles.length > 0 && (
                <button
                  onClick={() => void git.stage(unstagedFiles.map((f) => f.path))}
                  title={t("git.stage")}
                  className="rounded p-0.5 hover:bg-elevated hover:text-fg"
                >
                  <Plus size={12} />
                </button>
              )}
            </span>
          </div>
          {unstagedFiles.length === 0 && stagedFiles.length === 0 && (
            <p className="px-1 py-2 text-muted">{t("git.clean")}</p>
          )}
          {unstagedFiles.map((f, index) => (
            <FileRow
              key={`u-${f.path}`}
              file={f}
              staged={false}
              selected={selection.has(keyOf(f, false))}
              onRowClick={(e, file) => {
                handleRowClick(e, file, false, unstagedFiles, index);
              }}
              onRowContextMenu={(e, file) => {
                handleRowContextMenu(e, file, false, unstagedFiles);
              }}
            />
          ))}
        </section>

        {git.stashes.length > 0 && (
          <section>
            <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
              <Archive size={11} /> {t("git.stash")} ({git.stashes.length})
            </div>
            {git.stashes.map((stash) => (
              <div
                key={stash.index}
                className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-elevated"
              >
                <span className="shrink-0 font-mono text-[10px] text-muted">{`{${String(stash.index)}}`}</span>
                <span className="min-w-0 flex-1 truncate" title={stash.message}>
                  {stash.message}
                </span>
                <button
                  onClick={() => void git.stashPop(stash.index)}
                  title={t("git.stashPop")}
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-accent"
                >
                  <ArchiveRestore size={12} />
                </button>
                <button
                  onClick={() => void git.stashApply(stash.index)}
                  title={t("git.stashApply")}
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-ok"
                >
                  <Plus size={12} />
                </button>
                <button
                  onClick={() => void git.stashDrop(stash.index)}
                  title={t("git.stashDrop")}
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </section>
        )}
      </div>

      <section className={historyOpen ? "flex min-h-0 flex-1 flex-col" : ""}>
        <button
          onClick={() => {
            setHistoryOpen(!historyOpen);
          }}
          className="flex w-full shrink-0 items-center gap-1.5 rounded px-1 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-fg"
        >
          {historyOpen ? <ChevronDown size={11} /> : <History size={11} />}
          {t("git.history")} ({git.log.length}
          {git.log.length >= git.logLimit ? "+" : ""})
        </button>
        {historyOpen && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {git.log.length === 0 && <p className="px-1 py-1 text-muted">{t("git.noCommits")}</p>}
            {git.log.map((commit) => (
              <button
                key={commit.hash}
                onClick={() => {
                  openCommit(commit.hash);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showCommitMenu(e.clientX, e.clientY, commit.hash, commit.short);
                }}
                title={`${commit.subject} - ${commit.author}, ${commit.when}`}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-elevated"
              >
                <span className="shrink-0 font-mono text-[10px] text-accent">{commit.short}</span>
                <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                <span className="shrink-0 text-[10px] text-muted">{commit.when}</span>
              </button>
            ))}
            {git.log.length >= git.logLimit && (
              <button
                onClick={() => void git.loadMoreLog()}
                className="my-1 w-full rounded border border-dashed border-line py-0.5 text-center text-[11px] text-muted hover:border-accent hover:text-fg"
              >
                {t("git.loadMore")}
              </button>
            )}
          </div>
        )}
      </section>

      {branchMenu && (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          items={branchMenu.items}
          onClose={() => {
            setBranchMenu(null);
          }}
        />
      )}
      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          items={fileMenu.items}
          onClose={() => {
            setFileMenu(null);
          }}
        />
      )}
      {newBranchModal && (
        <PromptModal
          title={t("modal.newBranchTitle")}
          initialValue=""
          onSubmit={(name) => {
            if (name.trim()) void git.createBranch(name.trim());
            setNewBranchModal(false);
          }}
          onClose={() => {
            setNewBranchModal(false);
          }}
        />
      )}
      {dialog?.kind === "renameBranch" && (
        <PromptModal
          title={t("modal.renameBranchTitle", { name: dialog.from })}
          initialValue={dialog.from}
          onSubmit={(name) => {
            if (name && name !== dialog.from) void git.renameBranch(dialog.from, name);
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "deleteBranch" && (
        <PromptModal
          title={
            dialog.force
              ? t("modal.deleteBranchForceTitle", { name: dialog.name })
              : t("modal.deleteBranchTitle", { name: dialog.name })
          }
          hint={dialog.force ? t("modal.deleteBranchForceHint") : t("modal.deleteBranchHint")}
          danger
          onSubmit={() => {
            // git refuses to drop unmerged work; that refusal becomes a second,
            // explicit question instead of a silent force-delete.
            void git.deleteBranch(dialog.name, dialog.force).then((result) => {
              setDialog(
                result === "unmerged" ? { kind: "deleteBranch", name: dialog.name, force: true } : null,
              );
            });
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "mergeBranch" && (
        <PromptModal
          title={t("modal.mergeBranchTitle", { name: dialog.name, into: dialog.into })}
          hint={t("modal.mergeBranchHint")}
          onSubmit={() => {
            void git.mergeBranch(dialog.name);
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "createTag" && (
        <PromptModal
          title={t("modal.newTagTitle")}
          initialValue=""
          onSubmit={(name) => {
            setDialog(name.trim() ? { kind: "tagMessage", name: name.trim() } : null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "tagMessage" && (
        <PromptModal
          title={t("modal.tagMessageTitle", { name: dialog.name })}
          hint={t("modal.tagMessageHint")}
          initialValue=""
          allowEmpty
          onSubmit={(message) => {
            void git.createTag(dialog.name, message);
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "deleteTag" && (
        <PromptModal
          title={t("modal.deleteTagTitle", { name: dialog.name })}
          danger
          onSubmit={() => {
            void git.deleteTag(dialog.name);
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "setRemote" && (
        <PromptModal
          title={t("modal.remoteUrlTitle", { name: dialog.name })}
          hint={t("modal.remoteUrlHint")}
          initialValue={dialog.url}
          onSubmit={(url) => {
            if (url.trim()) void git.setRemote(dialog.name, url.trim());
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "revert" && (
        <PromptModal
          title={t("modal.revertTitle", { sha: dialog.short })}
          hint={t("modal.revertHint")}
          onSubmit={() => {
            void git.revertCommit(dialog.sha);
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "cherryPick" && (
        <PromptModal
          title={t("modal.cherryPickTitle", { sha: dialog.short })}
          hint={t("modal.cherryPickHint")}
          onSubmit={() => {
            void git.cherryPick(dialog.sha);
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "reset" && (
        <PromptModal
          title={t("modal.resetTitle", { sha: dialog.short })}
          hint={t(`modal.resetHint.${dialog.mode}`)}
          danger={dialog.mode === "hard"}
          onSubmit={() => {
            void git.resetTo(dialog.sha, dialog.mode);
            setDialog(null);
          }}
          onClose={closeDialog}
        />
      )}
      {stashModal && (
        <PromptModal
          title={t("modal.stashTitle")}
          hint={t("modal.stashHint")}
          initialValue=""
          allowEmpty
          onSubmit={(message) => {
            void git.stashPush(message.trim());
            setStashModal(false);
          }}
          onClose={() => {
            setStashModal(false);
          }}
        />
      )}
    </div>
  );
}
