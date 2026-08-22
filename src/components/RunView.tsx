import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CirclePause,
  GitBranch,
  Loader2,
  Play,
  ShieldAlert,
  SkipForward,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { PHASES, progressOf, type PhaseId, type PhaseResult, type PhaseState } from "../lib/runPlan";
import { useRun } from "../stores/run";

/**
 * A Task Run while it runs, and after.
 *
 * It lives in the editor area rather than in a modal because it is not a
 * question — it is a job that takes minutes, that the reader will leave and
 * come back to, and whose evidence they will want to read at their own pace.
 *
 * The panel's whole job is to make the gates legible: which phase is working,
 * which ones passed, and — when it stopped — exactly what refused and why. A
 * run that stopped for a good reason must look different from one that failed.
 */
export function RunView() {
  const { run, log, autonomy, setAutonomy, approvePlan, cancel, dismiss } = useRun();
  const t = useT();
  const [open, setOpen] = useState<PhaseId | null>(null);
  const tail = useRef<HTMLDivElement>(null);

  // The log is the only sign of life during a long phase, so it follows itself.
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [log.length]);

  if (run === null) return null;
  const { done, total } = progressOf(run);
  const ended = run.ended;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg">
      <header className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-6 py-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] tracking-wide text-muted uppercase">{t("run.title")}</p>
              <h1 className="mt-0.5 text-[15px] leading-snug font-medium">{run.itemTitle}</h1>
              {run.branch !== null && (
                <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted">
                  <GitBranch size={11} /> {run.branch}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {run.current !== null && (
                <button
                  onClick={() => void cancel()}
                  className="rounded border border-line px-2 py-0.5 text-[11.5px] text-muted hover:border-danger hover:text-danger"
                >
                  {t("run.cancel")}
                </button>
              )}
              {run.current === null && (
                <button
                  onClick={dismiss}
                  title={t("run.close")}
                  className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-elevated">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${String(Math.round((done / total) * 100))}%` }}
              />
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">
              {t("run.progress", { done, total })}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-6 pb-10">
        {ended !== null && <Ending ending={ended} onApprove={() => void approvePlan()} />}

        <ol className="mt-5">
          {PHASES.map((phase) => {
            const result = run.results[phase.id];
            const state: PhaseState = run.current === phase.id ? "running" : (result?.state ?? "waiting");
            const expanded = open === phase.id;
            return (
              <li key={phase.id} className="flex gap-3 pb-3 last:pb-0">
                <div className="flex flex-col items-center">
                  <Mark state={state} />
                  {phase.id !== PHASES[PHASES.length - 1].id && (
                    <span className="mt-1 w-px flex-1 bg-line" aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => {
                      setOpen(expanded ? null : phase.id);
                    }}
                    disabled={result?.detail === undefined}
                    className="flex w-full items-baseline gap-2 text-left disabled:cursor-default"
                  >
                    <span
                      className={`text-[13px] font-medium ${state === "waiting" ? "text-muted" : "text-fg"}`}
                    >
                      {t(PHASE_LABELS[phase.id])}
                    </span>
                    <span className="shrink-0 text-[10px] tracking-wide text-muted uppercase">
                      {t(WORKER_LABELS[phase.worker])}
                    </span>
                    {result?.detail !== undefined &&
                      (expanded ? (
                        <ChevronDown size={11} className="shrink-0 text-muted" />
                      ) : (
                        <ChevronRight size={11} className="shrink-0 text-muted" />
                      ))}
                  </button>
                  {result?.summary !== undefined && result.summary !== "" && (
                    <p
                      className={`mt-0.5 text-[12.5px] ${state === "blocked" ? "text-danger" : "text-muted"}`}
                    >
                      {result.summary}
                    </p>
                  )}
                  {expanded && result?.detail !== undefined && (
                    <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-line bg-elevated px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap">
                      {result.detail}
                    </pre>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {log.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-[11px] tracking-wide text-muted uppercase">{t("run.log")}</h2>
            <div className="max-h-72 overflow-auto rounded-md border border-line bg-elevated px-3 py-2">
              {log.map((line, index) => (
                <p
                  key={index}
                  className={`font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap ${
                    line.kind === "problem" ? "text-danger" : "text-muted"
                  }`}
                >
                  {line.text}
                </p>
              ))}
              <div ref={tail} />
            </div>
          </section>
        )}

        <section className="mt-6">
          <h2 className="mb-2 text-[11px] tracking-wide text-muted uppercase">{t("run.autonomy")}</h2>
          <div className="flex gap-1.5">
            {(["reviewPlan", "autopilot"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  setAutonomy(mode);
                }}
                title={t(mode === "reviewPlan" ? "run.reviewPlanWhy" : "run.autopilotWhy")}
                className={`rounded border px-2 py-1 text-[11.5px] ${
                  autonomy === mode
                    ? "border-accent text-accent"
                    : "border-line text-muted hover:border-accent hover:text-fg"
                }`}
              >
                {t(mode === "reviewPlan" ? "run.reviewPlan" : "run.autopilot")}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** How a run stopped, and the one button that answers it. */
function Ending({
  ending,
  onApprove,
}: {
  ending: NonNullable<ReturnType<typeof useRun.getState>["run"]>["ended"];
  onApprove: () => void;
}) {
  const t = useT();
  if (ending === null) return null;

  if (ending.kind === "waiting") {
    return (
      <div className="mt-4 rounded-lg border border-accent bg-accent-soft px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-medium text-accent">
          <CirclePause size={14} /> {t("run.waiting")}
        </p>
        <p className="mt-1 text-[12.5px] whitespace-pre-wrap text-fg/90">{ending.question}</p>
        {ending.phase === "plan" && (
          <button
            onClick={onApprove}
            className="mt-2.5 flex items-center gap-1.5 rounded bg-accent-strong px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
          >
            <Play size={12} /> {t("run.goOn")}
          </button>
        )}
      </div>
    );
  }

  if (ending.kind === "blocked") {
    return (
      <div className="border-danger/50 mt-4 rounded-lg border px-4 py-3">
        <p className="text-danger flex items-center gap-2 text-[13px] font-medium">
          <ShieldAlert size={14} /> {t("run.blocked")}
        </p>
        <p className="mt-1 text-[12.5px] text-fg/90">{ending.why}</p>
      </div>
    );
  }

  if (ending.kind === "done") {
    return (
      <div className="border-ok/50 mt-4 rounded-lg border px-4 py-3">
        <p className="text-ok flex items-center gap-2 text-[13px] font-medium">
          <Check size={14} /> {t("run.done")}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-line px-4 py-3">
      <p className="text-[13px] text-muted">
        {t(ending.kind === "cancelled" ? "run.cancelled" : "run.failed")}
      </p>
    </div>
  );
}

/** One phase's state as a mark, coloured only where colour means something. */
function Mark({ state }: { state: PhaseState }) {
  const shell = "flex size-5 shrink-0 items-center justify-center rounded-full border";
  switch (state) {
    case "running":
      return (
        <span className={`${shell} border-accent text-accent`}>
          <Loader2 size={11} className="animate-spin" />
        </span>
      );
    case "passed":
      return (
        <span className={`${shell} border-ok text-ok`}>
          <Check size={11} />
        </span>
      );
    case "blocked":
      return (
        <span className={`${shell} border-danger text-danger`}>
          <ShieldAlert size={11} />
        </span>
      );
    case "skipped":
      return (
        <span className={`${shell} border-line text-muted`}>
          <SkipForward size={11} />
        </span>
      );
    default:
      return (
        <span className={`${shell} border-line text-muted`}>
          <CircleDashed size={11} />
        </span>
      );
  }
}

const PHASE_LABELS: Record<PhaseId, TranslationKey> = {
  baseline: "run.phase.baseline",
  understand: "run.phase.understand",
  locate: "run.phase.locate",
  plan: "run.phase.plan",
  implement: "run.phase.implement",
  regression: "run.phase.regression",
  review: "run.phase.review",
  report: "run.phase.report",
};

const WORKER_LABELS = {
  tools: "run.worker.tools",
  reader: "run.worker.reader",
  writer: "run.worker.writer",
} as const satisfies Record<string, TranslationKey>;

export type { PhaseResult };
