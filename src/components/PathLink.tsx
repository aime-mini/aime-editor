import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AppWindow, Copy, ExternalLink, FileText, FolderOpen } from "lucide-react";
import { translate } from "../i18n";
import { copyPath } from "../lib/copyPath";
import { openOrReveal } from "../lib/openOrReveal";
import { failedTo } from "../stores/notices";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { PathKind } from "./usePathKinds";

/**
 * A file or folder an AI answer names, made something to click.
 *
 * A click offers what can be done with it rather than doing one thing: a file
 * opens in a tab (on the line the answer pointed at) or shows in its folder; a
 * folder opens in the system's file manager or as a workspace of its own.
 */
export function PathLink({
  path,
  kind,
  line,
  children,
}: {
  path: string;
  kind: PathKind;
  line?: number;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        onClick={(e) => {
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={line === undefined ? path : `${path}:${String(line)}`}
        data-path-link={kind}
        // Inline and breakable anywhere: an absolute path has no spaces to wrap
        // at, and as a button's usual inline-block it ran out of the bubble.
        className="inline text-left [overflow-wrap:anywhere] text-accent hover:underline"
      >
        {children}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={kind === "file" ? fileActions(path, line) : folderActions(path)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </>
  );
}

function nameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function copyItem(path: string): MenuItem {
  return {
    label: translate("editorTabs.copyPath"),
    icon: <Copy size={14} />,
    onClick: () => {
      copyPath(path);
    },
  };
}

function fileActions(path: string, line: number | undefined): MenuItem[] {
  return [
    {
      label: translate("pathLink.openFile"),
      icon: <FileText size={14} />,
      onClick: () => {
        openOrReveal(path, line).catch(failedTo(translate("pathLink.openFailed", { name: nameOf(path) })));
      },
    },
    {
      label: translate("pathLink.showInFolder"),
      icon: <ExternalLink size={14} />,
      onClick: () => {
        revealItemInDir(path).catch(failedTo(translate("notice.reveal", { name: nameOf(path) })));
      },
    },
    copyItem(path),
  ];
}

function folderActions(path: string): MenuItem[] {
  return [
    {
      label: translate("pathLink.openFolder"),
      icon: <FolderOpen size={14} />,
      onClick: () => {
        invoke("open_folder", { path }).catch(failedTo(translate("notice.reveal", { name: nameOf(path) })));
      },
    },
    {
      label: translate("pathLink.openWorkspace"),
      icon: <AppWindow size={14} />,
      onClick: () => {
        invoke("workspace_open", { folder: path }).catch(
          failedTo(translate("pathLink.openFailed", { name: nameOf(path) })),
        );
      },
    },
    copyItem(path),
  ];
}
