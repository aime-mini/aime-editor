import { Plus, Sparkles, X } from "lucide-react";
import { useT } from "../i18n";
import { useAi } from "../stores/ai";
import { useTasks } from "../stores/tasks";
import { useTerminals } from "../stores/terminals";
import { TerminalPane } from "./TerminalPane";

/**
 * Tab strip + one TerminalPane per tab. Every pane stays mounted (hidden
 * when inactive) so switching tabs never kills a shell session. A tab running
 * a task also reports its output to the tasks store, which is what turns a
 * failed run into a one-click "Fix with AI".
 */
export function TerminalPanel() {
  const { tabs, activeTab, addTab, closeTab, setActiveTab } = useTerminals();
  const { runs, appendOutput, dismissRun, fixWithAi } = useTasks();
  const aiRunning = useAi((s) => s.running);
  const t = useT();
  const activeRun = runs[activeTab];
  const failed = activeRun && activeRun.exitCode !== null && activeRun.exitCode !== 0;

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-0.5 border-b border-line px-1 pt-1">
        {tabs.map((tab, index) => (
          <div
            key={tab.key}
            className={`group flex items-center gap-1 rounded-t px-2 py-1 text-[11px] ${
              tab.key === activeTab ? "bg-elevated text-fg" : "cursor-pointer text-muted hover:bg-elevated/50"
            }`}
            onClick={() => {
              setActiveTab(tab.key);
            }}
          >
            {tab.title ?? t("terminal.tab", { n: index + 1 })}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.key);
              }}
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-danger"
            >
              <X size={10} />
            </button>
          </div>
        ))}
        <button
          onClick={() => {
            addTab();
          }}
          className="ml-1 rounded p-1 text-muted hover:bg-elevated hover:text-accent"
          title={t("terminal.newTab")}
        >
          <Plus size={12} />
        </button>
      </div>

      {failed && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px]">
          <span className="flex-1 truncate text-danger">
            {t("tasks.failed", { label: activeRun.task.label, code: String(activeRun.exitCode) })}
          </span>
          <button
            onClick={() => {
              fixWithAi(activeTab);
            }}
            disabled={aiRunning}
            className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-white hover:opacity-90 disabled:opacity-40"
          >
            <Sparkles size={12} /> {t("tasks.fixWithAi")}
          </button>
          <button
            onClick={() => {
              dismissRun(activeTab);
            }}
            className="rounded p-1 text-muted hover:text-fg"
            title={t("tasks.dismiss")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div key={tab.key} className={tab.key === activeTab ? "h-full" : "hidden"}>
            <TerminalPane
              initialCommand={tab.initialCommand}
              onOutput={
                tab.key in runs
                  ? (chunk) => {
                      appendOutput(tab.key, chunk);
                    }
                  : undefined
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
