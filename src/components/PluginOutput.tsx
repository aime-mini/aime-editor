import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useT } from "../i18n";
import { usePlugins } from "../stores/plugins";

/**
 * What the plugins had to say.
 *
 * Their own view rather than the Debug Console: a plugin's output has nothing to
 * do with a debugged program, and mixing the two would make both harder to read.
 * The list is capped in the store (`MAX_LOG_LINES`), so a chatty plugin scrolls
 * rather than grows — and each line says which plugin it came from, because with
 * three plugins running "done" on its own means nothing.
 */
export function PluginOutput() {
  const log = usePlugins((s) => s.log);
  const installed = usePlugins((s) => s.installed);
  const clear = usePlugins((s) => s.clearLog);
  const logRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const nameOf = (pluginId: string): string =>
    installed.find((plugin) => plugin.manifest.id === pluginId)?.manifest.name ?? pluginId;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1">
        <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{t("plugins.log")}</span>
        <span className="flex-1" />
        <button
          onClick={clear}
          title={t("debug.clearConsole")}
          className="rounded p-1 text-muted hover:text-fg"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5 font-mono text-[11.5px]">
        {log.length === 0 && <p className="text-muted">{t("plugins.logEmpty")}</p>}
        {log.map((line, index) => (
          <div key={index} className="flex gap-2 whitespace-pre-wrap">
            {/* The name is fixed-width and truncated: a long plugin name must not
                push every message off the right edge. */}
            <span className="w-28 shrink-0 truncate text-accent" title={nameOf(line.pluginId)}>
              {nameOf(line.pluginId)}
            </span>
            <span className="min-w-0 flex-1 text-muted">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
