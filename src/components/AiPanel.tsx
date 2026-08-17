import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Brain,
  Check,
  ChevronDown,
  CircleStop,
  Cpu,
  Eye,
  History,
  KeyRound,
  MessageSquare,
  Plug,
  Plus,
  Loader2,
  RefreshCw,
  SendHorizontal,
  Shield,
  ShieldOff,
  SlidersHorizontal,
  Undo2,
  Wrench,
} from "lucide-react";
import { useT } from "../i18n";
import { hasReadme, startersFor } from "../lib/aiStarters";
import { fuzzyFilter } from "../lib/fuzzy";
import { activeMention, applyMention } from "../lib/mentions";
import { projectFiles } from "../lib/projectFiles";
import { useGit } from "../stores/git";
import { useTasks } from "../stores/tasks";
import { useAi } from "../stores/ai";
import { useLayout } from "../stores/layout";
import { runInTerminal } from "../stores/terminals";
import { useWorkspace } from "../stores/workspace";
import { Panel, PanelGroup } from "react-resizable-panels";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ResizeHandle } from "./ResizeHandle";
import { capabilitiesOf, effortsOf, type ProviderOption } from "../lib/providers";
import type { ChatMessage, Permission, TokenUsage } from "../lib/types";
import type { TranslationKey } from "../i18n/en";

/**
 * The three permission levels, in the order the shield chip cycles through.
 * Colour follows risk, not "on/off": the least guarded level is the one that
 * stands out.
 */
const PERMISSION_UI: Record<Permission, { icon: typeof Shield; className: string; label: TranslationKey }> = {
  full: { icon: ShieldOff, className: "text-warn", label: "ai.permission.full" },
  edits: { icon: Shield, className: "text-accent", label: "ai.permission.edits" },
  readOnly: { icon: Eye, className: "text-muted", label: "ai.permission.readOnly" },
};

/** Files offered at once for an `@` mention - a list, not a directory listing. */
const MENTION_LIMIT = 8;

/** Stable empty list: a fresh array every render would re-run everything. */
const NO_FILES: string[] = [];

/** How long the "already signed in" confirmation stays on screen. */
const SIGNED_IN_NOTICE_MS = 4000;

/**
 * The shortest the prompt box can be without losing anything.
 *
 * Its own content sets this: the border above it, 10px of padding twice, the
 * box's border, 6px of inner padding twice, and the 28px send button - about
 * 63px, so 72 leaves a line of text visible next to the button.
 */
const COMPOSER_FLOOR_PX = 72;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Compact chip + styled menu for the model / effort pickers — a native
 * <select> can't be themed, so this reuses the app's own ContextMenu look.
 */
function PickerChip({
  icon,
  value,
  options,
  title,
  onChange,
}: {
  icon: ReactNode;
  value: string;
  options: ProviderOption[];
  title: string;
  onChange: (value: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Options can be empty for a moment while they load from the backend; a
  // picker with nothing in it is a picker, not a crash.
  const current = options.find((o) => o.value === value) ?? options.at(0) ?? { value, label: value };

  return (
    <>
      <button
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        title={title}
        className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[11px] leading-none whitespace-nowrap text-muted hover:bg-elevated hover:text-fg"
      >
        <span className="flex shrink-0 items-center overflow-visible">{icon}</span>
        <span className="font-medium">{current.label}</span>
        <ChevronDown size={10} className="shrink-0 opacity-60" />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={options.map((o) => ({
            label: o.label,
            icon:
              o.value === value ? (
                <Check size={13} className="text-accent" />
              ) : (
                <span className="inline-block w-[13px]" />
              ),
            onClick: () => {
              onChange(o.value);
            },
          }))}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </>
  );
}

/** One click moves the agent to the next permission level. */
function PermissionChip({ permission, onCycle }: { permission: Permission; onCycle: () => void }) {
  const t = useT();
  const { icon: Icon, className, label } = PERMISSION_UI[permission];
  return (
    <button
      onClick={onCycle}
      title={t(label)}
      className="flex h-[22px] items-center rounded-md px-1.5 text-muted hover:bg-elevated hover:text-fg"
    >
      <Icon size={13} className={`shrink-0 ${className}`} />
    </button>
  );
}

/** Session usage breakdown, opened from the Activity button. */
function UsagePopover({
  usage,
  costUsd,
  showCost,
  onClose,
}: {
  usage: TokenUsage;
  costUsd: number;
  /** false for subscription CLIs that report no price — never show a fake $0. */
  showCost: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const rows: [string, string][] = [
    [t("ai.usage.input"), formatTokens(usage.inputTokens)],
    [t("ai.usage.output"), formatTokens(usage.outputTokens)],
    [t("ai.usage.cacheRead"), formatTokens(usage.cacheReadTokens)],
    [t("ai.usage.cacheWrite"), formatTokens(usage.cacheWriteTokens)],
    ...(showCost ? [[t("ai.usage.cost"), `$${costUsd.toFixed(4)}`] as [string, string]] : []),
  ];
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute top-16 right-3 w-52 rounded-lg border border-line bg-elevated p-3 shadow-xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <p className="mb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
          {t("ai.usage.title")}
        </p>
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between py-0.5 text-[12px]">
            <span className="text-muted">{label}</span>
            <span className="font-mono">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Actionable notice about the AI CLI itself (not installed, not signed in).
 * It never disables the editor — AI is optional by design (ARCHITECTURE.md §1.6).
 */
function ProviderNotice({
  tone,
  message,
  children,
}: {
  tone: "danger" | "warn" | "ok";
  message: string;
  children?: ReactNode;
}) {
  const toneClasses = {
    danger: "border-danger/40 bg-danger/10 text-danger",
    warn: "border-warn/40 bg-warn/10 text-warn",
    ok: "border-ok/40 bg-ok/10 text-ok",
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClasses}`}>
      <p>{message}</p>
      {children && <div className="mt-2 flex items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * What a turn did to the project, and how to take it back.
 *
 * The point of an AI editor is that the AI changes your files - which is only
 * comfortable if changing them back is one click. Deliberately worded without
 * a single git term: the user is told how many files moved and offered to undo
 * it, not offered a stash object.
 */
function TurnChanges({ message, index }: { message: ChatMessage; index: number }) {
  const undoTurn = useAi((s) => s.undoTurn);
  const running = useAi((s) => s.running);
  const setSidebarView = useLayout((s) => s.setSidebarView);
  const [undoing, setUndoing] = useState(false);
  const t = useT();

  const changed = message.changedFiles ?? [];
  if (changed.length === 0) return null;

  if (message.undone) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <Undo2 size={11} /> {t("ai.turnUndone", { count: String(changed.length) })}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-muted" title={changed.join("\n")}>
        {t("ai.turnChanged", { count: String(changed.length) })}
      </span>
      <button
        onClick={() => {
          setSidebarView("git");
        }}
        className="rounded-md border border-line px-2 py-0.5 text-muted hover:border-accent hover:text-fg"
      >
        {t("ai.turnReview")}
      </button>
      <button
        onClick={() => {
          setUndoing(true);
          void undoTurn(index).finally(() => {
            setUndoing(false);
          });
        }}
        disabled={running || undoing}
        className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-muted hover:border-warn hover:text-warn disabled:opacity-40"
        title={t("ai.turnUndoHint")}
      >
        {undoing ? <Loader2 size={10} className="animate-spin" /> : <Undo2 size={10} />}
        {t("ai.turnUndo")}
      </button>
    </div>
  );
}

function MessageBubble({ message, index }: { message: ChatMessage; index: number }) {
  const isUser = message.role === "user";
  const t = useT();
  return (
    <div className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
      <div
        // `break-words` because what the AI quotes back is often a path or a
        // URL with no space in it, and a bubble capped at 92% cannot wrap what
        // has no break in it — it just draws past the panel.
        className={`max-w-[92%] rounded-lg px-3 py-2 leading-relaxed break-words whitespace-pre-wrap ${
          isUser ? "bg-accent-soft text-fg" : "bg-elevated text-fg"
        }`}
      >
        {message.parts.length === 0 && !isUser && (
          <span className="animate-pulse text-muted">{t("ai.thinking")}</span>
        )}
        {message.parts.map((part, i) =>
          part.kind === "text" ? (
            <span key={i}>{part.text}</span>
          ) : (
            // A tool call is one line that must fit the bubble: the tool's
            // name always, then as much of the command as there is room for.
            // A fixed cap (it was 13rem) is a width the panel never agreed to
            // — narrow the panel and the chip kept its size and drew over the
            // edge, which is how `cd C:\Projects\…` ran off the screen.
            <span
              key={i}
              className="my-1 flex w-fit max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-0.5 font-mono text-[11px] text-muted"
              title={part.detail}
            >
              <Wrench size={11} className="shrink-0 text-accent" />
              <span className="shrink-0">{part.name}</span>
              {part.detail && <span className="min-w-0 truncate">· {part.detail}</span>}
            </span>
          ),
        )}
      </div>
      <TurnChanges message={message} index={index} />
      {message.costUsd !== undefined && (
        <span className="text-[10px] text-muted">
          ${message.costUsd.toFixed(4)}
          {message.durationMs !== undefined && ` · ${(message.durationMs / 1000).toFixed(1)}s`}
        </span>
      )}
    </div>
  );
}

export function AiPanel() {
  const {
    messages,
    running,
    lastError,
    sendPrompt,
    cancel,
    newSession,
    resumeSession,
    history,
    localId,
    providerId,
    setProvider,
    model,
    effort,
    setModel,
    setEffort,
    permission,
    cyclePermission,
    sessionUsage,
    totalCostUsd,
    providerHealth,
    signedIn,
    loginCommand,
    checkHealth,
    watchSignIn,
    providers,
    loadProviders,
  } = useAi();
  const rootPath = useWorkspace((s) => s.rootPath);
  const [input, setInput] = useState("");
  const [fileIndex, setFileIndex] = useState<{ root: string; files: string[] } | null>(null);
  /** Where the caret is: the composer needs it during render, and reading a
   *  ref while rendering is a lie waiting for the next paint. */
  const [caret, setCaret] = useState(0);
  /** Which mention suggestion is selected, or null when the picker is closed. */
  const [mentionIndex, setMentionIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [historyMenu, setHistoryMenu] = useState<{ x: number; y: number } | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [signedInConfirmed, setSignedInConfirmed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelsRef = useRef<HTMLDivElement>(null);
  /**
   * The smallest the prompt box may be dragged, as a percentage.
   *
   * The panel library speaks only percentages, and a percentage floor is the
   * wrong floor: on a short window 10% is less than the box's own content, and a
   * panel clips what does not fit - which showed up as the send button cut off
   * along the bottom edge. So the real floor is `COMPOSER_FLOOR_PX`, converted
   * against the height these panels actually have, and re-converted when the
   * window changes it.
   */
  const [composerFloor, setComposerFloor] = useState(12);
  useEffect(() => {
    const panels = panelsRef.current;
    if (!panels) return;
    const observer = new ResizeObserver(() => {
      const height = panels.getBoundingClientRect().height;
      if (height <= 0) return;
      setComposerFloor(Math.min(50, (COMPOSER_FLOOR_PX / height) * 100));
    });
    observer.observe(panels);
    return () => {
      observer.disconnect();
    };
  }, []);
  const changedFiles = useGit((s) => s.status?.files.length ?? 0);
  const hasTests = useTasks((s) => s.tasks.some((task) => task.kind === "test"));
  const openFilePath = useWorkspace((s) => s.openFilePath);
  const t = useT();
  const capabilities = capabilitiesOf(providerId);
  // Built-in providers keep their capability table; a configured one is named
  // by its own config, so the picker shows whatever the user called it.
  const providerOptions: ProviderOption[] =
    providers.length > 0
      ? providers.map((provider) => ({ value: provider.id, label: provider.displayName }))
      : // Until the backend answers, the chip still names the provider in use.
        [{ value: providerId, label: capabilities.displayName }];

  const formatWhen = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const historyItems: MenuItem[] =
    history.length === 0
      ? [{ label: t("ai.historyEmpty"), onClick: () => undefined }]
      : history.map((s) => ({
          label: `${s.localId === localId ? "• " : ""}${s.title} · ${formatWhen(s.updatedAt)}`,
          icon: <MessageSquare size={13} />,
          onClick: () => {
            resumeSession(s.localId);
          },
        }));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Cheap install + sign-in probe per panel mount and on every provider switch,
  // so the user is guided before the first prompt instead of after a failure.
  // Re-probing on focus catches the return from a browser sign-in or from an
  // install run in another window — the banner clears itself.
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    void checkHealth();
    const recheck = () => void checkHealth();
    window.addEventListener("focus", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
    };
  }, [checkHealth, providerId]);

  // The "already signed in" answer is a reply to a click, not a lasting state.
  useEffect(() => {
    if (!signedInConfirmed) return;
    const timer = window.setTimeout(() => {
      setSignedInConfirmed(false);
    }, SIGNED_IN_NOTICE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [signedInConfirmed]);

  const signInNeeded = signedIn === false;
  const inputEnabled = rootPath !== null && providerHealth !== "missing" && !signInNeeded;
  const signIn = () => {
    runInTerminal(loginCommand);
    // The CLI signs in on its own schedule; poll until it reports success.
    watchSignIn();
  };
  /** Signing in again would only log the user out of a working session. */
  const signInOrConfirm = () => {
    if (signedIn === true) setSignedInConfirmed(true);
    else signIn();
  };
  const recheckButton = (
    <button
      onClick={() => void checkHealth()}
      className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12px] text-muted hover:text-fg"
    >
      <RefreshCw size={12} /> {t("ai.signInRecheck")}
    </button>
  );

  // One walk of the tree per project, shared with the command palette.
  useEffect(() => {
    if (!rootPath) return;
    let stale = false;
    void projectFiles(rootPath)
      .then((list) => {
        if (!stale) setFileIndex({ root: rootPath, files: list });
      })
      .catch(console.error);
    return () => {
      stale = true;
    };
  }, [rootPath]);

  const files = fileIndex?.root === rootPath ? fileIndex.files : NO_FILES;
  const mention = activeMention(input, caret);
  const mentionMatches =
    mention === null
      ? []
      : fuzzyFilter(files, mention.query, (path) => path, MENTION_LIMIT).map((match) => match.item);
  const pickerOpen = mentionIndex !== null && mentionMatches.length > 0;

  /** Puts the chosen path in the composer and hands the cursor back. */
  const pickMention = (path: string) => {
    if (!mention) return;
    const next = applyMention(input, mention, path);
    setInput(next.text);
    setCaret(next.cursor);
    setMentionIndex(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const starters = startersFor({
    openFileName: openFilePath?.split(/[\\/]/).pop() ?? null,
    changedFiles,
    hasTests,
    hasReadme: hasReadme(files),
  });

  const submit = () => {
    const prompt = input.trim();
    if (!prompt || running || !rootPath || !inputEnabled) return;
    setInput("");
    setMentionIndex(null);
    void sendPrompt(prompt, rootPath);
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="flex items-center gap-1">
          <PickerChip
            icon={<Bot size={14} className="text-accent" />}
            value={providerId}
            options={providerOptions}
            title={t("ai.provider")}
            onChange={(next) => {
              setSignedInConfirmed(false); // it described the previous CLI
              setProvider(next);
            }}
          />
          <button
            onClick={signInOrConfirm}
            title={
              signedIn === true
                ? t("ai.signedIn", { provider: capabilities.displayName })
                : t("ai.signInWith", { command: loginCommand })
            }
            className="flex h-[22px] items-center rounded-md px-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <KeyRound
              size={13}
              className={`shrink-0 ${signedIn === true ? "text-ok" : signInNeeded ? "text-warn" : ""}`}
            />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHistoryMenu({ x: rect.right, y: rect.bottom + 4 });
            }}
            disabled={running}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-elevated disabled:opacity-50"
            title={t("ai.history")}
          >
            <History size={12} />
          </button>
          <button
            onClick={newSession}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-elevated"
            title={t("ai.newSession")}
          >
            <Plus size={12} /> {t("ai.newSession")}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-3 py-1.5">
        <div className="flex items-center gap-1">
          <PickerChip
            icon={<Cpu size={12} className="text-accent" />}
            value={model}
            options={capabilities.models}
            title={t("ai.model")}
            onChange={setModel}
          />
          <PickerChip
            icon={<SlidersHorizontal size={12} className="text-accent" />}
            value={effort}
            options={effortsOf(providerId, model)}
            title={t("ai.effort")}
            onChange={setEffort}
          />
          <button
            onClick={() => {
              useLayout.getState().setMemoryOpen(true);
            }}
            title={t("cmd.editMemory")}
            className="flex h-[22px] items-center rounded-md px-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <Brain size={13} className="shrink-0" />
          </button>
          <button
            onClick={() => {
              useLayout.getState().setMcpOpen(true);
            }}
            title={t("cmd.manageMcp")}
            className="flex h-[22px] items-center rounded-md px-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <Plug size={13} className="shrink-0" />
          </button>
          <PermissionChip permission={permission} onCycle={cyclePermission} />
        </div>
        <button
          onClick={() => {
            setUsageOpen(true);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-elevated hover:text-fg"
          title={t("ai.usage.title")}
        >
          <Activity size={12} />
          {formatTokens(sessionUsage.inputTokens + sessionUsage.outputTokens)}
        </button>
      </div>

      {usageOpen && (
        <UsagePopover
          usage={sessionUsage}
          costUsd={totalCostUsd}
          showCost={capabilities.reportsCost}
          onClose={() => {
            setUsageOpen(false);
          }}
        />
      )}

      {historyMenu && (
        <ContextMenu
          x={historyMenu.x}
          y={historyMenu.y}
          items={historyItems}
          onClose={() => {
            setHistoryMenu(null);
          }}
        />
      )}

      {/*
       * Two panels with a divider: how much room the box you type in gets is the
       * user's call, not a fixed two rows. Sizes belong to the panel library
       * (`autoSaveId`), so where this is dragged is remembered like every other
       * divider in the app - the same arrangement as Changes/History in Git.
       */}
      <div ref={panelsRef} className="flex min-h-0 flex-1 flex-col">
        <PanelGroup direction="vertical" autoSaveId="aime-ai-panel" className="min-h-0 flex-1">
          <Panel id="ai-messages" order={1} minSize={25} className="flex flex-col">
            <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
              {providerHealth === "missing" && (
                <ProviderNotice
                  tone="danger"
                  message={t("ai.cliNotFound", {
                    provider: capabilities.displayName,
                    install: capabilities.installCommand,
                  })}
                >
                  {recheckButton}
                </ProviderNotice>
              )}
              {signedInConfirmed && signedIn === true && (
                <ProviderNotice
                  tone="ok"
                  message={t("ai.signedInAlready", { provider: capabilities.displayName })}
                />
              )}
              {signInNeeded && (
                <ProviderNotice
                  tone="warn"
                  message={t("ai.signInRequired", { provider: capabilities.displayName })}
                >
                  <button
                    onClick={signIn}
                    className="flex items-center gap-1.5 rounded-md bg-accent-strong px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
                  >
                    <KeyRound size={12} /> {t("ai.signIn")}
                  </button>
                  {/* The other door in: an API key pasted in Settings works
                      without any browser round-trip (providers that take one). */}
                  {providers.find((p) => p.id === providerId)?.apiKeyRoute != null && (
                    <button
                      onClick={() => {
                        useLayout.getState().setSettingsOpen(true);
                      }}
                      className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12px] text-muted hover:text-fg"
                    >
                      {t("ai.useApiKey")}
                    </button>
                  )}
                  {recheckButton}
                </ProviderNotice>
              )}
              {messages.length === 0 && (
                <div className="mt-6 flex flex-col gap-2">
                  <p className="text-center text-muted">{t("ai.emptyPrompt")}</p>
                  {starters.map((starter) => (
                    <button
                      key={starter.key}
                      onClick={() => {
                        if (rootPath) void sendPrompt(t(starter.promptKey, starter.params), rootPath);
                      }}
                      disabled={!rootPath || running}
                      className="rounded-lg border border-line px-3 py-2 text-left text-muted hover:border-accent hover:text-fg disabled:opacity-50"
                    >
                      {t(starter.key, starter.params)}
                    </button>
                  ))}
                  <p className="mt-1 text-center text-[11px] text-muted">{t("ai.mentionHint")}</p>
                </div>
              )}
              {messages.map((m, i) => (
                <MessageBubble key={i} message={m} index={i} />
              ))}
              {lastError && (
                <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
                  {lastError}
                </div>
              )}
            </div>
          </Panel>

          <ResizeHandle horizontal />

          {/*
           * Starts at about the two rows it used to be fixed at: the point is being
           * able to drag it, not being handed more room than was asked for. The floor
           * is `composerFloor` - a real pixel height turned into the percentage this
           * library speaks - and the ceiling stops it swallowing the conversation.
           */}
          <Panel
            id="ai-composer"
            order={2}
            minSize={composerFloor}
            maxSize={60}
            defaultSize={Math.max(11, composerFloor)}
            className="flex flex-col"
          >
            <div className="relative flex min-h-0 flex-1 flex-col border-t border-line p-2.5">
              {pickerOpen && (
                <ul className="absolute bottom-full left-2.5 z-20 mb-1 w-[calc(100%-1.25rem)] overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
                  {mentionMatches.map((path, i) => (
                    <li key={path}>
                      <button
                        onMouseDown={(e) => {
                          // Down, not click: the textarea must not lose focus first.
                          e.preventDefault();
                          pickMention(path);
                        }}
                        className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-[12px] ${
                          i === mentionIndex ? "bg-accent-strong text-white" : "hover:bg-elevated"
                        }`}
                      >
                        <span className="truncate">{path.split(/[\\/]/).pop()}</span>
                        <span className="min-w-0 flex-1 truncate text-right text-[10.5px] opacity-60">
                          {path}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex min-h-0 flex-1 items-stretch gap-1.5 rounded-lg border border-line bg-elevated px-2 py-1.5 focus-within:border-accent">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    setCaret(e.target.selectionStart);
                    // Typing `@` opens the picker; typing past every match closes it.
                    setMentionIndex(activeMention(e.target.value, e.target.selectionStart) ? 0 : null);
                  }}
                  onSelect={(e) => {
                    setCaret(e.currentTarget.selectionStart);
                  }}
                  onKeyDown={(e) => {
                    if (pickerOpen) {
                      const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
                      if (move !== 0) {
                        e.preventDefault();
                        setMentionIndex((current) => {
                          const at = (current ?? 0) + move;
                          return (at + mentionMatches.length) % mentionMatches.length;
                        });
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        // Safe: the picker is only open with a selected match, and
                        // every keystroke resets the selection to the first one.
                        pickMention(mentionMatches[mentionIndex]);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setMentionIndex(null);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={rootPath ? t("ai.inputPlaceholder") : t("ai.inputPlaceholderNoFolder")}
                  disabled={!inputEnabled}
                  // No `rows`, no `max-h`: the panel above decides how tall this is, and
                  // the browser's own corner grip would fight the divider for it.
                  className="min-h-0 flex-1 resize-none bg-transparent outline-none placeholder:text-muted disabled:opacity-50"
                />
                {running ? (
                  <button
                    onClick={() => void cancel()}
                    className="self-end rounded p-1.5 text-danger hover:bg-panel"
                    title={t("ai.stop")}
                  >
                    <CircleStop size={16} />
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={!input.trim() || !inputEnabled}
                    className="self-end rounded p-1.5 text-accent hover:bg-panel disabled:opacity-40"
                    title={t("ai.send")}
                  >
                    <SendHorizontal size={16} />
                  </button>
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
