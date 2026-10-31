import { useRef, useState } from "react";
import { AppWindow, FolderOpen, Loader2, Plus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { translate, useT } from "../i18n";
import { tabName, useWorkspaceTabs, type WorkspaceTab } from "../stores/workspaceTabs";
import { ContextMenu } from "./ContextMenu";
import { PromptModal } from "./PromptModal";
import { useTabReorder } from "./useTabReorder";

/**
 * The workspaces of this window as a thin strip of tabs along its top edge.
 *
 * Thin on purpose: every pixel here is taken from the editor. A tab is a
 * folder; clicking it shows that workspace where this one stands, and the one
 * left keeps running - its terminals, its AI turn, its language servers. A tab
 * dragged along the strip takes the place it is let go at; right click takes
 * it out into a window of its own. A tab just opened, or picked while it was
 * still asleep, takes a moment to build its page: until it has painted and
 * takes this one's place, this workspace dims under a card naming the tab
 * being opened, so the click visibly landed.
 *
 * Closing a tab that has a folder open asks first: whatever still runs in it -
 * an AI turn, terminals, a debug session - stops with it, and its x sits where
 * a slip of the pointer lands. The welcome tab holds nothing and just closes.
 */
export function WorkspaceTabs() {
  const t = useT();
  const { tabs, active, switchTo, reorder, close, detach } = useWorkspaceTabs();
  const strip = useRef<HTMLElement>(null);
  const drag = useTabReorder(
    strip,
    tabs.map((tab) => tab.label),
    reorder,
  );
  const byLabel = new Map(tabs.map((tab) => [tab.label, tab]));
  const [menu, setMenu] = useState<{ tab: WorkspaceTab; x: number; y: number } | null>(null);
  const [closing, setClosing] = useState<WorkspaceTab | null>(null);
  // A tab of this strip still loading is on its way to take this one's place:
  // one just opened, or one picked while it was asleep.
  const opening = tabs.find((tab) => tab.loading && tab.label !== active);

  const askToClose = (tab: WorkspaceTab) => {
    if (tab.folder === null) void close(tab.label);
    else setClosing(tab);
  };

  return (
    <>
      <nav
        ref={strip}
        aria-label={t("tabs.workspaces")}
        className="relative z-40 flex h-7 shrink-0 items-stretch gap-px overflow-x-auto border-b border-line bg-panel text-[11px]"
      >
        {drag.order.map((label) => {
          const tab = byLabel.get(label);
          if (tab === undefined) return null;
          const current = tab.label === active;
          const loading = tab.loading && !current;
          return (
            <div
              key={tab.label}
              data-workspace-tab={tab.label}
              onPointerDown={(event) => {
                if (!loading) drag.begin(tab.label, event);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!loading) setMenu({ tab, x: event.clientX, y: event.clientY });
              }}
              className={`group flex max-w-52 min-w-24 items-center gap-1.5 border-r border-line px-2 ${
                current ? "bg-bg text-fg" : "text-muted hover:bg-elevated hover:text-fg"
              } ${drag.held === tab.label ? "opacity-60" : ""}`}
            >
              <button
                onClick={() => {
                  if (!drag.wasDrag() && !current) void switchTo(tab.label);
                }}
                disabled={loading}
                title={tab.folder ?? t("tabs.welcome")}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                {loading ? (
                  <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
                ) : (
                  <FolderOpen size={11} className={`shrink-0 ${current ? "text-accent" : ""}`} />
                )}
                <span className="truncate">{tabName(tab) ?? t("tabs.welcome")}</span>
              </button>
              <button
                onClick={() => {
                  askToClose(tab);
                }}
                title={t("tabs.close")}
                className={`shrink-0 rounded p-0.5 hover:bg-elevated hover:text-fg ${
                  current ? "" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
        <button
          onClick={() => void openFolderAsTab()}
          title={t("tabs.open")}
          className="flex shrink-0 items-center px-2 text-muted hover:bg-elevated hover:text-fg"
        >
          <Plus size={12} />
        </button>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={[
              {
                label: t("tabs.detach"),
                icon: <AppWindow size={14} />,
                onClick: () => void detach(menu.tab.label),
              },
              {
                label: t("tabs.close"),
                icon: <X size={14} />,
                onClick: () => {
                  askToClose(menu.tab);
                },
              },
            ]}
            onClose={() => {
              setMenu(null);
            }}
          />
        )}
        {closing && (
          <PromptModal
            title={t("tabs.closeTitle", { name: tabName(closing) ?? "" })}
            hint={t("tabs.closeHint")}
            submitLabel={t("tabs.closeConfirm")}
            danger
            onSubmit={() => {
              setClosing(null);
              void close(closing.label);
            }}
            onClose={() => {
              setClosing(null);
            }}
          />
        )}
      </nav>
      {opening && <OpeningTab name={tabName(opening) ?? t("tabs.welcome")} />}
    </>
  );
}

/**
 * Covers this workspace while the tab picked builds its page. The strip stays
 * above it (`z-40`), so another tab can still be picked meanwhile.
 */
function OpeningTab({ name }: { name: string }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      data-tab-opening
      className="fixed inset-0 z-30 flex items-center justify-center bg-bg/70 backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-3 rounded-lg border border-line bg-panel px-5 py-3 text-sm text-fg shadow-lg">
        <Loader2 size={18} className="shrink-0 animate-spin text-accent" />
        <span className="max-w-80 truncate">{t("tabs.opening", { name })}</span>
      </div>
    </div>
  );
}

/** Asks for a folder and opens it as a new tab; cancelling the dialog opens nothing. */
export async function openFolderAsTab(): Promise<void> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: translate("dialog.openFolderTitle"),
  });
  if (typeof selected === "string") await useWorkspaceTabs.getState().open(selected);
}
