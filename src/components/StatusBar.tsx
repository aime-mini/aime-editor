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
  ShieldCheck,
  PanelLeft,
  Play,
  Settings2,
  Sparkles,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n, useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { languageOf } from "../lib/languages";
import { capabilitiesOf } from "../lib/providers";
import { useAi } from "../stores/ai";
import { useGit } from "../stores/git";
import { useLayout } from "../stores/layout";
import { useLsp } from "../stores/lsp";
import { useSetup } from "../stores/setup";
import { TASK_KINDS, useTasks, type TaskKind } from "../stores/tasks";
import { useInlineAi } from "../stores/inlineAi";
import { INLINE_AI_MODES, useSettings } from "../stores/settings";
import { useTheme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";
import { ContextMenu, SEPARATOR, type MenuItem } from "./ContextMenu";

const TASK_ICONS: Record<TaskKind, typeof Play> = {
  run: Play,
  build: Hammer,
  test: FlaskConical,
  check: ShieldCheck,
  publish: PackageCheck,
};

/** The outcome named in the user's language, for the "ask the AI" entries. */
const TASK_LABELS: Record<TaskKind, TranslationKey> = {
  run: "tasks.kindRun",
  build: "tasks.kindBuild",
  test: "tasks.kindTest",
  check: "tasks.kindCheck",
  publish: "tasks.kindPublish",
};

/**
 * Ghost-text state, and the switch for it.
 *
 * The mode belongs here because this is where the user finds out it exists:
 * a suggestion that takes two seconds needs to say it is coming, and a
 * provider that is signed out needs to say that instead of showing nothing.
 */
function InlineAiChip() {
  const mode = useSettings((s) => s.inlineAi);
  const update = useSettings((s) => s.update);
  const state = useInlineAi((s) => s.state);
  const t = useT();

  const next = INLINE_AI_MODES[(INLINE_AI_MODES.indexOf(mode) + 1) % INLINE_AI_MODES.length] ?? "manual";
  const tone =
    state.kind === "failed" ? "text-danger" : state.kind === "thinking" ? "text-accent" : "text-muted";

  return (
    <button
      onClick={() => {
        update({ inlineAi: next });
      }}
      title={
        state.kind === "failed"
          ? t("ai.inline.failed", { reason: state.reason })
          : `${t(`settings.inlineAi.${mode}`)} - ${t("ai.inline.switch", { mode: t(`settings.inlineAi.${next}.short`) })}`
      }
      className={`flex items-center gap-1 rounded px-1 hover:bg-elevated hover:text-fg ${tone}`}
    >
      {state.kind === "thinking" ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
      {t(`settings.inlineAi.${mode}.short`)}
    </button>
  );
}

export function StatusBar() {
  const rootPath = useWorkspace((s) => s.rootPath);
  const { running, totalCostUsd, sessionId, providerId } = useAi();
  const { tasks, run: runTask, runKind, discovering, rejected } = useTasks();
  const setInstallerTools = useLayout((s) => s.setInstallerTools);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const [taskMenu, setTaskMenu] = useState<{ x: number; y: number } | null>(null);
  const { theme, toggle } = useTheme();
  const { locale, setLocale } = useI18n();
  const { sidebarVisible, aiPanelVisible, bottomVisible, toggleSidebar, toggleAiPanel, toggleBottomPanel } =
    useLayout();
  const toggleHelp = useLayout((s) => s.toggleHelp);
  const setSidebarView = useLayout((s) => s.setSidebarView);
  const gitStatus = useGit((s) => s.status);
  const openFilePath = useWorkspace((s) => s.openFilePath);
  const lspLanguages = useLsp((s) => s.languages);
  const setupRunning = useSetup((s) => s.running);
  const setupSubject = useSetup((s) => s.subject);
  const t = useT();

  // Code intelligence for the file in front of the user: silent when it just
  // works, and explicit about what to install when it cannot.
  const openLanguage = openFilePath ? languageOf(openFilePath) : null;
  const lsp = openLanguage ? lspLanguages[openLanguage] : undefined;
  const lspRestoring = useLsp((s) => (openLanguage !== null ? (s.restoring[openLanguage] ?? false) : false));

  // The menu offers the five OUTCOMES. Aime detects the common stacks itself;
  // for everything else - Maven, CMake, a team's own script - the outcome is
  // still exactly what the user wants, so the entry is there either way and
  // reading the project is a step *inside* it, not a second button the user
  // has to know about (ARCHITECTURE.md §5).
  const taskItems: (MenuItem | typeof SEPARATOR)[] = TASK_KINDS.flatMap((kind) => {
    const Icon = TASK_ICONS[kind];
    const known = tasks.filter((task) => task.kind === kind);
    if (known.length > 0) {
      return known.map((task) => ({
        label: task.label,
        icon: <Icon size={13} className="text-accent" />,
        onClick: () => void runTask(task),
      }));
    }
    const looking = discovering === kind;
    return [
      {
        label: looking ? t("tasks.working", { kind: t(TASK_LABELS[kind]) }) : t(TASK_LABELS[kind]),
        icon: looking ? (
          <Loader2 size={13} className="animate-spin text-accent" />
        ) : (
          <Icon size={13} className="text-muted" />
        ),
        onClick: () => void runKind(kind),
      },
    ];
  });
  if (rejected.length > 0) {
    taskItems.push(SEPARATOR, ...rejected.map((reason) => ({ label: reason, onClick: () => undefined })));
  }

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
              onClick={toggleBottomPanel}
              className={`rounded px-1 py-0.5 hover:bg-elevated hover:text-fg ${bottomVisible ? "text-accent" : ""}`}
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
        {/* A setup run outlives its modal - closing that window backgrounds the
            work, so this is how it is found again. */}
        {setupRunning && (
          <button
            onClick={() => {
              useSetup.setState({ open: true });
            }}
            title={t("setup.progressHint")}
            className="flex items-center gap-1 text-accent"
          >
            <Loader2 size={11} className="animate-spin" />
            {t("setup.progressTitle", { subject: setupSubject ?? "" })}
          </button>
        )}
        {sessionId && (
          <span title={`Session ${sessionId}`}>
            {t("status.session")}: {sessionId.slice(0, 8)}
          </span>
        )}
        <InlineAiChip />
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
                  : lspRestoring
                    ? t("lsp.restoring", { language: openLanguage })
                    : t("lsp.running", { language: openLanguage })
            }
          >
            {lspRestoring ? <Loader2 size={11} className="animate-spin" /> : <Braces size={11} />}
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
