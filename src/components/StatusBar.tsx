import { useState } from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Bot,
  Braces,
  CircleDollarSign,
  CircleHelp,
  FlaskConical,
  FolderOpen,
  GitBranch,
  Hammer,
  Languages,
  Loader2,
  Moon,
  PackageCheck,
  PanelLeft,
  Play,
  Settings2,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n, useT } from "../i18n";
import { languageOf } from "../lib/languages";
import { capabilitiesOf } from "../lib/providers";
import { useAi } from "../stores/ai";
import { useGit } from "../stores/git";
import { useLayout } from "../stores/layout";
import { useLsp } from "../stores/lsp";
import { useTasks, type TaskKind } from "../stores/tasks";
import { useTheme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const TASK_ICONS: Record<TaskKind, typeof Play> = {
  run: Play,
  build: Hammer,
  test: FlaskConical,
  publish: PackageCheck,
};

export function StatusBar() {
  const rootPath = useWorkspace((s) => s.rootPath);
  const { running, totalCostUsd, sessionId, providerId } = useAi();
  const { tasks, run: runTask } = useTasks();
  const setInstallerTools = useLayout((s) => s.setInstallerTools);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const [taskMenu, setTaskMenu] = useState<{ x: number; y: number } | null>(null);
  const { theme, toggle } = useTheme();
  const { locale, setLocale } = useI18n();
  const { sidebarVisible, aiPanelVisible, terminalVisible, toggleSidebar, toggleAiPanel, toggleTerminal } =
    useLayout();
  const toggleHelp = useLayout((s) => s.toggleHelp);
  const setSidebarView = useLayout((s) => s.setSidebarView);
  const gitStatus = useGit((s) => s.status);
  const openFilePath = useWorkspace((s) => s.openFilePath);
  const lspLanguages = useLsp((s) => s.languages);
  const t = useT();

  // Code intelligence for the file in front of the user: silent when it just
  // works, and explicit about what to install when it cannot.
  const openLanguage = openFilePath ? languageOf(openFilePath) : null;
  const lsp = openLanguage ? lspLanguages[openLanguage] : undefined;

  const taskItems: MenuItem[] =
    tasks.length === 0
      ? [{ label: t("tasks.none"), onClick: () => undefined }]
      : tasks.map((task) => {
          const Icon = TASK_ICONS[task.kind];
          return {
            label: task.label,
            icon: <Icon size={13} className="text-accent" />,
            onClick: () => void runTask(task),
          };
        });

  return (
    <footer className="flex h-6 items-center justify-between border-t border-line bg-panel px-3 text-[11px] text-muted">
      <div className="flex min-w-0 items-center gap-1.5">
        {rootPath && (
          <>
            <button
              onClick={toggleSidebar}
              className={`rounded px-1 py-0.5 hover:bg-elevated hover:text-fg ${sidebarVisible ? "text-accent" : ""}`}
              title={t("layout.toggleSidebar")}
            >
              <PanelLeft size={11} />
            </button>
            <button
              onClick={toggleAiPanel}
              className={`rounded px-1 py-0.5 hover:bg-elevated hover:text-fg ${aiPanelVisible ? "text-accent" : ""}`}
              title={t("layout.toggleAiPanel")}
            >
              <Bot size={11} />
            </button>
            <button
              onClick={toggleTerminal}
              className={`rounded px-1 py-0.5 hover:bg-elevated hover:text-fg ${terminalVisible ? "text-accent" : ""}`}
              title={t("layout.toggleTerminal")}
            >
              <SquareTerminal size={11} />
            </button>
            <button
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTaskMenu({ x: rect.left, y: rect.top - 4 });
              }}
              className="rounded px-1 py-0.5 hover:bg-elevated hover:text-fg"
              title={t("tasks.menu")}
            >
              <Play size={11} />
            </button>
          </>
        )}
        {taskMenu && (
          <ContextMenu
            x={taskMenu.x}
            y={taskMenu.y}
            items={taskItems}
            onClose={() => {
              setTaskMenu(null);
            }}
          />
        )}
        <button
          onClick={() => void invoke("open_new_window")}
          className="rounded px-1 py-0.5 hover:bg-elevated hover:text-fg"
          title={t("welcome.newWindowHint")}
        >
          <AppWindow size={11} />
        </button>
        <FolderOpen size={11} className="shrink-0" />
        <span className="truncate">{rootPath ?? t("status.noFolder")}</span>
        {gitStatus?.is_repo && gitStatus.branch && (
          <button
            onClick={() => {
              setSidebarView("git");
            }}
            className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-elevated hover:text-fg"
            title={t("sidebar.git")}
          >
            <GitBranch size={11} />
            {gitStatus.branch}
            {gitStatus.ahead > 0 && (
              <span className="flex items-center">
                {gitStatus.ahead}
                <ArrowUp size={10} />
              </span>
            )}
            {gitStatus.behind > 0 && (
              <span className="flex items-center">
                {gitStatus.behind}
                <ArrowDown size={10} />
              </span>
            )}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {running && (
          <span className="flex items-center gap-1 text-accent">
            <Loader2 size={11} className="animate-spin" /> {t("status.aiRunning")}
          </span>
        )}
        {sessionId && (
          <span title={`Session ${sessionId}`}>
            {t("status.session")}: {sessionId.slice(0, 8)}
          </span>
        )}
        {lsp && lsp.kind !== "unsupported" && openLanguage && (
          <button
            onClick={() => {
              if (lsp.kind === "missing") setInstallerTools([openLanguage]);
            }}
            className={`flex items-center gap-1 ${lsp.kind === "running" ? "text-ok" : lsp.kind === "missing" ? "text-warn" : ""}`}
            title={
              lsp.kind === "missing"
                ? t("lsp.missing", { command: lsp.command, install: lsp.installHint })
                : lsp.kind === "failed"
                  ? t("lsp.failed", { reason: lsp.reason })
                  : t("lsp.running", { language: openLanguage })
            }
          >
            <Braces size={11} />
            {openLanguage}
          </button>
        )}
        {/* Subscription CLIs report no price - showing $0.0000 would be a lie. */}
        {capabilitiesOf(providerId).reportsCost && (
          <span className="flex items-center gap-1" title={t("status.sessionCost")}>
            <CircleDollarSign size={11} /> ${totalCostUsd.toFixed(4)}
          </span>
        )}
        <button
          onClick={() => {
            setLocale(locale === "en" ? "vi" : "en");
          }}
          className="flex items-center gap-1 rounded px-1 hover:bg-elevated hover:text-fg"
          title={locale === "en" ? "Tiếng Việt" : "English"}
        >
          <Languages size={11} /> {locale.toUpperCase()}
        </button>
        <button
          onClick={toggle}
          className="rounded px-1 py-0.5 hover:bg-elevated hover:text-fg"
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? <Sun size={11} /> : <Moon size={11} />}
        </button>
        <button
          onClick={() => {
            setSettingsOpen(true);
          }}
          className="rounded px-1 py-0.5 hover:bg-elevated hover:text-fg"
          title={t("settings.title")}
        >
          <Settings2 size={11} />
        </button>
        <button
          onClick={toggleHelp}
          className="rounded px-1 py-0.5 hover:bg-elevated hover:text-fg"
          title={t("help.title")}
        >
          <CircleHelp size={11} />
        </button>
      </div>
    </footer>
  );
}
