import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Plug,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Unlink,
  Unplug,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { fillTemplate, type Fields } from "../lib/trackerForm";
import {
  autoGroupBy,
  branchNameFor,
  firstOfAll,
  foldedByDefault,
  groupChoices,
  groupForWorkspace,
  groupItems,
  itemOnBranch,
  leadWith,
  matchesQuery,
  namesInRemote,
  readableId,
  typesVary,
  NO_HINTS,
  type Group,
  type GroupBy,
  type WorkspaceHints,
} from "../lib/workItems";
import { useBoardView } from "../stores/boardView";
import { useGit } from "../stores/git";
import { useRun } from "../stores/run";
import { useTrackers, type StateCategory, type StateOption, type WorkItem } from "../stores/trackers";
import { useWorkspace } from "../stores/workspace";
import { ContextMenu, SEPARATOR, type MenuItem } from "./ContextMenu";
import { PromptModal } from "./PromptModal";
import { Waiting } from "./Waiting";

/**
 * The work assigned to whoever is sitting here, and the two moves that tie it to
 * the repository: start its branch, or hand it to the AI.
 *
 * Nothing here names a service. The connect form is built from what the Rust
 * connector declares it needs, and every row shows the service's own words for a
 * type and a state - only the grouping and the colours are Aime's, because
 * "in progress" is the one thing every tracker agrees on.
 *
 * The board belongs to the open project, so the panel has three states: this
 * project has one, this project has none but the machine does (pick one), or
 * there is nothing to pick yet (connect).
 *
 * What is worth knowing about the shape of it: a sidebar is narrow, and the
 * scarce thing is width, not height. So the title is the only thing allowed to
 * take room - everything else is one line of small print under it - and the
 * controls that are set once (how the list is filed, whether finished work
 * counts) live behind one button instead of standing in three rows above a list
 * they are shorter than.
 */
export function WorkItemsPanel() {
  const { connections, activeId, items, loading, ready, includeFinished, mineOnly, load } = useTrackers();
  const t = useT();
  /**
   * The connect form, opened for either of its two reasons: a stored token
   * stopped working (what expiry looks like), or this project is to be pointed
   * at a board the machine does not have yet.
   */
  const [connectFormOpen, setConnectFormOpen] = useState(false);
  /** Set while the disconnect confirmation is on screen. */
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  /** Which row has its state menu open; two open menus is two claims at once. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // How this reader is looking at the board. It lives outside the component
  // because the sidebar shows one view at a time: a glance at the file tree
  // unmounts this panel, and a filter that has to be typed again afterwards is
  // a filter nobody uses twice.
  const { filter, grouping, folded, expanded, setFilter, setGrouping, setFolded, expand } = useBoardView();
  /** Where an opened menu hangs, in window coordinates; null while none is. */
  const [actionsAt, setActionsAt] = useState<Point | null>(null);
  const [optionsAt, setOptionsAt] = useState<Point | null>(null);
  /** The item open in the editor area, so its row can say so. */
  const openItemId = useWorkspace((state) => state.workItemId);
  const rootPath = useWorkspace((state) => state.rootPath);
  /** What git can say about the open project; empty until it has been asked. */
  const [hints, setHints] = useState<WorkspaceHints>(NO_HINTS);
  /**
   * The branch that is checked out. Watched because it is how this panel's own
   * branch button reports back: starting a branch for an item is exactly the
   * moment that item's board becomes the one this project is about.
   */
  const branch = useGit((state) => state.status?.branch ?? null);

  // A board belongs to a project, and this panel survives the switch to the
  // next one - so opening another project has to read its board, not sit on an
  // empty list nobody asked to clear.
  useEffect(() => {
    void load();
  }, [load, rootPath]);

  // What this project is called, in the words of the repository itself. Asked
  // once per project and only while this panel is open, because it is worth two
  // git calls exactly to the reader looking at a board.
  useEffect(() => {
    let alive = true;
    const ask = async () => {
      if (rootPath === null) {
        setHints(NO_HINTS);
        return;
      }
      const folder = rootPath.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "";
      const [remotes, branches] = await Promise.all([
        useGit.getState().listRemotes(),
        useGit.getState().listBranches(),
      ]);
      if (!alive) return;
      setHints({
        names: [folder, ...remotes.flatMap((remote) => namesInRemote(remote.url))],
        branches: branches.map((one) => one.name),
        current: branches.find((one) => one.current)?.name ?? null,
      });
    };
    void ask();
    return () => {
      alive = false;
    };
  }, [rootPath, branch]);

  if (!ready) {
    // Which board this project uses is still being read; asking "connect one?"
    // in the meantime would be asking about a project we have not looked at.
    return (
      <div className="p-2">
        <Waiting label={t("tracker.loadingBoards")} />
      </div>
    );
  }

  const active = connections.find((connection) => connection.id === activeId) ?? null;
  if (connections.length === 0 || connectFormOpen) {
    return (
      <ConnectForm
        // Reconnecting is almost always a fresh token for the same project, so
        // the form starts from whatever that connection already knows.
        initial={active?.settings ?? {}}
        onConnected={() => {
          setConnectFormOpen(false);
        }}
      />
    );
  }
  if (active === null) {
    return (
      <BoardPicker
        onConnectAnother={() => {
          setConnectFormOpen(true);
        }}
      />
    );
  }

  // How the list is filed is decided by the whole board, not by what the filter
  // has left of it: a heading that moves while you are still typing is worse
  // than one that stays put.
  const choices = groupChoices(items);
  const by = grouping ?? autoGroupBy(items, hints);
  // The heading this repository is about leads, says so, and is the one left
  // open when there is enough behind the others to be worth folding. Nothing
  // recognisable means nothing moves: the panel does not rearrange on a hunch.
  const filed = groupItems(
    items.filter((item) => matchesQuery(item, filter)),
    by,
  );
  // Only a dimension can name a project: "In progress" is not a board, and the
  // thing an item belongs to is not one either.
  const mine = typeof by === "object" ? groupForWorkspace(filed, hints) : null;
  const groups = leadWith(filed, mine);
  const shut = folded ?? foldedByDefault(groups, mine, GROUP_LIMIT);
  // The item this repository is standing on, which is the one row the reader
  // should never have to look for.
  const onBranch = itemOnBranch(items, hints.current);
  const showType = typesVary(items);

  const boardActions: (MenuItem | typeof SEPARATOR)[] = [
    ...connections
      .filter((connection) => connection.id !== active.id)
      .map((connection) => ({
        label: t("tracker.useThisBoard", { name: connection.label }),
        onClick: () => void useTrackers.getState().setActive(connection.id),
      })),
    ...(connections.length > 1 ? [SEPARATOR] : []),
    {
      label: t("tracker.unbind"),
      icon: <Unlink size={13} />,
      onClick: () => void useTrackers.getState().unbind(),
    },
    {
      label: t("tracker.disconnect", { name: active.label }),
      icon: <Unplug size={13} />,
      danger: true,
      onClick: () => {
        setConfirmDisconnect(true);
      },
    },
  ];

  const viewOptions: (MenuItem | typeof SEPARATOR)[] = [
    ...choices.map((choice) => ({
      label: t("tracker.groupedBy", { name: groupName(choice, t) }),
      icon: <Ticked on={groupKey(choice) === groupKey(by)} />,
      onClick: () => {
        setGrouping(choice);
      },
    })),
    SEPARATOR,
    {
      label: t("tracker.includeFinished"),
      icon: <Ticked on={includeFinished} />,
      onClick: () => {
        useTrackers.getState().toggleFinished();
      },
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b border-line px-1.5 py-1">
        <p
          className="min-w-0 flex-1 truncate text-[11.5px] text-muted"
          title={t("tracker.boundTo", { name: active.label })}
        >
          {active.label}
        </p>
        <IconButton
          icon={loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          label={t("tracker.refresh")}
          onClick={() => void useTrackers.getState().refresh()}
        />
        <IconButton
          icon={<MoreHorizontal size={13} />}
          label={t("tracker.moreActions")}
          onClick={setActionsAt}
        />
      </div>

      <div className="space-y-1 px-1.5 py-1.5">
        {/* The filter is not a question for the service: it narrows what already
            arrived, which is why it answers as fast as it is typed. */}
        <div className="relative">
          <Search size={12} className="absolute top-1/2 left-2 -translate-y-1/2 text-muted" />
          <input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            placeholder={t("tracker.search")}
            spellCheck={false}
            className="w-full rounded border border-line bg-elevated py-1 pr-6 pl-7 text-[11.5px] text-fg outline-none focus:border-accent"
          />
          {filter !== "" && (
            <button
              onClick={() => {
                setFilter("");
              }}
              title={t("tracker.clearFilter")}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted hover:text-fg"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Whose work: a question for the service, so it costs a refresh. */}
          <div
            className="flex flex-1 rounded border border-line p-0.5 text-[11px]"
            title={t("tracker.scope")}
          >
            {[true, false].map((only) => (
              <button
                key={String(only)}
                onClick={() => {
                  useTrackers.getState().setMineOnly(only);
                }}
                className={`flex-1 rounded px-1 py-0.5 ${
                  mineOnly === only ? "bg-elevated text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {t(only ? "tracker.mine" : "tracker.everyone")}
              </button>
            ))}
          </div>
          <IconButton
            icon={<SlidersHorizontal size={13} />}
            label={t("tracker.viewOptions")}
            onClick={setOptionsAt}
          />
        </div>
      </div>

      <Problem
        onReconnect={() => {
          setConnectFormOpen(true);
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {/* An empty list while a request is out is not an empty board - and a
            spinner on the Refresh button alone is easy to miss while looking at
            the list itself. */}
        {loading && items.length === 0 ? (
          <div className="px-1 py-2">
            <Waiting label={t("tracker.loadingItems")} />
          </div>
        ) : (
          groups.length === 0 && (
            <p className="px-1 py-2 text-[11.5px] text-muted">
              {filter.trim() !== ""
                ? t("tracker.searchEmpty", { query: filter.trim() })
                : t(mineOnly ? "tracker.empty" : "tracker.emptyBoard")}
            </p>
          )
        )}
        {groups.map((group) => {
          const closed = shut.includes(group.key);
          const ordered = firstOfAll(group.items, onBranch);
          const visible = expanded.includes(group.key) ? ordered : ordered.slice(0, GROUP_LIMIT);
          const hidden = ordered.length - visible.length;
          return (
            <section key={group.key}>
              {/* A heading that folds: one group of forty is what makes a panel
                  unreadable, and the count says what is behind it. */}
              <button
                onClick={() => {
                  // The first fold by hand also freezes what the panel chose, so
                  // one click never rearranges the other headings.
                  setFolded(closed ? shut.filter((one) => one !== group.key) : [...shut, group.key]);
                }}
                className="flex w-full items-center gap-1 px-1 pt-3 pb-1 text-[10.5px] tracking-wide text-muted uppercase hover:text-fg"
              >
                {closed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                <span className="min-w-0 flex-1 truncate text-left" title={headingOf(group, t)}>
                  {headingOf(group, t)}
                </span>
                {group.key === mine && (
                  <span
                    className="shrink-0 rounded bg-accent-soft px-1 text-accent normal-case"
                    title={t("tracker.thisProjectWhy")}
                  >
                    {t("tracker.thisProject")}
                  </span>
                )}
                <span className="shrink-0 tabular-nums opacity-70">{group.items.length}</span>
              </button>
              {!closed && (
                <>
                  {visible.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      menuOpen={menuFor === item.id}
                      onMenu={(open) => {
                        setMenuFor(open ? item.id : null);
                      }}
                      open={openItemId === item.id}
                      onBranch={item === onBranch}
                      showType={showType}
                    />
                  ))}
                  {hidden > 0 && (
                    <button
                      onClick={() => {
                        expand(group.key);
                      }}
                      className="w-full px-1 py-1 text-left text-[11px] text-accent hover:underline"
                    >
                      {t("tracker.showMore", { count: hidden })}
                    </button>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>

      {actionsAt !== null && (
        <ContextMenu
          x={actionsAt.x}
          y={actionsAt.y}
          items={boardActions}
          onClose={() => {
            setActionsAt(null);
          }}
        />
      )}
      {optionsAt !== null && (
        <ContextMenu
          x={optionsAt.x}
          y={optionsAt.y}
          items={viewOptions}
          onClose={() => {
            setOptionsAt(null);
          }}
        />
      )}

      {confirmDisconnect && (
        // The token is shared by every project on this board, so forgetting it
        // is not a decision this one project can make quietly.
        <PromptModal
          title={t("tracker.disconnectTitle", { name: active.label })}
          hint={t("tracker.disconnectHint")}
          danger
          onSubmit={() => {
            setConfirmDisconnect(false);
            void useTrackers.getState().disconnect(active.id);
          }}
          onClose={() => {
            setConfirmDisconnect(false);
          }}
        />
      )}
    </div>
  );
}

/** How many rows a heading shows before it offers the rest. */
const GROUP_LIMIT = 8;

/** Where a menu is to hang, in window coordinates. */
interface Point {
  x: number;
  y: number;
}

/**
 * A small square button that reports where it is, so a menu can hang under it
 * rather than at the pointer - a menu that opens somewhere else is a menu the
 * eye has to go looking for.
 */
function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: (at: Point) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      onClick={() => {
        const box = ref.current?.getBoundingClientRect();
        onClick({ x: box?.left ?? 0, y: box?.bottom ?? 0 });
      }}
      title={label}
      className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-fg"
    >
      {icon}
    </button>
  );
}

/** A menu entry's tick, kept in place when it is off so nothing shifts. */
function Ticked({ on }: { on: boolean }) {
  return <Check size={13} className={on ? "text-accent" : "invisible"} />;
}

/** A stable value for a grouping choice, for the menu and for folded keys. */
function groupKey(by: GroupBy): string {
  return typeof by === "object" ? `dimension:${by.dimension}` : by;
}

/** What to call a grouping in the reader's language, or the service's own word. */
function groupName(by: GroupBy, t: (key: TranslationKey) => string): string {
  if (typeof by === "object") return by.dimension;
  return t(by === "parent" ? "tracker.byParent" : "tracker.byStatus");
}

/** One heading's text: a status in Aime's words, anything else in the service's. */
function headingOf(group: Group, t: (key: TranslationKey) => string): string {
  if (group.category !== undefined) return t(CATEGORY_LABELS[group.category]);
  return group.label === "" ? t("tracker.ungrouped") : group.label;
}

/** Group headings, in Aime's words because they are Aime's grouping. */
const CATEGORY_LABELS: Record<StateCategory, TranslationKey> = {
  inProgress: "tracker.category.inProgress",
  todo: "tracker.category.todo",
  unknown: "tracker.category.unknown",
  done: "tracker.category.done",
  removed: "tracker.category.removed",
};

/**
 * What a state looks like, by the only thing every board agrees on.
 *
 * The words are the team's - "Committed", "Đang làm", whatever the process
 * template says - so the colour is the only part of a state a reader can scan
 * without reading. Work being done is the one worth the accent; everything else
 * stays quiet, because a list where every row shouts says nothing.
 */
const CATEGORY_LOOK: Record<StateCategory, string> = {
  inProgress: "bg-accent-soft text-accent",
  todo: "bg-elevated text-muted",
  unknown: "bg-elevated text-warn",
  done: "bg-ok/12 text-ok",
  removed: "bg-elevated text-muted line-through",
};

/** The connect form's labels; a field Aime has no word for keeps its own name. */
const FIELD_LABELS: Partial<Record<string, TranslationKey>> = {
  organization: "tracker.field.organization",
  project: "tracker.field.project",
  team: "tracker.field.team",
  serverUrl: "tracker.field.serverUrl",
  site: "tracker.field.site",
  email: "tracker.field.email",
  workspace: "tracker.field.workspace",
  repository: "tracker.field.repository",
  apiUrl: "tracker.field.apiUrl",
};

/**
 * One item: what it is, where it stands, and the three things worth doing to it
 * without leaving the editor.
 *
 * The title gets two lines and the rest gets one, because the title is the only
 * part a reader cannot guess. Everything a truncated title used to hide - which
 * of four "Đăng nhập…" tickets this is - was the reason the panel had to be left
 * for the browser. The actions stay hidden until the row is hovered: a column
 * this narrow cannot show three buttons per row and still show titles.
 */
function ItemRow({
  item,
  menuOpen,
  onMenu,
  open,
  onBranch,
  showType,
}: {
  item: WorkItem;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  /** True when this item is the one on screen in the editor area. */
  open: boolean;
  /** True when the checked-out branch was started for this item. */
  onBranch: boolean;
  /** False when every item on the board is the same type, so the word says nothing. */
  showType: boolean;
}) {
  const t = useT();
  const isRepo = useGit((state) => state.status?.is_repo ?? false);
  const [states, setStates] = useState<StateOption[] | null>(null);
  const [loadingStates, setLoadingStates] = useState(false);
  const [branching, setBranching] = useState(false);

  const openStates = async () => {
    if (menuOpen) {
      onMenu(false);
      return;
    }
    setLoadingStates(true);
    // Nothing to choose from (a refusal, or a type with no states) reads as
    // closed, so the next click asks again instead of looking inert.
    const offered = await useTrackers.getState().statesFor(item);
    setStates(offered);
    setLoadingStates(false);
    onMenu(offered.length > 0);
  };

  /**
   * The whole row opens the item - it is what the row is for, and it is what the
   * row already looks like: the hover highlight covers all of it. While only the
   * title line carried the click, half the target (the state chip's line, the
   * padding) either did nothing or opened the state menu instead, which is a
   * click spent to close it again.
   */
  const openItem = () => {
    useWorkspace.getState().openWorkItem(item.id);
  };

  return (
    <div
      onClick={openItem}
      className={`group cursor-pointer rounded border-l-2 py-1.5 pr-1 pl-1.5 hover:bg-elevated ${
        open ? "bg-elevated" : ""
      } ${onBranch ? "border-accent" : "border-transparent"}`}
    >
      {/* Still a button, so the row is reachable by keyboard; the click it
          raises is the same one the row listens for. */}
      <button className="flex w-full items-start gap-1.5 text-left" title={t("tracker.openItem")}>
        {/* A column of its own, kept even when empty: the mark is scanned down
            the edge of the list, and a row that indents when it is marked pulls
            every title out of line. */}
        <span className="mt-[3px] w-3 shrink-0 text-accent">
          {onBranch && (
            <span title={t("tracker.onThisBranch")}>
              <GitBranch size={11} />
            </span>
          )}
        </span>
        <span className="shrink-0 text-[11px] leading-[1.45] text-muted tabular-nums">
          #{readableId(item)}
        </span>
        {/* Two lines, then an ellipsis: enough for the sentence that tells four
            similar tickets apart, bounded so one long title cannot own the panel. */}
        <p
          className={`line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-[1.45] ${open ? "text-accent" : ""}`}
          title={item.title}
        >
          {item.title}
        </p>
      </button>

      <div className="mt-1 flex items-center gap-1.5 pl-[1.65rem] text-[10.5px]">
        <button
          onClick={(event) => {
            // The buttons sitting on the row each do their own thing; none of
            // them also means "open this item".
            event.stopPropagation();
            void openStates();
          }}
          title={t("tracker.changeState")}
          className={`max-w-[52%] shrink-0 truncate rounded px-1 py-px hover:ring-1 hover:ring-accent ${
            CATEGORY_LOOK[item.category]
          }`}
        >
          {loadingStates ? "…" : item.state}
        </button>
        {showType && (
          <span className="min-w-0 truncate text-muted" title={item.itemType}>
            {item.itemType}
          </span>
        )}
        {/* What the item sits under is deliberately not here. In a column this
            narrow it arrives as "↳ Làm cho màn…", which names nothing, and it is
            the same story on every row of a group. The item view says it in
            full, and filing the list by it makes it a heading. */}
        <div className="ml-auto flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <button
            onClick={(event) => {
              event.stopPropagation();
              openUrl(item.webUrl).catch(console.error);
            }}
            title={t("tracker.openInBrowser")}
            className="rounded p-0.5 text-muted hover:text-accent"
          >
            <ExternalLink size={11} />
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              setBranching(true);
            }}
            disabled={!isRepo}
            title={isRepo ? t("tracker.startBranch") : t("tracker.branchNeedsRepo")}
            className="rounded p-0.5 text-muted hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted"
          >
            <GitBranch size={11} />
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              void useRun.getState().start(item);
            }}
            title={t("tracker.askAi")}
            className="rounded p-0.5 text-muted hover:text-accent"
          >
            <Sparkles size={11} />
          </button>
        </div>
      </div>

      {menuOpen && states !== null && (
        <div className="mt-1 max-h-32 overflow-y-auto rounded border border-line">
          {states.map((option) => (
            <button
              key={option.name}
              onClick={(event) => {
                event.stopPropagation();
                onMenu(false);
                void useTrackers.getState().moveTo(item, option.name);
              }}
              disabled={option.name === item.state}
              className="block w-full truncate px-1.5 py-0.5 text-left text-[11px] hover:bg-panel disabled:font-medium disabled:text-accent"
            >
              {option.name}
            </button>
          ))}
        </div>
      )}

      {branching && (
        <PromptModal
          title={t("tracker.branchTitle", { id: readableId(item) })}
          hint={t("tracker.branchHint")}
          initialValue={branchNameFor(item)}
          onSubmit={(name) => {
            setBranching(false);
            void useTrackers.getState().startBranch(name);
          }}
          onClose={() => {
            setBranching(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * This machine has boards, this project is not on one yet. Picking is one click
 * because the credential already exists - what is missing is only which board
 * this repository belongs to.
 */
function BoardPicker({ onConnectAnother }: { onConnectAnother: () => void }) {
  const connections = useTrackers((state) => state.connections);
  const t = useT();

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      <div>
        <p className="text-[12.5px]">{t("tracker.notLinked")}</p>
        <p className="mt-0.5 text-[11px] text-muted">{t("tracker.notLinkedHint")}</p>
      </div>
      <div className="space-y-1">
        {connections.map((connection) => (
          <button
            key={connection.id}
            onClick={() => void useTrackers.getState().setActive(connection.id)}
            title={t("tracker.useThisBoard", { name: connection.label })}
            className="block w-full truncate rounded border border-line px-2 py-1 text-left text-[11.5px] hover:border-accent hover:text-accent"
          >
            {connection.label}
            {/* Its credential went missing (removed by hand, or never stored):
                one click cannot work, and saying so beats a failed refresh. */}
            {!connection.hasToken && <span className="ml-1 text-warn">{t("tracker.needsToken")}</span>}
          </button>
        ))}
      </div>
      <button onClick={onConnectAnother} className="text-left text-[11px] text-accent hover:underline">
        {t("tracker.connectAnother")}
      </button>
      <Problem />
    </div>
  );
}

/**
 * First run: what to connect to, and what that service needs. The fields come
 * from the connector, so this form has never heard of Azure DevOps.
 */
function ConnectForm({ initial, onConnected }: { initial: Fields; onConnected: () => void }) {
  const { kinds, connecting, connect } = useTrackers();
  const t = useT();
  const [kindId, setKindId] = useState("");
  const [values, setValues] = useState<Fields>(initial);
  const [token, setToken] = useState("");

  // The list arrives from Rust, so the first render has nothing to offer yet.
  const kind = kinds.find((candidate) => candidate.kind === kindId) ?? kinds.at(0);
  if (kind === undefined) {
    return <p className="p-2 text-[11.5px] text-muted">{t("tracker.noKinds")}</p>;
  }

  const missing = kind.fields.some((field) => !field.optional && (values[field.name] ?? "").trim() === "");
  const helpUrl = fillTemplate(kind.secretHelpUrl, values);
  const ready = !connecting && !missing && token.trim() !== "";

  const submit = () => {
    if (!ready) return;
    void connect(kind.kind, definedOnly(values), token).then((ok) => {
      if (ok) onConnected();
    });
  };

  /** Enter is how a form with four fields is finished, not Tab-Tab-Tab-click. */
  const onEnter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") submit();
  };

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      <div>
        <p className="text-[12.5px]">{t("tracker.connectTitle")}</p>
        <p className="mt-0.5 text-[11px] text-muted">{t("tracker.connectHint")}</p>
      </div>

      {kinds.length > 1 && (
        <select
          value={kind.kind}
          onChange={(event) => {
            setKindId(event.target.value);
            setValues({});
          }}
          className="rounded border border-line bg-elevated px-2 py-1 text-[11.5px] outline-none focus:border-accent"
        >
          {kinds.map((candidate) => (
            <option key={candidate.kind} value={candidate.kind}>
              {candidate.label}
            </option>
          ))}
        </select>
      )}

      {kind.fields.map((field) => (
        <label key={field.name} className="text-[11px] text-muted">
          {fieldLabel(field.name, t)}
          {field.optional && <span className="ml-1 opacity-70">{t("tracker.optional")}</span>}
          <input
            value={values[field.name] ?? ""}
            onChange={(event) => {
              setValues({ ...values, [field.name]: event.target.value });
            }}
            onKeyDown={onEnter}
            placeholder={field.placeholder}
            spellCheck={false}
            className="mt-0.5 w-full rounded border border-line bg-elevated px-2 py-1 text-[11.5px] text-fg outline-none focus:border-accent"
          />
        </label>
      ))}

      <label className="text-[11px] text-muted">
        {kind.secretLabel}
        <input
          type="password"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
          onKeyDown={onEnter}
          spellCheck={false}
          className="mt-0.5 w-full rounded border border-line bg-elevated px-2 py-1 text-[11.5px] text-fg outline-none focus:border-accent"
        />
      </label>
      <p className="text-[10.5px] text-muted">
        {t("tracker.tokenHint")}
        {helpUrl !== null && (
          <>
            {" "}
            <button
              onClick={() => {
                openUrl(helpUrl).catch(console.error);
              }}
              className="text-accent hover:underline"
            >
              {t("tracker.tokenLink")}
            </button>
          </>
        )}
      </p>

      <button
        onClick={submit}
        disabled={!ready}
        className="flex items-center justify-center gap-1.5 rounded bg-accent-strong px-2 py-1.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {connecting ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
        {connecting ? t("tracker.connecting") : t("tracker.connect")}
      </button>

      <Problem />
    </div>
  );
}

/** A field's own label, or its name when Aime has no word for it. */
function fieldLabel(name: string, t: (key: TranslationKey) => string): string {
  const key = FIELD_LABELS[name];
  return key === undefined ? name : t(key);
}

/** The fields that were actually typed; the connector defaults the rest. */
function definedOnly(values: Fields): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) settings[name] = value;
  }
  return settings;
}

/**
 * The last failure, in the words its kind deserves - and, for the one failure
 * the user can fix from here, the button that fixes it.
 */
function Problem({ onReconnect }: { onReconnect?: () => void }) {
  const problem = useTrackers((state) => state.problem);
  const t = useT();
  if (problem === null) return null;
  return (
    <div className="border-danger/40 text-danger mx-1 my-1 rounded border px-1.5 py-1 text-[11px]">
      {t(problem.key, problem.params)}
      {problem.needsCredential && onReconnect !== undefined && (
        <button onClick={onReconnect} className="ml-1 underline hover:no-underline">
          {t("tracker.reconnect")}
        </button>
      )}
    </div>
  );
}
