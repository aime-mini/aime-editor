import { Bug, SquareTerminal } from "lucide-react";
import { useT } from "../i18n";
import { useLayout, type BottomView } from "../stores/layout";
import { DebugConsole } from "./DebugConsole";
import { TerminalPanel } from "./TerminalPanel";

/**
 * The panel under the editor: terminals, or what the debugged program printed.
 *
 * A rail of icons switches between them instead of a second row of tabs — the
 * terminal already has its own tab strip, and stacking two strips would spend
 * a quarter of a short panel on chrome. Both views stay mounted: switching
 * away from a shell must never kill it.
 */
export function BottomPanel() {
  const { bottomView, setBottomView, terminalEverOpened } = useLayout();
  const t = useT();

  const railButton = (view: BottomView, icon: React.ReactNode, title: string) => (
    <button
      onClick={() => {
        setBottomView(view);
      }}
      title={title}
      className={`rounded p-1.5 hover:bg-elevated ${
        bottomView === view ? "text-accent" : "text-muted hover:text-fg"
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="flex h-full bg-panel">
      <div className="flex w-8 shrink-0 flex-col items-center gap-0.5 border-r border-line pt-1">
        {railButton("terminal", <SquareTerminal size={14} />, t("layout.toggleTerminal"))}
        {railButton("debug", <Bug size={14} />, t("debug.console"))}
      </div>
      <div className="min-w-0 flex-1">
        <div className={bottomView === "terminal" ? "h-full" : "hidden"}>
          {terminalEverOpened && <TerminalPanel />}
        </div>
        <div className={bottomView === "debug" ? "h-full" : "hidden"}>
          <DebugConsole />
        </div>
      </div>
    </div>
  );
}
