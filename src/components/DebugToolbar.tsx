import {
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import { useT } from "../i18n";
import { useDebug } from "../stores/debug";

/**
 * The bar that appears while a program is being debugged.
 *
 * Stepping is only meaningful when execution is paused, so those buttons are
 * disabled rather than hidden: a control that moves around is harder to hit
 * than one that greys out.
 */
export function DebugToolbar() {
  const { status, resume, pause, stepOver, stepInto, stepOut, restart, stop } = useDebug();
  const t = useT();

  if (status.kind === "idle") return null;
  const paused = status.kind === "paused";

  const button = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    { enabled = true, danger = false } = {},
  ) => (
    <button
      onClick={onClick}
      disabled={!enabled}
      title={label}
      className={`rounded p-1 hover:bg-elevated disabled:opacity-30 ${
        danger ? "text-muted hover:text-danger" : "text-muted hover:text-accent"
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line bg-elevated/60 px-1 py-0.5">
      {paused
        ? button(t("debug.continue"), <Play size={13} />, () => void resume())
        : button(t("debug.pause"), <Pause size={13} />, () => void pause(), {
            enabled: status.kind === "running",
          })}
      {button(t("debug.stepOver"), <ArrowRightToLine size={13} />, () => void stepOver(), {
        enabled: paused,
      })}
      {button(t("debug.stepInto"), <ArrowDownToLine size={13} />, () => void stepInto(), {
        enabled: paused,
      })}
      {button(t("debug.stepOut"), <ArrowUpFromLine size={13} />, () => void stepOut(), { enabled: paused })}
      {button(t("debug.restart"), <RotateCcw size={13} />, () => void restart())}
      {button(t("debug.stop"), <Square size={13} />, () => void stop(), { danger: true })}
    </div>
  );
}
