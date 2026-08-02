import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileClock,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import { useGit } from "../stores/git";
import { useWorkspace } from "../stores/workspace";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { PromptModal } from "./PromptModal";
import type { DirEntry } from "../lib/types";

type MenuTarget = { entry: DirEntry; x: number; y: number };
type ModalAction =
  | { kind: "new-file" | "new-folder"; dirPath: string }
  | { kind: "rename"; entry: DirEntry }
  | { kind: "delete"; entry: DirEntry };

/** Custom MIME type so the tree only accepts drags that started inside it. */
const DRAG_MIME = "application/x-aime-path";

interface TreeDnd {
  /** Folder currently hovered as a drop target (for highlighting). */
  dropTarget: string | null;
  onHover: (dir: string | null) => void;
  onDropInto: (sourcePath: string, entry: DirEntry) => void;
}

/** Git badges keyed by normalized absolute path; folders map to "●". */
type GitBadges = Map<string, { label: string; color: string }>;

function pathKey(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

function badgeColorOf(letter: string): string {
  if (letter === "D") return "text-danger";
  if (letter === "U" || letter === "A") return "text-ok";
  return "text-accent";
}

function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

function TreeNode({
  entry,
  depth,
  onMenu,
  dnd,
  badges,
}: {
  entry: DirEntry;
  depth: number;
  onMenu: (target: MenuTarget) => void;
  dnd: TreeDnd;
  badges: GitBadges;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const { openFile, openFilePath, treeVersion } = useWorkspace();

  // Loads on first expand and reloads while expanded whenever the workspace
  // changes, so nested levels stay fresh without collapsing the tree.
  useEffect(() => {
    if (!entry.is_dir || !expanded) return;
    let stale = false;
    invoke<DirEntry[]>("list_dir", { path: entry.path })
      .then((list) => {
        if (!stale) setChildren(list);
      })
      .catch(console.error);
    return () => {
      stale = true;
    };
  }, [entry.is_dir, entry.path, expanded, treeVersion]);

  const toggle = () => {
    if (!entry.is_dir) {
      void openFile(entry.path);
      return;
    }
    setExpanded(!expanded);
  };

  const active = openFilePath === entry.path;
  const isDropTarget = entry.is_dir && dnd.dropTarget === entry.path;

  return (
    <div>
      <button
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ entry, x: e.clientX, y: e.clientY });
        }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, entry.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          dnd.onHover(entry.is_dir ? entry.path : null);
        }}
        onDragLeave={() => {
          if (isDropTarget) dnd.onHover(null);
        }}
        onDragEnd={() => {
          dnd.onHover(null);
        }}
        onDrop={(e) => {
          const source = e.dataTransfer.getData(DRAG_MIME);
          if (!source) return;
          e.preventDefault();
          e.stopPropagation();
          dnd.onDropInto(source, entry);
          dnd.onHover(null);
        }}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-elevated ${
          active ? "bg-accent-soft text-accent" : "text-fg"
        } ${isDropTarget ? "bg-accent-soft outline-1 outline-accent" : ""}`}
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        {entry.is_dir ? (
          <>
            {expanded ? (
              <ChevronDown size={13} className="shrink-0 text-muted" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-muted" />
            )}
            {expanded ? (
              <FolderOpen size={14} className="shrink-0 text-accent" />
            ) : (
              <Folder size={14} className="shrink-0 text-accent" />
            )}
          </>
        ) : (
          <File size={14} className="ml-[13px] shrink-0 text-muted" />
        )}
        <span className="truncate">{entry.name}</span>
        {(() => {
          const badge = badges.get(pathKey(entry.path));
          return badge ? (
            <span className={`ml-auto shrink-0 pr-1 font-mono text-[10px] ${badge.color}`}>
              {badge.label}
            </span>
          ) : null;
        })()}
      </button>
      {expanded &&
        children?.map((c) => (
          <TreeNode key={c.path} entry={c} depth={depth + 1} onMenu={onMenu} dnd={dnd} badges={badges} />
        ))}
    </div>
  );
}

export function FileTree() {
  const { rootPath, treeVersion, refreshTree, handlePathDeleted, handlePathRenamed } = useWorkspace();
  const { openFolder, closeFolder, openFile, openBlame } = useWorkspace();
  const isRepo = useGit((s) => s.status?.is_repo ?? false);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [modal, setModal] = useState<ModalAction | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const t = useT();

  /** Moves `sourcePath` into `targetDir` (same-name, VS Code semantics). */
  const moveInto = useCallback(
    async (sourcePath: string, targetDir: string) => {
      const name = sourcePath.split(/[\\/]/).pop();
      if (!name) return;
      const invalid =
        targetDir === sourcePath ||
        targetDir === parentOf(sourcePath) || // already there
        targetDir.startsWith(`${sourcePath}\\`) || // can't move a folder into itself
        targetDir.startsWith(`${sourcePath}/`);
      if (invalid) return;
      try {
        const to = `${targetDir}/${name}`;
        await invoke("rename_path", { from: sourcePath, to });
        handlePathRenamed(sourcePath, to);
        refreshTree();
      } catch (err: unknown) {
        console.error("move failed:", err);
      }
    },
    [handlePathRenamed, refreshTree],
  );

  const dnd: TreeDnd = {
    dropTarget,
    onHover: setDropTarget,
    onDropInto: (sourcePath, entry) => {
      // Dropping on a file moves next to it — into its containing folder.
      void moveInto(sourcePath, entry.is_dir ? entry.path : parentOf(entry.path));
    },
  };

  const gitFiles = useGit((s) => s.status?.files);
  const badges: GitBadges = useMemo(() => {
    const map: GitBadges = new Map();
    if (!gitFiles || !rootPath) return map;
    for (const file of gitFiles) {
      const worktreeChanged = file.unstaged !== " " && file.unstaged !== ".";
      const letter = file.conflicted
        ? "!"
        : file.unstaged === "?"
          ? "U"
          : worktreeChanged
            ? file.unstaged
            : file.staged;
      map.set(pathKey(`${rootPath}\\${file.path}`), { label: letter, color: badgeColorOf(letter) });
      // Ancestor folders get a dot so changes are visible while collapsed.
      let dir = file.path;
      while (dir.includes("/")) {
        dir = dir.slice(0, dir.lastIndexOf("/"));
        const key = pathKey(`${rootPath}\\${dir}`);
        if (!map.has(key)) map.set(key, { label: "●", color: "text-accent" });
      }
    }
    return map;
  }, [gitFiles, rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    invoke<DirEntry[]>("list_dir", { path: rootPath }).then(setEntries).catch(console.error);
  }, [rootPath, treeVersion]);

  const runModalAction = useCallback(
    async (value: string) => {
      if (!modal) return;
      try {
        switch (modal.kind) {
          case "new-file":
            await invoke("write_file", { path: `${modal.dirPath}/${value}`, content: "" });
            break;
          case "new-folder":
            await invoke("create_dir", { path: `${modal.dirPath}/${value}` });
            break;
          case "rename": {
            const to = `${parentOf(modal.entry.path)}/${value}`;
            await invoke("rename_path", { from: modal.entry.path, to });
            handlePathRenamed(modal.entry.path, to);
            break;
          }
          case "delete":
            await invoke("delete_path", { path: modal.entry.path });
            handlePathDeleted(modal.entry.path);
            break;
        }
        refreshTree();
      } catch (err) {
        console.error(err);
      } finally {
        setModal(null);
      }
    },
    [modal, refreshTree, handlePathDeleted, handlePathRenamed],
  );

  if (!rootPath) return null;

  const menuItems = (target: MenuTarget): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!target.entry.is_dir) {
      items.push({
        label: t("menu.open"),
        icon: <File size={14} />,
        onClick: () => {
          void openFile(target.entry.path);
        },
      });
      if (isRepo) {
        items.push({
          label: t("menu.gitBlame"),
          icon: <FileClock size={14} />,
          onClick: () => {
            openBlame(target.entry.path.slice(rootPath.length + 1).replaceAll("\\", "/"));
          },
        });
      }
    }
    items.push({
      label: t("menu.revealExplorer"),
      icon: <ExternalLink size={14} />,
      onClick: () => {
        revealItemInDir(target.entry.path).catch((err: unknown) => {
          console.error("reveal in explorer failed:", err);
        });
      },
    });
    if (target.entry.is_dir) {
      items.push(
        {
          label: t("menu.newFile"),
          icon: <FilePlus size={14} />,
          onClick: () => {
            setModal({ kind: "new-file", dirPath: target.entry.path });
          },
        },
        {
          label: t("menu.newFolder"),
          icon: <FolderPlus size={14} />,
          onClick: () => {
            setModal({ kind: "new-folder", dirPath: target.entry.path });
          },
        },
      );
    }
    if (target.entry.path === rootPath) {
      // The workspace root can be switched or closed — never renamed/deleted from here.
      items.push(
        {
          label: t("welcome.openFolder"),
          icon: <FolderOpen size={14} />,
          onClick: () => {
            void openFolder();
          },
        },
        {
          label: t("menu.closeFolder"),
          icon: <X size={14} />,
          onClick: closeFolder,
        },
      );
      return items;
    }
    items.push(
      {
        label: t("menu.rename"),
        icon: <Pencil size={14} />,
        onClick: () => {
          setModal({ kind: "rename", entry: target.entry });
        },
      },
      {
        label: t("menu.delete"),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => {
          setModal({ kind: "delete", entry: target.entry });
        },
      },
    );
    return items;
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto py-1 pr-1 select-none">
      <div
        className={`group flex items-center gap-1 px-2 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase ${
          dropTarget === rootPath ? "bg-accent-soft text-accent" : ""
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ entry: { name: "", path: rootPath, is_dir: true }, x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTarget(rootPath);
        }}
        onDragLeave={() => {
          if (dropTarget === rootPath) setDropTarget(null);
        }}
        onDrop={(e) => {
          const source = e.dataTransfer.getData(DRAG_MIME);
          if (!source) return;
          e.preventDefault();
          void moveInto(source, rootPath);
          setDropTarget(null);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{rootPath.split(/[\\/]/).pop()}</span>
        <button
          onClick={() => void openFolder()}
          title={t("welcome.openFolder")}
          className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-elevated hover:text-fg"
        >
          <FolderOpen size={12} />
        </button>
        <button
          onClick={closeFolder}
          title={t("menu.closeFolder")}
          className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-elevated hover:text-danger"
        >
          <X size={12} />
        </button>
      </div>
      {entries.map((e) => (
        <TreeNode key={e.path} entry={e} depth={0} onMenu={setMenu} dnd={dnd} badges={badges} />
      ))}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      {modal && modal.kind !== "delete" && (
        <PromptModal
          title={
            modal.kind === "new-file"
              ? t("modal.newFileTitle")
              : modal.kind === "new-folder"
                ? t("modal.newFolderTitle")
                : t("modal.renameTitle")
          }
          initialValue={modal.kind === "rename" ? modal.entry.name : ""}
          onSubmit={(v) => {
            void runModalAction(v);
          }}
          onClose={() => {
            setModal(null);
          }}
        />
      )}
      {modal && modal.kind === "delete" && (
        <PromptModal
          title={t("modal.deleteTitle", { name: modal.entry.name })}
          hint={t("modal.deleteHint")}
          danger
          onSubmit={() => {
            void runModalAction("");
          }}
          onClose={() => {
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
