import { useState } from "react";
import { AppWindow, FolderOpen, Plus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { translate, useT } from "../i18n";
import { tabName, useWorkspaceTabs, type WorkspaceTab } from "../stores/workspaceTabs";
import { ContextMenu } from "./ContextMenu";

/**
 * The workspaces of this window as a thin strip of tabs along its top edge.
 *
 * Thin on purpose: every pixel here is taken from the editor. A tab is a
 * folder; clicking it shows that workspace where this one stands, and the one
 * left keeps running - its terminals, its AI turn, its language servers. Right
 * click takes a tab out into a window of its own.
 */
export function WorkspaceTabs() {
  const t = useT();
  const { tabs, active, switchTo, close, detach } = useWorkspaceTabs();
  const [menu, setMenu] = useState<{ tab: WorkspaceTab; x: number; y: number } | null>(null);

  return (
    <nav
      aria-label={t("tabs.workspaces")}
      className="flex h-7 shrink-0 items-stretch gap-px overflow-x-auto border-b border-line bg-panel text-[11px]"
    >
      {tabs.map((tab) => {
        const current = tab.label === active;
        return (
          <div
            key={tab.label}
            data-workspace-tab={tab.label}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ tab, x: event.clientX, y: event.clientY });
            }}
            className={`group flex max-w-52 min-w-24 items-center gap-1.5 border-r border-line px-2 ${
              current ? "bg-bg text-fg" : "text-muted hover:bg-elevated hover:text-fg"
            }`}
          >
            <button
              onClick={() => {
                if (!current) void switchTo(tab.label);
              }}
              title={tab.folder ?? t("tabs.welcome")}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <FolderOpen size={11} className={`shrink-0 ${current ? "text-accent" : ""}`} />
              <span className="truncate">{tabName(tab) ?? t("tabs.welcome")}</span>
            </button>
            <button
              onClick={() => void close(tab.label)}
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
              onClick: () => void close(menu.tab.label),
            },
          ]}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </nav>
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
