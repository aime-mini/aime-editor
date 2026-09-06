import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Loader2, TriangleAlert, X } from "lucide-react";
import { useT } from "../i18n";
import { useCloud } from "../stores/cloud";
import { useLsp } from "../stores/lsp";

interface InstallLine {
  toolId: string;
  line: string;
}

/**
 * What happened to one tool in the queue.
 *
 * Kept as data rather than as a finished sentence on purpose: translating here
 * would put the translator inside the effect that runs the installs, and that
 * function is new on every render — which restarted the whole queue on every
 * line of output. Once per render is once per install.
 */
type Failure =
  { kind: "exit"; code: number } | { kind: "runtime"; runtime: string } | { kind: "error"; reason: string };

type Result = { toolId: string; ok: true } | { toolId: string; ok: false; failure: Failure };

/** The backend refuses when the install command's own runtime is absent. */
const RUNTIME_MISSING = /^RUNTIME_MISSING::(.+)$/;

/**
 * Installs a queue of tools, in the open.
 *
 * Aime never installs anything silently: the command it runs is the first line
 * of the log, every line the installer prints appears as it arrives, and each
 * tool ends with its own verdict. Installing on someone's machine is their
 * decision, so it happens where they can watch it - and one failure never
 * stops the rest of the queue.
 */
export function InstallerModal({ tools, onClose }: { tools: string[]; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    let stale = false;
    const unlisten = listen<InstallLine>("install:output", ({ payload }) => {
      setLines((current) => [...current, payload.line]);
    });

    const runAll = async () => {
      for (const toolId of tools) {
        setLines((current) => [...current, `--- ${toolId} ---`]);
        try {
          const code = await invoke<number>("install_tool", { toolId });
          if (stale) return;
          if (code === 0) {
            // A freshly installed server should be picked up without a restart.
            useLsp.getState().forget(toolId);
            // And a freshly downloaded cloud CLI without a click: reported
            // 2026-09-05, the Supabase CLI landed in Aime's folder and the
            // panel kept saying "not on this machine" until reopened.
            const clouds = useCloud.getState();
            if (clouds.clouds.some((cloud) => cloud.id === toolId)) void clouds.refresh();
            setResults((current) => [...current, { toolId, ok: true }]);
          } else {
            setResults((current) => [...current, { toolId, ok: false, failure: { kind: "exit", code } }]);
          }
        } catch (err: unknown) {
          if (stale) return;
          const reason = String(err);
          const missing = RUNTIME_MISSING.exec(reason);
          setResults((current) => [
            ...current,
            {
              toolId,
              ok: false,
              failure: missing ? { kind: "runtime", runtime: missing[1] } : { kind: "error", reason },
            },
          ]);
        }
      }
      if (!stale) setRunning(false);
    };
    void runAll();

    return () => {
      stale = true;
      void unlisten.then((stop) => {
        stop();
      });
    };
    // `tools` only: the queue must survive its own output. Adding anything that
    // is recreated per render - the translator, a handler - relaunches every
    // install on every log line, which spawns installers faster than they can
    // finish (reported: "Installing… 0 of 1 done" forever, machine grinding).
  }, [tools]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const failures = results.flatMap((result) => (result.ok ? [] : [result]));

  /** A failure becomes a sentence here, where the translator is allowed. */
  const explain = (failure: Failure): string => {
    if (failure.kind === "exit") return t("install.failed", { code: String(failure.code) });
    if (failure.kind === "runtime") return t("install.runtimeMissing", { runtime: failure.runtime });
    return failure.reason;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-20" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-[600px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Download size={15} className="shrink-0 text-accent" />
          <span className="flex-1 text-xs font-semibold">
            {t("install.title", { tool: tools.join(", ") })}
          </span>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <div
          ref={logRef}
          className="min-h-32 flex-1 overflow-y-auto bg-bg px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap"
        >
          {lines.length === 0 && <span className="text-muted">{t("install.starting")}</span>}
          {lines.map((line, index) => (
            <div key={index} className="text-muted">
              {line}
            </div>
          ))}
        </div>

        {failures.length > 0 && (
          <div className="border-t border-danger/40 bg-danger/10 px-4 py-1.5 text-[11.5px] text-danger">
            {failures.map((failure) => (
              <p key={failure.toolId}>
                {failure.toolId}: {explain(failure.failure)}
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[12px]">
          {running ? (
            <span className="flex items-center gap-1.5 text-muted">
              <Loader2 size={12} className="animate-spin" />
              {t("install.progress", { done: String(results.length), total: String(tools.length) })}
            </span>
          ) : failures.length === 0 ? (
            <span className="flex items-center gap-1.5 text-ok">
              <Check size={12} /> {t("install.done")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-warn">
              <TriangleAlert size={12} />
              {t("install.partly", {
                ok: String(results.length - failures.length),
                total: String(tools.length),
              })}
            </span>
          )}
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-fg"
          >
            {t("install.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
