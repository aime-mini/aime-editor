import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Cpu, Eye, Monitor, Settings2, Shield, ShieldOff, Sparkles, X } from "lucide-react";
import { useI18n, useT } from "../i18n";
import { errorLogPath } from "../lib/diagnostics";
import { buildAddProviderPrompt } from "../lib/aiProvider";
import { capabilitiesOf, effortsOf } from "../lib/providers";
import { PERMISSION_ORDER, type Permission } from "../lib/types";
import { PluginsSection } from "./PluginsSection";
import { useAi, type ApiKeyRoute } from "../stores/ai";
import { INLINE_AI_MODES, UPDATE_CHANNELS, useSettings } from "../stores/settings";
import { useSetup } from "../stores/setup";
import { useTheme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";

/** One labelled row, so every setting reads the same way. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px]">{label}</p>
        {hint && <p className="text-[11px] text-muted">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A row of mutually exclusive choices - clearer than a dropdown for two or three. */
function Choice<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-line">
      {options.map((option) => (
        <button
          key={String(option.value)}
          onClick={() => {
            onChange(option.value);
          }}
          className={`px-2 py-1 text-[11.5px] ${
            option.value === value
              ? "bg-accent-strong text-white"
              : "text-muted hover:bg-elevated hover:text-fg"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  return (
    <Choice
      options={[
        { value: "on", label: t("settings.on") },
        { value: "off", label: t("settings.off") },
      ]}
      value={on ? "on" : "off"}
      onChange={(next) => {
        onChange(next === "on");
      }}
    />
  );
}

/**
 * What Aime knows about the key it just handed over: nothing yet (`idle`), not
 * yet answered (`pending`), or the CLI's own answer — it is using a key, it is
 * not, or it does not say.
 */
type Verdict = "idle" | "pending" | "confirmed" | "notSeen" | "unknown";

/** `ApiKeyOutcome.cliConfirmed` stringified — true / false / null. */
const VERDICT_OF: Record<string, Verdict> = {
  true: "confirmed",
  false: "notSeen",
  null: "unknown",
};

const VERDICT_MESSAGE = {
  confirmed: "settings.apiKeyConfirmed",
  notSeen: "settings.apiKeyNotSeen",
  unknown: "settings.apiKeyUnverified",
} as const;

const VERDICT_TONE = {
  confirmed: "text-ok",
  notSeen: "text-warn",
  unknown: "text-muted",
} as const;

/**
 * The API key for the current provider, write-only.
 *
 * The key goes to Rust and never comes back: this row only ever learns
 * *whether* one is stored (`apiKeyConfigured`, from the health probe), so a
 * saved key cannot be read out of the settings page or the store.
 *
 * The two routes are not the same offer and are not worded as one. On the `env`
 * route Aime keeps the key and passes it to its own runs, leaving the CLI's own
 * login alone — that is reversible with Remove. On the `cliLogin` route the key
 * goes into the CLI's own credential store and **replaces** what it was signed
 * in with (measured on Codex: a ChatGPT login became an API-key login), so it is
 * confirmed first and only the CLI can undo it.
 */
function ApiKeyRow({ route }: { route: ApiKeyRoute }) {
  const apiKeyConfigured = useAi((s) => s.apiKeyConfigured);
  const loginCommand = useAi((s) => s.loginCommand);
  const setApiKey = useAi((s) => s.setApiKey);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>("idle");
  const t = useT();
  const placeholder = route.kind === "env" ? route.variable : t("settings.apiKey");

  const submit = (key: string) => {
    setError(null);
    setConfirming(false);
    setVerdict("pending");
    setApiKey(key)
      .then((outcome) => {
        setDraft("");
        // Removing a key is not a claim about anything — only a key that was
        // handed over gets a verdict.
        setVerdict(key.trim() ? VERDICT_OF[String(outcome.cliConfirmed)] : "idle");
      })
      .catch((err: unknown) => {
        setVerdict("idle");
        setError(String(err));
      });
  };

  const stored = route.kind === "env" && apiKeyConfigured;
  const hint =
    route.kind === "env"
      ? t("settings.apiKeyHint", { env: route.variable })
      : t("settings.apiKeyHintCli", { command: loginCommand });

  return (
    <>
      <Row label={t("settings.apiKey")} hint={hint}>
        {stored ? (
          <>
            <span className="flex items-center gap-1 text-[11.5px] text-ok">
              <Check size={12} /> {t("settings.apiKeySaved")}
            </span>
            <button
              onClick={() => {
                submit("");
              }}
              className="rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:text-fg"
            >
              {t("settings.apiKeyClear")}
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setConfirming(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !draft.trim()) return;
                if (route.kind === "cliLogin" && !confirming) setConfirming(true);
                else submit(draft);
              }}
              placeholder={placeholder}
              autoComplete="off"
              className="w-44 rounded-md border border-line bg-elevated px-2 py-1 text-[11.5px] outline-none focus:border-accent"
            />
            <button
              onClick={() => {
                // The CLI route overwrites a credential Aime does not own, so
                // the first click asks and the second one does it.
                if (route.kind === "cliLogin" && !confirming) setConfirming(true);
                else submit(draft);
              }}
              disabled={!draft.trim() || verdict === "pending"}
              className="rounded-md bg-accent-strong px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {confirming ? t("settings.apiKeyReplace") : t("settings.apiKeySave")}
            </button>
          </>
        )}
      </Row>
      {confirming && <p className="pb-1 text-[11px] text-warn">{t("settings.apiKeyReplaceWarning")}</p>}
      {verdict !== "idle" && verdict !== "pending" && (
        <p className={`pb-1 text-[11px] ${VERDICT_TONE[verdict]}`}>{t(VERDICT_MESSAGE[verdict])}</p>
      )}
      {error && <p className="pb-1 text-[11px] text-danger">{error}</p>}
    </>
  );
}

/**
 * Teaching Aime an AI CLI it has never heard of, without opening a JSON file.
 *
 * The user names the CLI; the agent probes the real binary and writes the entry
 * (`buildAddProviderPrompt`), and Aime notices the file changing and re-reads it
 * — so the new provider appears in the picker above with no restart. Editing
 * `providers.json` by hand still works and is one click away, for anyone who
 * would rather do it themselves.
 */
function AddProviderRow() {
  const [wanted, setWanted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rootPath = useWorkspace((s) => s.rootPath);
  const t = useT();

  const submit = () => {
    const name = wanted.trim();
    if (!name || rootPath === null) return;
    setError(null);
    invoke<string>("providers_config_path")
      .then((configPath) =>
        useSetup.getState().startJob({
          subject: name,
          prompt: buildAddProviderPrompt({ wanted: name, configPath }),
          // The config watcher reloads on its own; this covers the run that
          // finished after a change the watcher had already coalesced.
          onSuccess: () => void useAi.getState().loadProviders(),
        }),
      )
      .then(() => {
        setWanted("");
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
  };

  return (
    <>
      <Row
        label={t("settings.addProvider")}
        hint={rootPath === null ? t("settings.addProviderNeedsFolder") : t("settings.addProviderHint")}
      >
        <input
          value={wanted}
          onChange={(e) => {
            setWanted(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={t("settings.addProviderPlaceholder")}
          className="w-44 rounded-md border border-line bg-elevated px-2 py-1 text-[11.5px] outline-none focus:border-accent"
        />
        <button
          onClick={submit}
          disabled={!wanted.trim() || rootPath === null}
          className="flex items-center gap-1 rounded-md bg-accent-strong px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <Sparkles size={12} /> {t("setup.ai")}
        </button>
      </Row>
      {error && <p className="pb-1 text-[11px] text-danger">{error}</p>}
    </>
  );
}

const PERMISSION_LABELS: Record<Permission, string> = {
  full: "settings.permission.full",
  edits: "settings.permission.edits",
  readOnly: "settings.permission.readOnly",
};

/**
 * Everything adjustable, in one searchable-by-eye page (ARCHITECTURE.md §6).
 *
 * The same settings exist as chips and toggles where they are used - the
 * shield in the AI panel, the theme in the status bar - because the fastest
 * place to change something is where you noticed it. This page is for the
 * person who has not found those yet, which is most people on day one.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const { theme, toggle: toggleTheme } = useTheme();
  const { locale, setLocale } = useI18n();
  const { providerId, setProvider, providers, model, setModel, effort, setEffort, permission } = useAi();
  const cyclePermission = useAi((s) => s.cyclePermission);
  const rootPath = useWorkspace((s) => s.rootPath);
  const openFile = useWorkspace((s) => s.openFile);
  const t = useT();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const capabilities = capabilitiesOf(providerId);
  const apiKeyRoute = providers.find((provider) => provider.id === providerId)?.apiKeyRoute ?? null;
  const section =
    "mt-3 mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[620px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <Settings2 size={15} className="shrink-0 text-accent" />
          <span className="flex-1 text-xs font-semibold">{t("settings.title")}</span>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <p className={section}>
            <Monitor size={12} /> {t("settings.appearance")}
          </p>
          <Row label={t("settings.theme")}>
            <Choice
              options={[
                { value: "dark", label: t("settings.dark") },
                { value: "light", label: t("settings.light") },
              ]}
              value={theme}
              onChange={(next) => {
                if (next !== theme) toggleTheme();
              }}
            />
          </Row>
          <Row label={t("settings.language")}>
            <Choice
              options={[
                { value: "en", label: "English" },
                { value: "vi", label: "Tiếng Việt" },
              ]}
              value={locale}
              onChange={setLocale}
            />
          </Row>

          <p className={section}>
            <Eye size={12} /> {t("settings.editor")}
          </p>
          <Row label={t("settings.fontSize")}>
            <Choice
              options={[12, 13, 14, 16, 18].map((size) => ({ value: size, label: String(size) }))}
              value={settings.fontSize}
              onChange={(fontSize) => {
                settings.update({ fontSize });
              }}
            />
          </Row>
          <Row label={t("settings.wordWrap")} hint={t("settings.wordWrapHint")}>
            <Toggle
              on={settings.wordWrap}
              onChange={(wordWrap) => {
                settings.update({ wordWrap });
              }}
            />
          </Row>
          <Row label={t("settings.minimap")}>
            <Toggle
              on={settings.minimap}
              onChange={(minimap) => {
                settings.update({ minimap });
              }}
            />
          </Row>
          <Row label={t("settings.autoSave")} hint={t("settings.autoSaveHint")}>
            <Toggle
              on={settings.autoSave}
              onChange={(autoSave) => {
                settings.update({ autoSave });
              }}
            />
          </Row>
          <Row label={t("settings.tabSize")}>
            <Choice
              options={[2, 4, 8].map((size) => ({ value: size, label: String(size) }))}
              value={settings.tabSize}
              onChange={(tabSize) => {
                settings.update({ tabSize });
              }}
            />
          </Row>

          <p className={section}>
            <Cpu size={12} /> {t("settings.ai")}
          </p>
          <Row label={t("ai.provider")}>
            <Choice
              options={(providers.length > 0
                ? providers
                : [{ id: providerId, displayName: capabilities.displayName }]
              ).map((provider) => ({ value: provider.id, label: provider.displayName }))}
              value={providerId}
              onChange={setProvider}
            />
          </Row>
          {apiKeyRoute !== null && <ApiKeyRow key={providerId} route={apiKeyRoute} />}
          <AddProviderRow />
          <Row label={t("ai.model")}>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
              }}
              className="rounded-md border border-line bg-elevated px-2 py-1 text-[11.5px] outline-none"
            >
              {capabilities.models.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t("ai.effort")}>
            <select
              value={effort}
              onChange={(e) => {
                setEffort(e.target.value);
              }}
              className="rounded-md border border-line bg-elevated px-2 py-1 text-[11.5px] outline-none"
            >
              {effortsOf(providerId, model).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t("settings.inlineAi")} hint={t(`settings.inlineAi.${settings.inlineAi}`)}>
            <Choice
              options={INLINE_AI_MODES.map((mode) => ({
                value: mode,
                label: t(`settings.inlineAi.${mode}.short`),
              }))}
              value={settings.inlineAi}
              onChange={(inlineAi) => {
                settings.update({ inlineAi });
              }}
            />
          </Row>
          <Row label={t("settings.permission")} hint={t(`ai.permission.${permission}`)}>
            <button
              onClick={cyclePermission}
              className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg"
            >
              {permission === "full" ? <ShieldOff size={12} className="text-warn" /> : <Shield size={12} />}
              {t(PERMISSION_LABELS[permission] as Parameters<typeof t>[0])}
              <span className="text-[10px] opacity-60">
                {String(PERMISSION_ORDER.indexOf(permission) + 1)}/{String(PERMISSION_ORDER.length)}
              </span>
            </button>
          </Row>

          <p className={section}>
            <Settings2 size={12} /> {t("settings.advanced")}
          </p>
          <Row label={t("settings.updateChannel")} hint={t(`settings.channel.${settings.updateChannel}`)}>
            <Choice
              options={UPDATE_CHANNELS.map((channel) => ({
                value: channel,
                label: t(`settings.channel.${channel}.short`),
              }))}
              value={settings.updateChannel}
              onChange={(updateChannel) => {
                settings.update({ updateChannel });
              }}
            />
          </Row>
          <Row label={t("settings.providersFile")} hint={t("settings.providersFileHint")}>
            <button
              onClick={() => {
                void invoke<string>("providers_config_path")
                  .then((path) => openFile(path))
                  .then(onClose)
                  .catch(console.error);
              }}
              disabled={!rootPath}
              title={rootPath ? undefined : t("settings.needsProject")}
              className="rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg disabled:opacity-40"
            >
              {t("settings.open")}
            </button>
          </Row>
          <PluginsSection />
          <Row label={t("settings.errorLog")} hint={t("settings.errorLogHint")}>
            <button
              onClick={() => {
                void errorLogPath()
                  .then((path) => openFile(path))
                  .then(onClose)
                  .catch(console.error);
              }}
              className="rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg"
            >
              {t("settings.open")}
            </button>
          </Row>
          <Row label={t("settings.resetEditor")}>
            <button
              onClick={settings.reset}
              className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg"
            >
              <Check size={12} /> {t("settings.reset")}
            </button>
          </Row>
        </div>

        <p className="shrink-0 border-t border-line px-4 py-2 text-[10px] text-muted">
          {t("settings.footer")}
        </p>
      </div>
    </div>
  );
}
