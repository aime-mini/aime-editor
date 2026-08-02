import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, ChevronRight, Copy, Download, Loader2, TriangleAlert, X } from "lucide-react";
import { useT } from "../i18n";
import { supportedLanguageCount } from "../lib/languages";
import { useLayout } from "../stores/layout";
import { useLsp } from "../stores/lsp";

/** TypeScript, JavaScript, HTML, CSS and JSON: Monaco brings their services. */
const BUILT_IN_INTELLISENSE = 5;

/** Remembers that first-launch setup already ran on this machine. */
const SETUP_DONE_KEY = "aime.setupDone";

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
  // A signed-out CLI needs a person at a browser, and a documentation
  // link is not a command - neither is something Aime can run.
  const installable = !tool.installed && !tool.installHint.startsWith("http");

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
      {action && installable && (
        <button
          onClick={() => {
            useLayout.getState().setInstallerTools([tool.id]);
          }}
          title={t("env.install")}
          className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-accent"
        >
          <Download size={11} />
        </button>
      )}
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
/**
 * The highlighted-language count, once Monaco can be asked for it.
 *
 * Monaco is loaded on demand with the editor, and the welcome screen has no
 * editor - so it is fetched here in the background and the line appears when
 * the answer does. Blocking the first screen on four megabytes to print one
 * number would be exactly backwards.
 */
function useLanguageCount(): number {
  const [count, setCount] = useState(supportedLanguageCount);

  useEffect(() => {
    if (count > 0) return;
    let stale = false;
    void import("../lib/monaco")
      .then(() => {
        if (!stale) setCount(supportedLanguageCount());
      })
      .catch(console.error);
    return () => {
      stale = true;
    };
  }, [count]);

  return count;
}

export function EnvironmentCheck() {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [servers, setServers] = useState<ToolStatus[]>([]);
  const [expanded, setExpanded] = useState(false);
  // Offered once. Skipping is a decision, and Aime does not ask twice.
  // Runs once per machine, in the background, without asking.
  const [autoSetup, setAutoSetup] = useState<"idle" | "running" | "done">("idle");
  const languageCount = useLanguageCount();
  const t = useT();

  // Policy, stated in the help and in the line this renders: using Aime means
  // letting it set up the small, user-scoped language servers by itself.
  // Nothing here needs elevation and nothing touches the system.
  useEffect(() => {
    if (localStorage.getItem(SETUP_DONE_KEY) === "true") return;
    localStorage.setItem(SETUP_DONE_KEY, "true");
    invoke<string[]>("unattended_setup_targets")
      .then(async (targets) => {
        if (targets.length === 0) return;
        setAutoSetup("running");
        for (const target of targets) {
          try {
            await invoke<number>("install_tool", { toolId: target });
            useLsp.getState().forget(target);
          } catch (err: unknown) {
            console.error("unattended setup failed for", target, err);
          }
        }
        setAutoSetup("done");
        // Re-read, so the line reflects what the machine now has.
        void invoke<ToolStatus[]>("language_server_report").then(setServers);
      })
      .catch((err: unknown) => {
        console.error("unattended setup could not start:", err);
      });
  }, []);

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

  if (tools === null) {
    return (
      <p className="mt-6 flex items-center justify-center gap-2 text-[11px] text-muted">
        <Loader2 size={12} className="animate-spin" /> {t("env.checking")}
      </p>
    );
  }

  const everything = [...tools, ...servers];
  // Only a tool Aime cannot work without is worth alarming about on the way in.
  // A language server for a language the user may never touch is not: they are
  // offered the moment such a file is actually opened, and listed under Details.
  const blocking = everything.filter((tool) => readinessOf(tool) === "missing");
  const ready = servers.filter((server) => server.installed).length;
  const Marker = expanded ? ChevronDown : ChevronRight;

  return (
    <section className="mt-6 flex flex-col items-center">
      {/* Progressive disclosure (ARCHITECTURE.md §6): the machine's state is
          ambient information. One quiet line when all is well, one warning
          line when it is not, and the full report only if asked for - a
          welcome screen that needs scrolling is one that got in the way. */}
      <button
        onClick={() => {
          setExpanded((open) => !open);
        }}
        title={t("env.title")}
        className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-elevated hover:text-fg"
      >
        <Marker size={11} className="shrink-0 opacity-60" />
        {autoSetup === "running" ? (
          <>
            <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
            {t("env.settingUp")}
          </>
        ) : blocking.length > 0 ? (
          <>
            <TriangleAlert size={11} className="shrink-0 text-danger" />
            <span className="truncate text-danger">
              {t("env.blocked", { names: blocking.map((tool) => tool.label).join(", ") })}
            </span>
          </>
        ) : (
          <>
            <Check size={11} className="shrink-0 text-ok" />
            <span className="truncate">
              {t("env.ready", {
                languages: String(languageCount),
                servers: String(ready + BUILT_IN_INTELLISENSE),
              })}
            </span>
          </>
        )}
      </button>

      {expanded && (
        <div className="mt-1 w-full rounded-lg border border-line px-3 py-2">
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
