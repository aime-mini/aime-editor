import { useEffect, useRef } from "react";
import { Check, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useT } from "../i18n";
import { useSetup, type SetupLine } from "../stores/setup";

/** Each kind of line reads differently, and the log is easier to skim for it. */
const LINE_CLASS: Record<SetupLine["kind"], string> = {
  note: "text-fg",
  text: "text-muted",
  tool: "text-accent",
  error: "text-danger",
};

/**
 * What the agent is doing to this machine, while it does it.
 *
 * The same shape as the installer's log, for the same reason: Aime never
 * changes a machine silently. What is different is that this run can take a
 * quarter of an hour (measured on a real C# project), so the modal is closable
 * without stopping the work, and Cancel is a first-class button rather than an
 * afterthought — closing puts the run in the background, Cancel ends it.
 */
export function SetupProgressModal() {
  const { open, running, subject, lines, exitCode, cancelled, error, cancel, close } = useSetup();
  const logRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  if (!open) return null;

  const failed = error !== null || (exitCode !== null && exitCode !== 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-20" onClick={close}>
      <div
        className="flex max-h-[70vh] w-[600px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Sparkles size={15} className="shrink-0 text-accent" />
          <span className="flex-1 text-xs font-semibold">
            {t("setup.progressTitle", { subject: subject ?? "" })}
          </span>
          <button
            onClick={close}
            title={t("setup.background")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>

        <div
          ref={logRef}
          className="min-h-32 flex-1 overflow-y-auto bg-bg px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap"
        >
          {lines.length === 0 && <span className="text-muted">{t("setup.starting")}</span>}
          {lines.map((line, index) => (
            <div key={index} className={LINE_CLASS[line.kind]}>
              {line.text}
            </div>
          ))}
        </div>

        {error !== null && (
          <div className="border-t border-danger/40 bg-danger/10 px-4 py-1.5 text-[11.5px] text-danger">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[12px]">
          {running ? (
            <span className="flex items-center gap-1.5 text-muted">
              <Loader2 size={12} className="animate-spin" />
              {t("setup.progressHint")}
            </span>
          ) : cancelled ? (
            <span className="flex items-center gap-1.5 text-warn">
              <TriangleAlert size={12} /> {t("setup.cancelled")}
            </span>
          ) : failed ? (
            <span className="flex items-center gap-1.5 text-danger">
              <TriangleAlert size={12} />
              {t("setup.failed", { code: String(exitCode ?? "") })}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ok">
              <Check size={12} /> {t("setup.succeeded")}
            </span>
          )}
          <span className="flex-1" />
          {running && (
            <button
              onClick={() => void cancel()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:border-danger hover:text-danger"
            >
              {t("setup.cancel")}
            </button>
          )}
          <button
            onClick={close}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-fg"
          >
            {running ? t("setup.background") : t("install.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
