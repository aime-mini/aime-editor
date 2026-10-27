import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowRightToLine, Cloud, Copy, ExternalLink, ListX, Save, SquareX, Workflow, X } from "lucide-react";
import { translate, useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { copyPath } from "../lib/copyPath";
import { isWithin, relativeTo } from "../lib/repositories";
import { tabsClosedBy, type CloseScope } from "../lib/tabClosing";
import { failedTo } from "../stores/notices";
import { CLOUD_TAB, FLOWS_TAB, isSpecialTab, useWorkspace } from "../stores/workspace";
import { ContextMenu, SEPARATOR, type MenuItem } from "./ContextMenu";

/** Tab label: the file name, which is what the user recognizes. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * One tab per open file - name, unsaved dot, close on hover or middle-click,
 * the rest on right-click - and one for the cloud panel when it is open, so a
 * file opened over the panel puts it behind instead of closing it (see
 * `CLOUD_TAB`).
 */
export function EditorTabs() {
  const { openTabs, openFilePath, cloudOpen, flowsOpen, buffers, dirty, activateTab, closeTab } =
    useWorkspace();
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const t = useT();
  if (openTabs.length === 0) return null;

  const isDirty = (path: string) =>
    isSpecialTab(path)
      ? false
      : path === openFilePath
        ? dirty
        : (() => {
            const buffer = buffers[path];
            return buffer ? buffer.content !== buffer.savedContent : false;
          })();
  const isActive = (path: string) =>
    path === CLOUD_TAB
      ? cloudOpen
      : path === FLOWS_TAB
        ? flowsOpen
        : path === openFilePath && !cloudOpen && !flowsOpen;

  return (
    <div className="flex items-stretch gap-0.5 overflow-x-auto border-b border-line bg-panel px-1 pt-1">
      {openTabs.map((path) => {
        const active = isActive(path);
        return (
          <div
            key={path}
            data-editor-tab={path}
            onClick={() => {
              activateTab(path);
            }}
            onAuxClick={(e) => {
              // Middle-click closes, the way every editor does it.
              if (e.button === 1) {
                e.preventDefault();
                closeTab(path);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ path, x: e.clientX, y: e.clientY });
            }}
            title={
              path === CLOUD_TAB ? t("cloud.openPanel") : path === FLOWS_TAB ? t("flows.tabTitle") : path
            }
            className={`group flex max-w-52 shrink-0 items-center gap-1.5 rounded-t px-2 py-1 text-[11.5px] ${
              active ? "bg-elevated text-fg" : "cursor-pointer text-muted hover:bg-elevated/50"
            }`}
          >
            {path === CLOUD_TAB && <Cloud size={11} className="shrink-0" />}
            {path === FLOWS_TAB && <Workflow size={11} className="shrink-0" />}
            <span className="truncate">
              {path === CLOUD_TAB
                ? t("cloud.panelTitle")
                : path === FLOWS_TAB
                  ? t("flows.tabTitle")
                  : fileNameOf(path)}
            </span>
            {isDirty(path) && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(path);
              }}
              title={t("editor.closeTab")}
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-danger"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[...closeItems(menu.path, openTabs, isDirty), ...fileItems(menu.path)]}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** What each bulk close entry is called, and its icon. */
const CLOSE_ENTRIES: { scope: CloseScope; label: TranslationKey; icon: typeof X }[] = [
  { scope: "others", label: "editorTabs.closeOthers", icon: SquareX },
  { scope: "right", label: "editorTabs.closeRight", icon: ArrowRightToLine },
  { scope: "saved", label: "editorTabs.closeSaved", icon: Save },
  { scope: "all", label: "editorTabs.closeAll", icon: ListX },
];

/**
 * Close, then the bulk commands. One that would take nothing - the last tab
 * has nothing to its right, a lone tab has no others - is left out rather than
 * offered and found to do nothing.
 */
function closeItems(path: string, tabs: readonly string[], isDirty: (path: string) => boolean): MenuItem[] {
  const { closeTab, closeTabs } = useWorkspace.getState();
  const close: MenuItem = {
    label: translate("editorTabs.close"),
    icon: <X size={14} />,
    onClick: () => {
      closeTab(path);
    },
  };
  const bulk = CLOSE_ENTRIES.flatMap(({ scope, label, icon: Icon }) => {
    const closing = tabsClosedBy(scope, tabs, path, isDirty);
    if (closing.length === 0) return [];
    return [
      {
        label: translate(label),
        icon: <Icon size={14} />,
        onClick: () => {
          closeTabs(closing);
        },
      },
    ];
  });
  return [close, ...bulk];
}

/** Where the file is: its path for the clipboard, and its folder on screen. */
function fileItems(path: string): (MenuItem | typeof SEPARATOR)[] {
  if (isSpecialTab(path)) return [];
  const root = useWorkspace.getState().rootPath;
  const items: MenuItem[] = [
    {
      label: translate("editorTabs.copyPath"),
      icon: <Copy size={14} />,
      onClick: () => {
        copyPath(path);
      },
    },
  ];
  if (root !== null && isWithin(path, root)) {
    items.push({
      label: translate("editorTabs.copyRelativePath"),
      icon: <Copy size={14} />,
      onClick: () => {
        copyPath(relativeTo(root, path));
      },
    });
  }
  items.push({
    label: translate("menu.revealExplorer"),
    icon: <ExternalLink size={14} />,
    onClick: () => {
      revealItemInDir(path).catch(failedTo(translate("notice.reveal", { name: fileNameOf(path) })));
    },
  });
  return [SEPARATOR, ...items];
}
