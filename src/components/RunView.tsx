import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CirclePause,
  GitBranch,
  Loader2,
  FileText,
  History as HistoryIcon,
  Play,
  ShieldAlert,
  Trash2,
  SkipForward,
  X,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18n, useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { whenText } from "../lib/workItems";
import type { SavedRun } from "../lib/runFile";
import {
  PHASES,
  progressOf,
  type PhaseId,
  type PhaseResult,
  type PhaseState,
  type Run,
} from "../lib/runPlan";
import { PHASE_LABELS, useRun } from "../stores/run";

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
  const { slots, shownId, past, autonomy, setAutonomy, show } = useRun();
  const { approvePlan, resume, cancel, dismiss, history, openPast, forget } = useRun();
  const t = useT();
  // The slot on screen: an opened past run wins, otherwise the shown live one.
  const slot = past ?? (shownId === null ? null : (slots[shownId] ?? null));
  const run = slot?.run ?? null;
  const log = slot?.log ?? [];
  const evidence = slot?.evidence ?? [];
  const viewingPast = past !== null;
  // Every live run, oldest first — the order they were handed over in.
  const live = Object.values(slots).sort((a, b) => a.run.startedAt - b.run.startedAt);
  const [open, setOpen] = useState<PhaseId | null>(null);
  const tail = useRef<HTMLDivElement>(null);
  const gate = useRef<HTMLDivElement>(null);

  // The log is the only sign of life during a long phase, so it follows itself.
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [log.length]);

  // But the moment the run needs the reader, the reader has to be able to see
  // it: the log scrolling itself had left the one button that answers a gate
  // above the top of the panel, behind the header.
  const ending = run?.ended ?? null;
  useEffect(() => {
    if (ending !== null) gate.current?.scrollIntoView({ block: "center" });
  }, [ending]);

  // No run on screen is not an empty panel: the record of what has been handed
  // to the AI in this project is the thing worth looking at when nothing is
  // working right now.
  if (run === null) {
    return (
      <div className="flex h-full flex-col overflow-y-auto bg-bg">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          <p className="text-[11.5px] tracking-wide text-muted uppercase">{t("run.title")}</p>
          <Past history={history} onOpen={openPast} onForget={forget} />
        </div>
      </div>
    );
  }
  const { done, total } = progressOf(run);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg">
      <header className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-6 py-4">
          {(live.length > 1 || (live.length > 0 && viewingPast)) && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {live.map((one) => {
                const active = !viewingPast && one.run.id === shownId;
                return (
                  <button
                    key={one.run.id}
                    onClick={() => {
                      show(one.run.id);
                    }}
                    title={one.run.itemTitle}
                    className={`flex max-w-48 items-center gap-1.5 rounded border px-2 py-0.5 text-[11.5px] ${
                      active ? "border-accent text-accent" : "border-line text-muted hover:border-accent"
                    }`}
                  >
                    {one.run.current !== null && <Loader2 size={10} className="shrink-0 animate-spin" />}
                    <span className="truncate">{one.run.itemTitle}</span>
                  </button>
                );
              })}
            </div>
          )}
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
        {viewingPast && (
          <div className="mt-4 rounded-lg border border-line px-4 py-3">
            <p className="flex items-center gap-2 text-[13px] font-medium">
              <HistoryIcon size={14} className="text-muted" /> {t("run.viewingPast")}
            </p>
            <p className="mt-1 text-[12.5px] text-muted">{t("run.viewingPastWhy")}</p>
          </div>
        )}
        {ending !== null && (
          <div ref={gate}>
            <Ending ending={ending} onApprove={() => void approvePlan()} onResume={() => void resume()} />
          </div>
        )}

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

        {evidence.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-[11px] tracking-wide text-muted uppercase">
              {t("run.evidenceHeading")}
            </h2>
            <ul className="rounded-md border border-line">
              {evidence.map((file) => (
                <li
                  key={file}
                  className="flex items-center gap-2 border-b border-line px-3 py-1.5 last:border-0"
                >
                  <FileText size={12} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={file}>
                    {file}
                  </span>
                  <button
                    onClick={() => {
                      revealItemInDir(file).catch(console.error);
                    }}
                    className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
                  >
                    {t("run.openFile")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <Past history={history} onOpen={openPast} onForget={forget} current={run.id} />

        {run.current === null && ending?.kind !== "waiting" && ending?.kind !== "interrupted" && <Trash />}

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

/**
 * What this run left behind, and the button that sweeps it.
 *
 * Two clicks by design: the first only *lists* — new untracked files and the
 * artifact folders, told apart from everything that was already there by the
 * baseline's own snapshot — and the second deletes exactly what is ticked.
 * Evidence starts unticked because it proves the work; the run's paperwork
 * (cases, journal, report) is never offered at all. Nothing tracked, and
 * nothing that predates the run, can ever appear in this list.
 */
function Trash() {
  const { trash, trashResult, previewTrash, sweepTrash } = useRun();
  const t = useT();

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-[11px] tracking-wide text-muted uppercase">{t("run.trashHeading")}</h2>
      {trash === null ? (
        <button
          onClick={() => void previewTrash()}
          className="rounded border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg"
        >
          {t("run.trashPreview")}
        </button>
      ) : trash.length === 0 ? (
        <p className="text-[12.5px] text-muted">{t("run.trashEmpty")}</p>
      ) : (
        // Keyed by the listing itself, so a re-listing after a sweep remounts
        // the list and the default selection is computed fresh - the selection
        // never outlives the files it points at.
        <TrashList
          key={trash.map((item) => item.path).join("\n")}
          items={trash}
          onSweep={(paths) => void sweepTrash(paths)}
        />
      )}
      {trashResult !== null && (
        <p className="mt-2 text-[12.5px] text-muted">
          {t("run.trashDone", { count: trashResult.deleted })}
          {trashResult.failed.length > 0 &&
            ` · ${t("run.trashFailed", { count: trashResult.failed.length })}`}
        </p>
      )}
    </section>
  );
}

/** One listing with its selection: sweepings ticked, keepsakes not. */
function TrashList({
  items,
  onSweep,
}: {
  items: readonly { path: string; shown: string; keeper: boolean }[];
  onSweep: (paths: string[]) => void;
}) {
  const t = useT();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(items.filter((item) => !item.keeper).map((item) => item.path)),
  );

  const toggle = (path: string) => {
    setTicked((now) => {
      const next = new Set(now);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <>
      <p className="mb-2 text-[12.5px] text-muted">{t("run.trashWhy")}</p>
      <ul className="rounded-md border border-line">
        {items.map((item) => (
          <li
            key={item.path}
            className="flex items-center gap-2 border-b border-line px-3 py-1.5 last:border-0"
          >
            <button
              onClick={() => {
                toggle(item.path);
              }}
              aria-pressed={ticked.has(item.path)}
              className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border ${
                ticked.has(item.path) ? "border-accent bg-accent text-white" : "border-line"
              }`}
            >
              {ticked.has(item.path) && <Check size={10} />}
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={item.path}>
              {item.shown}
            </span>
            {item.keeper && <span className="shrink-0 text-[10.5px] text-muted">{t("run.trashKeeper")}</span>}
          </li>
        ))}
      </ul>
      <button
        onClick={() => {
          onSweep([...ticked]);
        }}
        disabled={ticked.size === 0}
        className="hover:border-danger hover:text-danger mt-2 rounded border border-line px-2 py-1 text-[11.5px] text-muted disabled:cursor-default disabled:opacity-50"
      >
        {t("run.trashDelete", { count: ticked.size })}
      </button>
    </>
  );
}

/**
 * The runs this project kept.
 *
 * Deliberately not a graveyard of ids: each row says which item it was about,
 * when it ran and how it ended, because the question a reader brings here is
 * "what happened to that ticket?" rather than "which run was 1724500000000?".
 * A run that was cut off is offered back with the same words as a live one, so
 * picking work up a week later reads the same as picking it up after lunch.
 */
function Past({
  history,
  onOpen,
  onForget,
  current,
}: {
  history: SavedRun[];
  onOpen: (id: string) => Promise<void>;
  onForget: (id: string) => Promise<void>;
  current?: string;
}) {
  const t = useT();
  const { locale } = useI18n();
  const others = history.filter((saved) => saved.run.id !== current);

  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-baseline gap-2 text-[11px] tracking-wide text-muted uppercase">
        {t("run.history")}
        {others.length > 0 && (
          <span className="normal-case">{t("run.historyCount", { count: others.length })}</span>
        )}
      </h2>
      {others.length === 0 ? (
        <p className="text-[12.5px] text-muted">{t("run.historyEmpty")}</p>
      ) : (
        <ul className="rounded-md border border-line">
          {others.map((saved) => (
            <li
              key={saved.run.id}
              className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-0"
            >
              <button
                onClick={() => void onOpen(saved.run.id)}
                title={t("run.historyOpen")}
                className="min-w-0 flex-1 text-left"
              >
                <span className="line-clamp-1 text-[12.5px]">{saved.run.itemTitle}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                  <span>{whenText(String(saved.run.startedAt), locale)}</span>
                  <span>· {t(endingLabel(saved))}</span>
                  {saved.run.branch !== null && <span className="font-mono">· {saved.run.branch}</span>}
                </span>
              </button>
              <button
                onClick={() => void onForget(saved.run.id)}
                title={t("run.historyForget")}
                className="hover:text-danger shrink-0 rounded p-1 text-muted"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How a kept run ended, in the same words the panel uses while it is live. */
function endingLabel(saved: SavedRun): TranslationKey {
  const ended = saved.run.ended;
  if (ended === null) return saved.run.current === null ? "run.done" : "run.interrupted";
  switch (ended.kind) {
    case "done":
      return "run.done";
    case "blocked":
      return "run.blocked";
    case "waiting":
      return "run.waiting";
    case "cancelled":
      return "run.cancelled";
    case "failed":
      return "run.failed";
    case "interrupted":
      return "run.interrupted";
  }
}

/** How a run stopped, and the one button that answers it. */
function Ending({
  ending,
  onApprove,
  onResume,
}: {
  ending: Run["ended"];
  onApprove: () => void;
  onResume: () => void;
}) {
  const t = useT();
  if (ending === null) return null;

  if (ending.kind === "interrupted") {
    return (
      <div className="mt-4 rounded-lg border border-accent bg-accent-soft px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-medium text-accent">
          <CirclePause size={14} /> {t("run.interrupted")}
        </p>
        <p className="mt-1 text-[12.5px] text-fg/90">{t("run.interruptedWhy")}</p>
        <button
          onClick={onResume}
          className="mt-2.5 flex items-center gap-1.5 rounded bg-accent-strong px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
        >
          <Play size={12} /> {t("run.carryOn")}
        </button>
      </div>
    );
  }

  if (ending.kind === "waiting") {
    return (
      <div className="mt-4 rounded-lg border border-accent bg-accent-soft px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-medium text-accent">
          <CirclePause size={14} /> {t("run.waiting")}
        </p>
        <p className="mt-1 text-[12.5px] whitespace-pre-wrap text-fg/90">{ending.question}</p>
        {ending.phase === "design" && (
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

const WORKER_LABELS = {
  tools: "run.worker.tools",
  reader: "run.worker.reader",
  writer: "run.worker.writer",
} as const satisfies Record<string, TranslationKey>;

export type { PhaseResult };
