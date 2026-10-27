import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CheckCircle2, CircleDashed, Globe, Loader2, UserRound, Wand2, XCircle } from "lucide-react";
import { useT } from "../../i18n";
import { needsCompiling } from "../../lib/flows/compiler";
import { ERROR_PORT, OUT_PORT, stepReachesOut, type Step } from "../../lib/flows/model";
import type { StepState } from "../../stores/flows";
import { abilityOf } from "./abilities";

/** What the canvas hands each node: the step, and in a run its state. */
export interface StepNodeData extends Record<string, unknown> {
  step: Step;
  /** Which ports have a wire, so the error port shows only once it is used. */
  errorWired: boolean;
  state?: StepState;
  summary?: string;
  round?: number;
}

/**
 * One step on the canvas: swatch and name, what it does in one line, and
 * its ports - one in on the left, out on the right, a gate's branches each
 * with a label, the error port underneath once something is wired to it.
 */
export function StepNode({ data, selected }: NodeProps & { data: StepNodeData }) {
  const t = useT();
  const { step, state } = data;
  const look = abilityOf(step);
  const Icon = look.icon;
  const isInput = step.config.ability === "input";
  const branches = step.config.ability === "gate" ? step.config.branches : [];
  const stateRing =
    state === "running" || state === "waiting"
      ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]"
      : state === "failed"
        ? "border-danger"
        : state === "done"
          ? "border-ok/60"
          : state === "skipped"
            ? "border-line opacity-50"
            : selected
              ? "border-accent"
              : "border-line";
  return (
    <div
      data-flow-step={step.id}
      data-flow-state={state ?? ""}
      className={`relative w-48 rounded-lg border bg-panel px-3 py-2 text-[12px] shadow-md ${stateRing}`}
    >
      {!isInput && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="!size-2 !border-line !bg-elevated"
        />
      )}
      <div className="flex items-center gap-2">
        <span className={`grid size-5 shrink-0 place-items-center rounded-md ${look.swatch}`}>
          <Icon size={12} strokeWidth={2.4} />
        </span>
        <b className="min-w-0 flex-1 truncate font-semibold">{step.name}</b>
        {stepReachesOut(step) && (
          <Globe size={11} className="shrink-0 text-muted" aria-label={t("flows.node.reachesOut")} />
        )}
        {needsCompiling(step) && (
          <Wand2
            size={11}
            className="shrink-0 text-amber-400"
            aria-label={t("flows.node.compileNeeded")}
            data-flow-compile-needed
          />
        )}
        <StateMark state={state} />
      </div>
      <p className="mt-1 truncate text-[11px] text-muted" title={step.does}>
        {step.does.trim() === "" ? t(look.note) : step.does}
      </p>
      {data.summary !== undefined && data.summary !== "" && (
        <p className="mt-1 truncate text-[11px] text-fg/80" title={data.summary}>
          {data.summary}
        </p>
      )}
      {step.forEach === true && (
        <span className="mt-1 inline-block rounded bg-elevated px-1 text-[10px] text-muted">
          {t("flows.node.forEach")}
        </span>
      )}
      {branches.length === 0 ? (
        <Handle
          type="source"
          position={Position.Right}
          id={OUT_PORT}
          className="!size-2 !border-line !bg-elevated"
        />
      ) : (
        branches.map((branch, index) => (
          <Handle
            key={branch.label}
            type="source"
            position={Position.Right}
            id={branch.label}
            style={{ top: `${String(((index + 1) * 100) / (branches.length + 1))}%` }}
            className="!size-2 !border-amber-400 !bg-elevated"
            title={branch.label}
          />
        ))
      )}
      {!isInput && (
        <Handle
          type="source"
          position={Position.Bottom}
          id={ERROR_PORT}
          title={t("flows.node.errorPort")}
          className={`!size-2 !border-danger !bg-elevated ${data.errorWired || selected ? "" : "!opacity-0"}`}
        />
      )}
      {branches.length > 0 && (
        <div className="pointer-events-none absolute top-0 right-[-6px] h-full">
          {branches.map((branch, index) => (
            <span
              key={branch.label}
              className="absolute translate-x-full rounded bg-elevated px-1 text-[10px] text-amber-400 whitespace-nowrap"
              style={{ top: `calc(${String(((index + 1) * 100) / (branches.length + 1))}% - 8px)`, left: 10 }}
            >
              {branch.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StateMark({ state }: { state?: StepState }) {
  switch (state) {
    case "running":
      return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />;
    case "waiting":
      return <UserRound size={13} className="shrink-0 text-pink-400" />;
    case "done":
      return <CheckCircle2 size={13} className="shrink-0 text-ok" />;
    case "failed":
      return <XCircle size={13} className="shrink-0 text-danger" />;
    case "skipped":
      return <CircleDashed size={13} className="shrink-0 text-muted" />;
    default:
      return null;
  }
}
