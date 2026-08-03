import { useEffect, useRef } from "react";
import { Eraser } from "lucide-react";
import { useT } from "../i18n";
import { useDebug } from "../stores/debug";

const CATEGORY_CLASS = {
  stdout: "text-fg",
  stderr: "text-danger",
  console: "text-muted",
} as const;

/**
 * What the program printed.
 *
 * Segments are rendered as they were accumulated rather than split into rows:
 * an adapter cuts a program's output wherever the pipe happened to flush, and
 * one `print` can arrive as three events (see lib/dap/output.ts).
 */
export function DebugConsole() {
  const { output, exitCode, status, clearConsole } = useDebug();
  const bottomRef = useRef<HTMLDivElement>(null);
  const t = useT();

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [output, exitCode]);

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-[11px] text-muted">
        <span className="flex-1">
          {status.kind === "paused"
            ? t("debug.pausedOn", { reason: status.reason })
            : status.kind === "running"
              ? t("debug.running")
              : t("debug.console")}
        </span>
        <button
          onClick={clearConsole}
          title={t("debug.clearConsole")}
          className="rounded p-1 hover:bg-elevated hover:text-fg"
        >
          <Eraser size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[12px] leading-[1.45]">
        {output.length === 0 && exitCode === null && (
          <span className="text-muted">{t("debug.noOutput")}</span>
        )}
        <pre className="whitespace-pre-wrap break-words">
          {output.map((segment, index) => (
            // Segments are appended and merged in place; the index is their identity.
            <span key={index} className={CATEGORY_CLASS[segment.category]}>
              {segment.text}
            </span>
          ))}
        </pre>
        {exitCode !== null && (
          <div className={`mt-1 ${exitCode === 0 ? "text-ok" : "text-danger"}`}>
            {t("debug.exited", { code: String(exitCode) })}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
