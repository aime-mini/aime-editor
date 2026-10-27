import { Bug, Files, GitBranch, ListChecks, PanelLeft, Workflow, type LucideIcon } from "lucide-react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { changedFileCount, hasConflicts, useGit } from "../stores/git";
import { SIDEBAR_VIEWS, useLayout, type SidebarView } from "../stores/layout";
import { useWorkspace } from "../stores/workspace";
import { DebugPanel } from "./DebugPanel";
import { FileTree } from "./FileTree";
import { FlowsPanel } from "./flows/FlowsPanel";
import { GitPanel } from "./GitPanel";
import { WorkItemsPanel } from "./WorkItemsPanel";

const VIEWS: Record<SidebarView, React.ComponentType> = {
  files: FileTree,
  git: GitPanel,
  workItems: WorkItemsPanel,
  flows: FlowsPanel,
  debug: DebugPanel,
};

/** Each view's icon and name, shared by the tab strip and the folded rail. */
const TABS: Record<SidebarView, { icon: LucideIcon; title: TranslationKey }> = {
  files: { icon: Files, title: "sidebar.files" },
  git: { icon: GitBranch, title: "sidebar.git" },
  workItems: { icon: ListChecks, title: "sidebar.workItems" },
  flows: { icon: Workflow, title: "sidebar.flows" },
  debug: { icon: Bug, title: "sidebar.debug" },
};

/**
 * How large a count is written out before it becomes "99+". Past that the exact
 * number stops being information and starts being a wider tab.
 */
const BADGE_LIMIT = 99;

/**
 * The git tab's badge. The whole point of it: whether this repository has
 * anything uncommitted is a question the tab can answer, and until it did the
 * only way to ask was to leave the tab you were on.
 *
 * Subscribed to narrowly: the tabs re-render on every git refresh, and a
 * repository with two thousand changed files must cost them one number. Every
 * repository's, like VS Code's badge: the tab is for all of them.
 */
function useGitBadge(): Badge | undefined {
  const t = useT();
  const changed = useGit(changedFileCount);
  const conflicted = useGit(hasConflicts);
  if (changed === 0) return undefined;
  return {
    count: changed,
    urgent: conflicted,
    title: conflicted
      ? t("sidebar.gitConflicts", { count: changed })
      : t("sidebar.gitChanges", { count: changed }),
  };
}

/**
 * Picks a view. Flows is a page rather than a list: its tab
 * opens the page, which takes the width the canvas needs.
 */
function showView(view: SidebarView) {
  useLayout.getState().setSidebarView(view);
  if (view === "flows") useWorkspace.getState().openFlows();
}

/** Left sidebar: Explorer / Git / Work items / Flows / Debug behind a compact tab strip. */
export function Sidebar() {
  const sidebarView = useLayout((s) => s.sidebarView);
  const gitBadge = useGitBadge();
  const t = useT();
  const View = VIEWS[sidebarView];

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex border-b border-line">
        {SIDEBAR_VIEWS.map((view) => {
          const { icon: Icon, title } = TABS[view];
          const badge = view === "git" ? gitBadge : undefined;
          return (
            <button
              key={view}
              onClick={() => {
                showView(view);
              }}
              // The tab's own name, unchanged by what it is carrying: the badge explains
              // itself on hover, and the tab stays the handle it has always been.
              title={t(title)}
              className={`relative flex flex-1 items-center justify-center gap-1.5 border-b-2 py-1.5 text-[11px] ${
                sidebarView === view
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-fg"
              }`}
            >
              <Icon size={14} />
              {badge !== undefined && <Count badge={badge} />}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        <View />
      </div>
    </div>
  );
}

/**
 * The sidebar folded: its views as a column of icons, the way the flows page
 * was designed to sit beside it. A view's icon opens the sidebar on it; the
 * flows icon opens the flows page and is lit while that page is in front.
 */
export function SidebarRail() {
  const flowsOpen = useWorkspace((s) => s.flowsOpen);
  const gitBadge = useGitBadge();
  const t = useT();
  const item = "relative flex size-8 items-center justify-center rounded-md";
  return (
    <nav className="flex h-full flex-col items-center gap-1 bg-panel pt-1.5" data-sidebar-rail>
      {SIDEBAR_VIEWS.map((view) => {
        const { icon: Icon, title } = TABS[view];
        const lit = view === "flows" && flowsOpen;
        const badge = view === "git" ? gitBadge : undefined;
        return (
          <button
            key={view}
            onClick={() => {
              showView(view);
            }}
            title={t(title)}
            className={`${item} ${
              lit
                ? "bg-elevated text-fg shadow-[inset_2px_0_0_var(--accent)]"
                : "text-muted hover:bg-elevated hover:text-fg"
            }`}
          >
            <Icon size={16} />
            {badge !== undefined && <Count badge={badge} />}
          </button>
        );
      })}
      <span className="flex-1" />
      <button
        onClick={() => {
          useLayout.getState().setSidebarVisible(true);
        }}
        title={t("layout.toggleSidebar")}
        className={`${item} mb-1.5 text-muted hover:bg-elevated hover:text-accent`}
      >
        <PanelLeft size={15} />
      </button>
    </nav>
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
