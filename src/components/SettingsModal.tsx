import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Cpu, Eye, Monitor, Settings2, Shield, ShieldOff, X } from "lucide-react";
import { useI18n, useT } from "../i18n";
import { capabilitiesOf, effortsOf } from "../lib/providers";
import { PERMISSION_ORDER, type Permission } from "../lib/types";
import { useAi } from "../stores/ai";
import { INLINE_AI_MODES, useSettings } from "../stores/settings";
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
            option.value === value ? "bg-accent text-white" : "text-muted hover:bg-elevated hover:text-fg"
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
