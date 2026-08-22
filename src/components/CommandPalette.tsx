import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Puzzle,
  AppWindow,
  Bot,
  Brain,
  Bug,
  CircleHelp,
  ExternalLink,
  File,
  FolderOpen,
  FolderX,
  GitBranch,
  Languages,
  ListChecks,
  Moon,
  PanelLeft,
  Play,
  Settings2,
  Plug,
  Plus,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { useI18n, useT } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { fuzzyFilter } from "../lib/fuzzy";
import { projectFiles } from "../lib/projectFiles";
import { useAi } from "../stores/ai";
import { useDebug } from "../stores/debug";
import { useLayout } from "../stores/layout";
import { usePlugins } from "../stores/plugins";
import { useTasks } from "../stores/tasks";
import { useTerminals } from "../stores/terminals";
import { useTheme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";

const MAX_COMMANDS = 8;
const MAX_FILES = 12;

interface Command {
  id: string;
  title: string;
  icon: ReactNode;
  /** Shortcut hint shown on the right. */
  hint?: string;
  run: () => void;
}

type Row = { kind: "command"; command: Command } | { kind: "file"; path: string };

/**
 * One box for everything (Ctrl+K): fuzzy-matched commands and workspace
 * files together; a leading ">" restricts to commands (VS Code muscle memory).
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { rootPath, openFolder, closeFolder, openFile, openFilePath } = useWorkspace();
  const { toggleSidebar, toggleAiPanel, showTerminal, setSidebarView, toggleHelp, setMemoryOpen } =
    useLayout();
  const showDebugConsole = useLayout((s) => s.showDebugConsole);
  const startDebug = useDebug((s) => s.start);
  const stopDebug = useDebug((s) => s.stop);
  const debugging = useDebug((s) => s.status.kind !== "idle");
  const setMcpOpen = useLayout((s) => s.setMcpOpen);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const addTerminalTab = useTerminals((s) => s.addTab);
  const tasks = useTasks((s) => s.tasks);
  const runTask = useTasks((s) => s.run);
  const newSession = useAi((s) => s.newSession);
  const toggleTheme = useTheme((s) => s.toggle);
  const theme = useTheme((s) => s.theme);
  const pluginCommands = usePlugins((s) => s.commands);
  const runPluginCommand = usePlugins((s) => s.runCommand);
  const { locale, setLocale } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Quick-open index: fetched once per palette opening.
  useEffect(() => {
    if (!rootPath) return;
    let stale = false;
    void projectFiles(rootPath)
      .then((list) => {
        if (!stale) setFiles(list);
      })
      .catch(console.error);
    return () => {
      stale = true;
    };
  }, [rootPath]);

  const commands = useMemo<Command[]>(() => {
    const items: Command[] = [
      {
        id: "open-folder",
        title: t("welcome.openFolder"),
        icon: <FolderOpen size={14} />,
        run: () => void openFolder(),
      },
      {
        id: "new-window",
        title: t("welcome.newWindow"),
        icon: <AppWindow size={14} />,
        hint: "Ctrl+Shift+N",
        run: () => void invoke("open_new_window"),
      },
      {
        id: "toggle-sidebar",
        title: t("layout.toggleSidebar"),
        icon: <PanelLeft size={14} />,
        hint: "Ctrl+B",
        run: toggleSidebar,
      },
      {
        id: "toggle-ai",
        title: t("layout.toggleAiPanel"),
        icon: <Bot size={14} />,
        hint: "Ctrl+L",
        run: toggleAiPanel,
      },
      {
        id: "new-terminal",
        title: t("terminal.newTab"),
        icon: <SquareTerminal size={14} />,
        run: () => {
          showTerminal();
          addTerminalTab();
        },
      },
      {
        id: "toggle-theme",
        title: t("cmd.toggleTheme"),
        icon: theme === "dark" ? <Sun size={14} /> : <Moon size={14} />,
        run: toggleTheme,
      },
      {
        id: "toggle-language",
        title: t("cmd.toggleLanguage"),
        icon: <Languages size={14} />,
        run: () => {
          setLocale(locale === "en" ? "vi" : "en");
        },
      },
      {
        id: "edit-memory",
        title: t("cmd.editMemory"),
        icon: <Brain size={14} />,
        run: () => {
          setMemoryOpen(true);
        },
      },
      {
        id: "add-provider",
        title: t("cmd.addProvider"),
        icon: <Bot size={14} />,
        run: () => {
          void invoke<string>("providers_config_path")
            .then((path) => openFile(path))
            .catch(console.error);
        },
      },
      {
        id: "manage-mcp",
        title: t("cmd.manageMcp"),
        icon: <Plug size={14} />,
        run: () => {
          setMcpOpen(true);
        },
      },
      {
        id: "open-settings",
        title: t("settings.title"),
        icon: <Settings2 size={14} />,
        hint: "Ctrl+,",
        run: () => {
          setSettingsOpen(true);
        },
      },
      {
        id: "help",
        title: t("help.title"),
        icon: <CircleHelp size={14} />,
        hint: "F1",
        run: toggleHelp,
      },
    ];
    if (rootPath) {
      items.push(
        {
          id: "open-git",
          title: t("cmd.openGit"),
          icon: <GitBranch size={14} />,
          run: () => {
            setSidebarView("git");
          },
        },
        {
          id: "open-explorer",
          title: t("cmd.openExplorer"),
          icon: <File size={14} />,
          run: () => {
            setSidebarView("files");
          },
        },
        {
          id: "open-work-items",
          title: t("cmd.openWorkItems"),
          icon: <ListChecks size={14} />,
          run: () => {
            setSidebarView("workItems");
          },
        },
        {
          id: "open-debug",
          title: t("cmd.debugPanel"),
          icon: <Bug size={14} />,
          run: () => {
            setSidebarView("debug");
          },
        },
        {
          id: "debug-console",
          title: t("cmd.debugConsole"),
          icon: <Bug size={14} />,
          run: showDebugConsole,
        },
        {
          id: "new-ai-session",
          title: t("ai.newSession"),
          icon: <Plus size={14} />,
          run: newSession,
        },
        {
          id: "close-folder",
          title: t("menu.closeFolder"),
          icon: <FolderX size={14} />,
          run: closeFolder,
        },
        ...tasks.map((task) => ({
          id: `task-${task.id}`,
          title: t("tasks.runCommand", { label: task.label }),
          icon: <Play size={14} />,
          hint: task.command,
          run: () => void runTask(task),
        })),
      );
    }
    if (openFilePath) {
      items.push({
        id: "reveal-current",
        title: t("cmd.revealCurrent"),
        icon: <ExternalLink size={14} />,
        run: () => {
          revealItemInDir(openFilePath).catch(console.error);
        },
      });
      // Starting and stopping are mutually exclusive, and offering the one
      // that cannot work is how a palette becomes noise.
      for (const command of pluginCommands) {
        items.push({
          id: `plugin-${command.pluginId}-${command.commandId}`,
          title: command.title,
          icon: <Puzzle size={14} />,
          hint: command.pluginId,
          run: () => void runPluginCommand(command.pluginId, command.commandId),
        });
      }
      items.push(
        debugging
          ? {
              id: "debug-stop",
              title: t("cmd.debugStop"),
              icon: <Bug size={14} />,
              hint: "Shift+F5",
              run: () => void stopDebug(),
            }
          : {
              id: "debug-start",
              title: t("cmd.debugStart"),
              icon: <Bug size={14} />,
              hint: "F5",
              run: () => void startDebug(),
            },
      );
    }
    return items;
  }, [
    t,
    theme,
    locale,
    rootPath,
    openFilePath,
    openFolder,
    closeFolder,
    toggleSidebar,
    toggleAiPanel,
    showTerminal,
    addTerminalTab,
    toggleTheme,
    setLocale,
    toggleHelp,
    setSidebarView,
    setMemoryOpen,
    setMcpOpen,
    setSettingsOpen,
    showDebugConsole,
    debugging,
    startDebug,
    stopDebug,
    pluginCommands,
    runPluginCommand,
    openFile,
    newSession,
    tasks,
    runTask,
  ]);

  const rows = useMemo<Row[]>(() => {
    const commandsOnly = query.startsWith(">");
    const needle = commandsOnly ? query.slice(1).trim() : query.trim();
    const commandRows = fuzzyFilter(commands, needle, (c) => c.title, MAX_COMMANDS).map((r): Row => ({
      kind: "command",
      command: r.item,
    }));
    if (commandsOnly) return commandRows;
    const fileRows =
      needle.length === 0
        ? []
        : fuzzyFilter(files, needle, (f) => f, MAX_FILES).map((r): Row => ({ kind: "file", path: r.item }));
    return [...commandRows, ...fileRows];
  }, [query, commands, files]);

  const clampedSelected = Math.min(selected, Math.max(0, rows.length - 1));

  const runRow = useCallback(
    (row: Row) => {
      onClose();
      if (row.kind === "command") {
        row.command.run();
      } else if (rootPath) {
        void openFile(`${rootPath}\\${row.path.replaceAll("/", "\\")}`);
      }
    },
    [onClose, rootPath, openFile],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.min(clampedSelected + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(clampedSelected - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[clampedSelected] as Row | undefined;
      if (row) runRow(row);
    }
  };

  // Keep the selected row visible while navigating with the keyboard.
  useEffect(() => {
    listRef.current?.children[clampedSelected]?.scrollIntoView({ block: "nearest" });
  }, [clampedSelected]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onClick={onClose}>
      <div
        className="flex max-h-[60vh] w-[520px] max-w-[90vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("palette.placeholder")}
          className="border-b border-line bg-transparent px-4 py-3 outline-none placeholder:text-muted"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.length === 0 && <p className="px-4 py-3 text-muted">{t("palette.noResults")}</p>}
          {rows.map((row, index) => {
            const active = index === clampedSelected;
            const key = row.kind === "command" ? `c-${row.command.id}` : `f-${row.path}`;
            return (
              <button
                key={key}
                onClick={() => {
                  runRow(row);
                }}
                onMouseEnter={() => {
                  setSelected(index);
                }}
                className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left ${
                  active ? "bg-accent-soft" : ""
                }`}
              >
                {row.kind === "command" ? (
                  <>
                    <span className="shrink-0 text-accent">{row.command.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{row.command.title}</span>
                    {row.command.hint && (
                      <span className="shrink-0 font-mono text-[10px] text-muted">{row.command.hint}</span>
                    )}
                  </>
                ) : (
                  <>
                    <File size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">
                      {row.path.split("/").pop()}
                      <span className="ml-1.5 text-[11px] text-muted">{row.path}</span>
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
        <div className="border-t border-line px-4 py-1.5 text-[10px] text-muted">{t("palette.footer")}</div>
      </div>
    </div>
  );
}
