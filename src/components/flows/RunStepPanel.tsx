import { useState } from "react";
import { Check, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useT } from "../../i18n";
import type { Step } from "../../lib/flows/model";
import { stepInputIn, useFlows, type RunView, type StepView } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { abilityOf } from "./abilities";
import { DataView, LogView } from "./StepData";

type Tab = "input" | "output" | "log" | "error";

/**
 * The right-hand column of a run: one step's input, output and log, and for
 * a step that failed its error with the AI's reading of it - the change it
 * proposes, and the way to run again from there.
 */
export function RunStepPanel({ run, stepId }: { run: RunView; stepId: string | null }) {
  const t = useT();
  const step = run.flow.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    return (
      <aside className="border-l border-line bg-panel px-3 py-3 text-[12px] text-muted">
        {t("flows.run.pickStep")}
      </aside>
    );
  }
  const view = run.steps[step.id];
  // A fresh panel per step and outcome: it opens on what matters about it now.
  return <StepPanel key={`${step.id}:${view?.state ?? "idle"}`} run={run} step={step} view={view} />;
}

function StepPanel({ run, step, view }: { run: RunView; step: Step; view?: StepView }) {
  const t = useT();
  const failed = view?.state === "failed";
  const [tab, setTab] = useState<Tab>(firstTab(view?.state));
  const look = abilityOf(step);
  const Icon = look.icon;
  const tabs: Tab[] = failed ? ["input", "output", "error", "log"] : ["input", "output", "log"];
  const facts = [t(look.label), view === undefined ? "" : t(`flows.step.${view.state}`)];
  if (view !== undefined && view.round > 1) facts.push(t("flows.step.round", { n: view.round }));

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-line bg-panel text-[12px]"
      data-flow-run-step={step.id}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className={`grid size-7 shrink-0 place-items-center rounded-md ${look.swatch}`}>
          <Icon size={14} strokeWidth={2.4} />
        </span>
        <span className="min-w-0">
          <b className="block truncate font-semibold">{step.name}</b>
          <small className="block truncate text-[11px] text-muted">{facts.filter(Boolean).join(" · ")}</small>
        </span>
      </div>
      <div className="flex border-b border-line text-[11px]">
        {tabs.map((name) => (
          <button
            key={name}
            onClick={() => {
              setTab(name);
            }}
            className={`flex-1 border-b-2 py-1.5 ${
              tab === name
                ? name === "error"
                  ? "border-danger text-danger"
                  : "border-accent text-accent"
                : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {t(`flows.run.tab.${name}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "input" && (
          <DataView
            title={t("flows.inspector.inputOf")}
            value={stepInputIn(run, run.flow, step.id)}
            empty={t("flows.run.noData")}
          />
        )}
        {tab === "output" && (
          <DataView title={view?.summary ?? ""} value={view?.output?.value} empty={t("flows.run.noData")} />
        )}
        {tab === "log" && <LogView lines={view?.log} empty={t("flows.run.noLog")} />}
        {tab === "error" && <FailureReading run={run} step={step} error={view?.error ?? ""} />}
      </div>
    </aside>
  );
}

/** What a step's panel opens on: its error, what a person is asked about, its log while it runs. */
function firstTab(state: StepView["state"] | undefined): Tab {
  switch (state) {
    case "failed":
      return "error";
    case "waiting":
      return "input";
    case "running":
      return "log";
    default:
      return "output";
  }
}

/** A failed step: its error, the AI's reading with the change it proposes, and running again from here. */
function FailureReading({ run, step, error }: { run: RunView; step: Step; error: string }) {
  const t = useT();
  const explain = useFlows((s) => s.explain);
  const applyReading = useFlows((s) => s.applyReading);
  const rerunFrom = useFlows((s) => s.rerunFrom);
  const [busy, setBusy] = useState<"reading" | "applying" | null>(null);
  const reading = run.readings[step.id];
  const act = (kind: "reading" | "applying", work: () => Promise<void>, what: string) => {
    setBusy(kind);
    work()
      .catch(failedTo(what))
      .finally(() => {
        setBusy(null);
      });
  };
  return (
    <div className="flex flex-col gap-2 px-3 py-3" data-flow-failure={step.id}>
      <p className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-danger">
        {error}
      </p>
      <div className="rounded-md border border-accent/30 bg-accent-soft/40 px-2.5 py-2">
        <p className="flex items-center gap-1.5 font-semibold text-accent">
          <Sparkles size={12} /> {t("flows.failure.title")}
        </p>
        {reading === undefined ? (
          <button
            onClick={() => {
              act("reading", () => explain(run.id, step.id), t("flows.failure.read"));
            }}
            disabled={busy !== null}
            className={`${ghost} mt-2`}
            data-flow-read-failure
          >
            {busy === "reading" ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {t("flows.failure.read")}
          </button>
        ) : (
          <p className="mt-1.5 whitespace-pre-wrap" data-flow-reading>
            {reading.explanation}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {reading !== undefined && reading.change !== null && (
            <button
              onClick={() => {
                act("applying", () => applyReading(run.id, step.id), t("flows.failure.apply"));
              }}
              disabled={busy !== null}
              className={ghost}
              data-flow-apply-reading
            >
              {busy === "applying" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t("flows.failure.apply")}
            </button>
          )}
          <button
            onClick={() => {
              rerunFrom(run.id, step.id).catch(failedTo(t("flows.failure.rerun")));
            }}
            disabled={busy !== null}
            className={primary}
            data-flow-rerun
          >
            <RotateCcw size={12} /> {t("flows.failure.rerun")}
          </button>
        </div>
      </div>
    </div>
  );
}

const primary =
  "flex items-center gap-1 rounded px-3 py-1.5 font-medium text-white bg-accent-strong hover:opacity-90 disabled:opacity-50";
const ghost =
  "flex items-center gap-1 rounded border border-line bg-panel px-3 py-1.5 text-muted hover:border-accent hover:text-fg disabled:opacity-50";
