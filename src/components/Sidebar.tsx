import { Bug, Files, GitBranch, ListChecks } from "lucide-react";
import { useT } from "../i18n";
import { useGit } from "../stores/git";
import { useLayout, type SidebarView } from "../stores/layout";
import { DebugPanel } from "./DebugPanel";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { WorkItemsPanel } from "./WorkItemsPanel";

const VIEWS: Record<SidebarView, React.ComponentType> = {
  files: FileTree,
  git: GitPanel,
  workItems: WorkItemsPanel,
  debug: DebugPanel,
};

/**
 * How large a count is written out before it becomes "99+". Past that the exact
 * number stops being information and starts being a wider tab.
 */
const BADGE_LIMIT = 99;

/** Left sidebar: Explorer / Git / Work items / Debug behind a compact tab strip. */
export function Sidebar() {
  const { sidebarView, setSidebarView } = useLayout();
  const t = useT();
  // Subscribed to narrowly: this strip re-renders on every git refresh, and a
  // repository with two thousand changed files must cost it one number.
  const changed = useGit((s) => s.status?.files.length ?? 0);
  const conflicted = useGit((s) => s.status?.files.some((file) => file.conflicted) ?? false);

  const tab = (view: SidebarView, icon: React.ReactNode, title: string, badge?: Badge) => (
    <button
      onClick={() => {
        setSidebarView(view);
      }}
      // The tab's own name, unchanged by what it is carrying: the badge explains
      // itself on hover, and the tab stays the handle it has always been.
      title={title}
      className={`relative flex flex-1 items-center justify-center gap-1.5 border-b-2 py-1.5 text-[11px] ${
        sidebarView === view ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {icon}
      {badge !== undefined && <Count badge={badge} />}
    </button>
  );

  const View = VIEWS[sidebarView];

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex border-b border-line">
        {tab("files", <Files size={14} />, t("sidebar.files"))}
        {tab(
          "git",
          <GitBranch size={14} />,
          t("sidebar.git"),
          // The whole point of the badge: whether this repository has anything
          // uncommitted is a question the tab strip can answer, and until now the
          // only way to ask it was to leave the tab you were on.
          changed > 0
            ? {
                count: changed,
                urgent: conflicted,
                title: conflicted
                  ? t("sidebar.gitConflicts", { count: changed })
                  : t("sidebar.gitChanges", { count: changed }),
              }
            : undefined,
        )}
        {tab("workItems", <ListChecks size={14} />, t("sidebar.workItems"))}
        {tab("debug", <Bug size={14} />, t("sidebar.debug"))}
      </div>
      <div className="min-h-0 flex-1">
        <View />
      </div>
    </div>
  );
}

/** What a tab has to say about itself without being opened. */
interface Badge {
  count: number;
  /** Something is wrong rather than merely waiting - a conflict, here. */
  urgent: boolean;
  /** Said in words for the tooltip, because a number alone is not a sentence. */
  title: string;
}

/**
 * The count, sitting on the icon's shoulder.
 *
 * Absolutely positioned so the icon never moves: a tab strip that shifts when a
 * file changes is a tab strip you misclick. It carries the sentence a number
 * cannot say, and a click on it still reaches the tab underneath.
 */
function Count({ badge }: { badge: Badge }) {
  return (
    <span
      title={badge.title}
      className={`absolute top-0.5 right-1 min-w-[14px] rounded-full px-1 text-[9px] leading-[14px] font-medium tabular-nums ${
        badge.urgent ? "bg-danger text-bg" : "bg-accent text-bg"
      }`}
    >
      {badge.count > BADGE_LIMIT ? `${String(BADGE_LIMIT)}+` : badge.count}
    </span>
  );
}
