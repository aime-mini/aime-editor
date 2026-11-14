import { X } from "lucide-react";
import { useT } from "../i18n";
import { processNames } from "../lib/processNames";
import type { LeftProcess } from "../stores/ai";
import { Spinner } from "./Spinner";

/**
 * The line under the conversation while Aime follows what the last turn left
 * running. It names the processes and says what happens when they end - the
 * AI is told - so a turn that ended on "I will report once the tests finish"
 * is visibly still being looked after. The x stops following; the processes
 * themselves run on.
 */
export function LeftRunning({ processes, onStop }: { processes: LeftProcess[]; onStop: () => void }) {
  const t = useT();
  const names = processNames(processes);
  const label =
    processes.length === 1
      ? t("ai.leftRunningOne", { processes: names })
      : t("ai.leftRunning", { count: processes.length, processes: names });
  return (
    <div
      role="status"
      data-left-running={processes.length}
      className="flex shrink-0 items-center gap-2 border-t border-line bg-elevated/60 px-3 py-1.5 text-[11.5px] text-muted"
    >
      <Spinner size={12} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <button
        onClick={onStop}
        title={t("ai.leftRunningStop")}
        aria-label={t("ai.leftRunningStop")}
        className="shrink-0 rounded p-0.5 hover:bg-panel hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
}
