import { useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  GitBranch,
  Loader2,
  Square,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { useT } from "../../i18n";
import type { Step } from "../../lib/flows/model";
import { useFlows, type RunView, type StepState, type StepView } from "../../stores/flows";
import { formatElapsed, useSecondsFrom } from "../useSecondsSince";
import { FlowsBreadcrumb } from "./Breadcrumb";
import { FlowCanvas } from "./FlowCanvas";
import { AskCard, CostCard } from "./RunCards";
import { RunStepPanel } from "./RunStepPanel";

/**
 * A run as it happens, laid out the way it was designed (screens 04-06): the
 * steps in order with how each went on the left, the canvas marking them in
 * the middle with whatever the run needs from the person laid over it, and on
 * the right the step being looked at - by default the one that matters now.
 */
export function RunScreen({ runId }: { runId: string }) {
  const t = useT();
  const run = useFlows((s) => (s.runs as Partial<Record<string, RunView>>)[runId]);
  const [picked, setPicked] = useState<string | null>(null);
  if (run === undefined) return <p className="p-4 text-[12px] text-muted">{t("flows.run.gone")}</p>;
  const shown = picked ?? stepThatMatters(run);

  return (
    <div className="flex h-full flex-col" data-flow-run={run.id} data-flow-run-status={run.status}>
      <RunHeader run={run} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,208px)_1fr_minmax(260px,300px)]">
        <Progress run={run} selected={shown} onSelect={setPicked} />
        <RunBody run={run} selected={shown} onSelect={setPicked} />
      </div>
    </div>
  );
}

/**
 * A run's canvas, with whatever it needs from the person laid over it, and the
 * panel of the step being looked at - two columns of a grid the caller lays
 * out: a run in progress puts its steps beside them, the history its runs.
 */
export function RunBody({
  run,
  selected,
  onSelect,
}: {
  run: RunView;
  selected: string | null;
  onSelect: (stepId: string | null) => void;
}) {
  const t = useT();
  const picked = useMemo(() => (selected === null ? [] : [selected]), [selected]);
  return (
    <>
      <section className="relative min-w-0 bg-bg">
        <FlowCanvas
          flow={run.flow}
          selected={picked}
          onSelect={(ids) => {
            onSelect(ids.at(-1) ?? null);
          }}
          run={run}
          hint={t("flows.canvas.runHint")}
        />
        {/* Along the bottom, above the zoom bar: the canvas frames the steps from the top. */}
        <div className="pointer-events-none absolute inset-x-3 bottom-14 flex flex-col items-center gap-2 [&>*]:pointer-events-auto">
          {run.waiting !== null && (
            <AskCard
              runId={run.id}
              ask={run.waiting.ask}
              stepName={run.waiting.step.name}
              root={run.workRoot}
            />
          )}
          {run.paused !== null && (
            <CostCard runId={run.id} costUsd={run.paused.costUsd} limitUsd={run.paused.limitUsd} />
          )}
          {run.error !== null && (
            <p
              className="w-[min(440px,100%)] rounded-md border border-danger/40 bg-panel px-3 py-2 text-[12px] text-danger shadow-xl"
              data-flow-error
            >
              {run.error}
            </p>
          )}
        </div>
      </section>
      <RunStepPanel run={run} stepId={selected} />
    </>
  );
}

/** The step to show until one is picked: the one waiting, failed or running, else the last that finished. */
export function stepThatMatters(run: RunView): string | null {
  const steps = run.flow.steps;
  const inState = (state: StepState) => steps.find((step) => run.steps[step.id]?.state === state);
  const ran = steps.filter((step) => run.steps[step.id]?.state === "done");
  return (
    (inState("waiting") ?? inState("failed") ?? inState("running") ?? ran.at(-1) ?? steps.at(0))?.id ?? null
  );
}

function RunHeader({ run }: { run: RunView }) {
  const t = useT();
  const cancel = useFlows((s) => s.cancel);
  const openDesigner = useFlows((s) => s.openDesigner);
  const limit = run.flow.settings.costLimitUsd;
  const inPlace = run.workRoot === run.root;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
      <FlowsBreadcrumb>
        <button
          onClick={() => {
            openDesigner(run.slug);
          }}
          className="truncate font-semibold hover:underline"
          title={t("flows.run.backToDesigner")}
        >
          {run.flow.name}
        </button>
      </FlowsBreadcrumb>
      <Status run={run} />
      <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] text-muted tabular-nums">
        ${run.costUsd.toFixed(2)}
        {limit !== undefined && ` / $${limit.toFixed(2)}`}
      </span>
      {run.preview && (
        <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] text-muted">
          {t("flows.run.preview")}
        </span>
      )}
      <span className="flex-1" />
      <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-muted" title={run.workRoot}>
        <GitBranch size={12} className="shrink-0" />
        {inPlace
          ? t("flows.run.whereHere")
          : t("flows.run.whereWorktree", { name: folderName(run.workRoot) })}
      </span>
      {run.status === "running" && (
        <button
          onClick={() => {
            cancel(run.id);
          }}
          className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-danger hover:text-danger"
          data-flow-stop
        >
          <Square size={11} /> {t("flows.run.stop")}
        </button>
      )}
    </div>
  );
}

/** What the run is doing, in a pill: the step at work and for how long, or how it ended. */
function Status({ run }: { run: RunView }) {
  const t = useT();
  const pill = "flex min-w-0 items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px]";
  switch (run.status) {
    case "running": {
      const waiting = run.waiting !== null;
      const at = run.flow.steps.find((step) => run.steps[step.id]?.state === "running");
      const doing = waiting
        ? `${t("flows.status.waiting")} · ${run.waiting?.step.name ?? ""}`
        : run.paused !== null
          ? t("flows.status.paused")
          : (at?.name ?? t("flows.status.running"));
      return (
        <span
          className={`${pill} ${waiting ? "bg-pink-400/15 text-pink-400" : "bg-accent-soft text-accent"}`}
          data-flow-status="running"
        >
          {waiting ? <UserRound size={11} /> : <Loader2 size={11} className="animate-spin" />}
          {doing} · <RunClock since={run.startedAt} />
        </span>
      );
    }
    case "done":
      return (
        <span className={`${pill} bg-ok/15 text-ok`} data-flow-status="done">
          <Check size={11} /> {t("flows.status.done")}
        </span>
      );
    case "failed":
      return (
        <span className={`${pill} bg-danger/15 text-danger`} data-flow-status="failed">
          <X size={11} /> {t("flows.status.failed")}
        </span>
      );
    case "cancelled":
      return (
        <span className={`${pill} bg-elevated text-muted`} data-flow-status="cancelled">
          {t("flows.status.cancelled")}
        </span>
      );
  }
}

/** Seconds since `since`, ticking - mounted only while something runs. */
function RunClock({ since }: { since: number }) {
  return <span className="tabular-nums">{formatElapsed(useSecondsFrom(since))}</span>;
}

/** The left-hand column: every step in order with how it went, and the run's totals underneath. */
function Progress({
  run,
  selected,
  onSelect,
}: {
  run: RunView;
  selected: string | null;
  onSelect: (stepId: string) => void;
}) {
  const t = useT();
  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-panel text-[12px]">
      <h4 className="px-3 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-wider text-muted uppercase">
        {t("flows.run.progress")}
      </h4>
      <ol className="min-h-0 flex-1 overflow-y-auto pb-2">
        {run.flow.steps.map((step) => (
          <ProgressRow
            key={step.id}
            step={step}
            view={run.steps[step.id]}
            selected={selected === step.id}
            onSelect={() => {
              onSelect(step.id);
            }}
          />
        ))}
      </ol>
      <RunTotals run={run} />
    </aside>
  );
}

function ProgressRow({
  step,
  view,
  selected,
  onSelect,
}: {
  step: Step;
  view?: StepView;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = view?.state ?? "idle";
  return (
    <li>
      <button
        onClick={onSelect}
        className={`flex w-full items-start gap-2 px-3 py-1.5 text-left ${selected ? "bg-elevated" : "hover:bg-elevated/60"}`}
        data-flow-step-row={step.name}
      >
        <StateIcon state={state} />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-medium ${state === "idle" || state === "skipped" ? "text-muted" : ""}`}
          >
            {step.name}
          </span>
          <StepLine view={view} />
        </span>
      </button>
    </li>
  );
}

/** One line under a step's name: how long it took and what it cost and said, or where it stands. */
function StepLine({ view }: { view?: StepView }) {
  const t = useT();
  const state = view?.state ?? "idle";
  const round = view !== undefined && view.round > 1 ? t("flows.step.round", { n: view.round }) : "";
  let parts: string[];
  switch (state) {
    case "done": {
      const took =
        view?.startedAt !== undefined && view.endedAt !== undefined
          ? formatElapsed(Math.round((view.endedAt - view.startedAt) / 1000))
          : "";
      const cost = view?.costUsd !== undefined && view.costUsd > 0 ? `$${view.costUsd.toFixed(2)}` : "";
      parts = [took, cost, view?.summary ?? "", round];
      break;
    }
    case "running":
      parts = [
        view?.items !== undefined
          ? t("flows.step.items", { done: view.items.done, failed: view.items.failed })
          : view?.summary !== undefined && view.summary !== ""
            ? view.summary
            : t("flows.step.running"),
        round,
      ];
      break;
    case "failed":
      parts = [view?.error ?? t("flows.step.failed"), round];
      break;
    case "idle":
      parts = [t("flows.step.pending")];
      break;
    default:
      parts = [t(`flows.step.${state}`), round];
  }
  const line = parts.filter((part) => part !== "").join(" · ");
  return (
    <span
      className={`block truncate text-[11px] ${state === "failed" ? "text-danger" : state === "waiting" ? "text-pink-400" : "text-muted"}`}
      title={line}
    >
      {line}
    </span>
  );
}

function StateIcon({ state }: { state: StepState }) {
  const size = 14;
  const box = "mt-px shrink-0";
  switch (state) {
    case "done":
      return <CheckCircle2 size={size} className={`${box} text-ok`} />;
    case "running":
      return <Loader2 size={size} className={`${box} animate-spin text-accent`} />;
    case "waiting":
      return <UserRound size={size} className={`${box} text-pink-400`} />;
    case "failed":
      return <XCircle size={size} className={`${box} text-danger`} />;
    case "skipped":
      return <CircleDashed size={size} className={`${box} text-muted`} />;
    case "idle":
      return <Circle size={size} className={`${box} text-line`} />;
  }
}

/** How long the run has taken, what it has cost, and where it works. */
function RunTotals({ run }: { run: RunView }) {
  const t = useT();
  const limit = run.flow.settings.costLimitUsd;
  const row = "flex items-center justify-between gap-2";
  return (
    <dl className="flex flex-col gap-1 border-t border-line px-3 py-2.5 text-[11px] text-muted">
      <div className={row}>
        <dt>{t("flows.run.time")}</dt>
        <dd className="font-medium text-fg tabular-nums">
          {run.endedAt === undefined ? (
            <RunClock since={run.startedAt} />
          ) : (
            formatElapsed(Math.round((run.endedAt - run.startedAt) / 1000))
          )}
        </dd>
      </div>
      <div className={row}>
        <dt>{t("flows.run.cost")}</dt>
        <dd className="font-medium text-fg tabular-nums">
          ${run.costUsd.toFixed(2)}
          {limit !== undefined && ` / $${limit.toFixed(2)}`}
        </dd>
      </div>
      <div className={row}>
        <dt>{t("flows.run.where")}</dt>
        <dd className="truncate font-mono text-fg" title={run.workRoot}>
          {folderName(run.workRoot)}
        </dd>
      </div>
    </dl>
  );
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
