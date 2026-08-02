import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, Loader2, TriangleAlert, X } from "lucide-react";
import { useT } from "../i18n";

/** Mirror of the Rust `ToolStatus` (environment.rs). */
interface ToolStatus {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  signedIn: boolean | null;
  installHint: string;
  required: boolean;
}

type Readiness = "ready" | "attention" | "missing";

function readinessOf(tool: ToolStatus): Readiness {
  if (!tool.installed) return tool.required ? "missing" : "attention";
  return tool.signedIn === false ? "attention" : "ready";
}

const ICONS: Record<Readiness, typeof Check> = {
  ready: Check,
  attention: TriangleAlert,
  missing: X,
};

const TONES: Record<Readiness, string> = {
  ready: "text-ok",
  attention: "text-warn",
  missing: "text-danger",
};

/** The command that fixes a row, or null when there is nothing to fix. */
function actionFor(tool: ToolStatus): string | null {
  if (!tool.installed) return tool.installHint;
  if (tool.signedIn === false) return tool.id === "codex" ? "codex login" : "claude auth login";
  return null;
}

function ToolRow({ tool }: { tool: ToolStatus }) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  const readiness = readinessOf(tool);
  const Icon = ICONS[readiness];
  const action = actionFor(tool);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      <Icon size={12} className={`shrink-0 ${TONES[readiness]}`} />
      <span className="w-28 shrink-0 truncate">{tool.label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
        {action ?? tool.version ?? ""}
      </span>
      {action && (
        <button
          onClick={() => {
            void navigator.clipboard.writeText(action);
            setCopied(true);
          }}
          title={t("env.copy")}
          className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
        </button>
      )}
    </div>
  );
}

/**
 * What this machine has, shown before any folder is open.
 *
 * Aime never installs anything on the user's behalf; it reports honestly and
 * hands over the exact command. A missing AI CLI is a warning, not an error -
 * the editor works without one (ARCHITECTURE.md §1.6).
 */
export function EnvironmentCheck() {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [servers, setServers] = useState<ToolStatus[]>([]);
  const t = useT();

  useEffect(() => {
    let stale = false;
    void Promise.all([
      invoke<ToolStatus[]>("environment_report"),
      invoke<ToolStatus[]>("language_server_report"),
    ])
      .then(([reported, reportedServers]) => {
        if (stale) return;
        setTools(reported);
        setServers(reportedServers);
      })
      .catch((err: unknown) => {
        console.error("environment check failed:", err);
        if (!stale) setTools([]);
      });
    return () => {
      stale = true;
    };
  }, []);

  return (
    <section className="mt-8">
      <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t("env.title")}</h2>
      {tools === null ? (
        <p className="mt-3 flex items-center gap-2 text-[12px] text-muted">
          <Loader2 size={12} className="animate-spin" /> {t("env.checking")}
        </p>
      ) : (
        <div className="mt-2 rounded-lg border border-line px-3 py-2">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
          {servers.length > 0 && (
            <>
              <p className="mt-2 mb-0.5 text-[10px] font-semibold tracking-wider text-muted uppercase">
                {t("env.languageServers")}
              </p>
              {servers.map((server) => (
                <ToolRow key={server.id} tool={server} />
              ))}
            </>
          )}
          <p className="mt-2 text-[10px] text-muted">{t("env.hint")}</p>
        </div>
      )}
    </section>
  );
}
