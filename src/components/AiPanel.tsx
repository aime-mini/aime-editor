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
  RefreshCw,
  SendHorizontal,
  Shield,
  ShieldOff,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { useT } from "../i18n";
import { useAi } from "../stores/ai";
import { useLayout } from "../stores/layout";
import { runInTerminal } from "../stores/terminals";
import { useWorkspace } from "../stores/workspace";
import { ContextMenu, type MenuItem } from "./ContextMenu";
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

/** How long the "already signed in" confirmation stays on screen. */
const SIGNED_IN_NOTICE_MS = 4000;

const SUGGESTION_KEYS: TranslationKey[] = [
  "ai.suggestion.summarize",
  "ai.suggestion.findBugs",
  "ai.suggestion.readme",
];

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
  const current = options.find((o) => o.value === value) ?? options[0];

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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const t = useT();
  return (
    <div className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[92%] rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap ${
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
            <span
              key={i}
              className="my-1 flex w-fit items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-0.5 font-mono text-[11px] text-muted"
              title={part.detail}
            >
              <Wrench size={11} className="shrink-0 text-accent" />
              {part.name}
              {part.detail && <span className="max-w-52 truncate">· {part.detail}</span>}
            </span>
          ),
        )}
      </div>
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
  const [historyMenu, setHistoryMenu] = useState<{ x: number; y: number } | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [signedInConfirmed, setSignedInConfirmed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const capabilities = capabilitiesOf(providerId);
  // Built-in providers keep their capability table; a configured one is named
  // by its own config, so the picker shows whatever the user called it.
  const providerOptions: ProviderOption[] = providers.map((provider) => ({
    value: provider.id,
    label: provider.displayName,
  }));

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

  const submit = () => {
    const prompt = input.trim();
    if (!prompt || running || !rootPath || !inputEnabled) return;
    setInput("");
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
              className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
            >
              <KeyRound size={12} /> {t("ai.signIn")}
            </button>
            {recheckButton}
          </ProviderNotice>
        )}
        {messages.length === 0 && (
          <div className="mt-6 flex flex-col gap-2">
            <p className="text-center text-muted">{t("ai.emptyPrompt")}</p>
            {SUGGESTION_KEYS.map((key) => (
              <button
                key={key}
                onClick={() => {
                  if (rootPath) void sendPrompt(t(key), rootPath);
                }}
                disabled={!rootPath || running}
                className="rounded-lg border border-line px-3 py-2 text-left text-muted hover:border-accent hover:text-fg disabled:opacity-50"
              >
                {t(key)}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {lastError && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
            {lastError}
          </div>
        )}
      </div>

      <div className="border-t border-line p-2.5">
        <div className="flex items-end gap-1.5 rounded-lg border border-line bg-elevated px-2 py-1.5 focus-within:border-accent">
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={rootPath ? t("ai.inputPlaceholder") : t("ai.inputPlaceholderNoFolder")}
            disabled={!inputEnabled}
            rows={2}
            className="max-h-40 flex-1 resize-none bg-transparent outline-none placeholder:text-muted disabled:opacity-50"
          />
          {running ? (
            <button
              onClick={() => void cancel()}
              className="rounded p-1.5 text-danger hover:bg-panel"
              title={t("ai.stop")}
            >
              <CircleStop size={16} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!input.trim() || !inputEnabled}
              className="rounded p-1.5 text-accent hover:bg-panel disabled:opacity-40"
              title={t("ai.send")}
            >
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
