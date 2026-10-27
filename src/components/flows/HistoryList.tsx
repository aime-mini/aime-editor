import { useEffect, useState } from "react";
import { CheckCircle2, CircleSlash, Pencil, Play, RotateCcw, XCircle } from "lucide-react";
import { useI18n, useT } from "../../i18n";
import type { InputBundle } from "../../lib/flows/model";
import { useFlows, type RunHead, type RunView } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { FlowsBreadcrumb } from "./Breadcrumb";
import { RunBody, stepThatMatters } from "./RunScreen";
import { outcomeOf, type RunOutcome } from "./useNewestRuns";

/**
 * Every run of a flow, as designed (screen 06): the runs newest first on the
 * left - when, how it ended, what it was given and cost - and the one picked
 * read back on the canvas beside them, each step's input, output and log a
 * click away. A run can be run again with the same input, and one the app was
 * closed in the middle of can be carried on.
 */
export function HistoryList({ slug }: { slug: string }) {
  const t = useT();
  const listRuns = useFlows((s) => s.listRuns);
  const loadRun = useFlows((s) => s.loadRun);
  const openDesigner = useFlows((s) => s.openDesigner);
  const rerunFrom = useFlows((s) => s.rerunFrom);
  const flow = useFlows((s) => s.flows.find((candidate) => candidate.slug === slug));
  const [heads, setHeads] = useState<RunHead[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const run = useFlows((s) =>
    chosen === null ? undefined : (s.runs as Partial<Record<string, RunView>>)[chosen],
  );

  useEffect(() => {
    listRuns(slug)
      .then((found) => {
        setHeads(found);
        setChosen((current) => current ?? found.at(0)?.run ?? null);
      })
      .catch(failedTo(t("flows.history.title")));
  }, [listRuns, slug, t]);

  useEffect(() => {
    if (chosen === null) return;
    loadRun(slug, chosen).catch(failedTo(t("flows.history.read")));
  }, [chosen, loadRun, slug, t]);

  const input = run?.flow.steps.find((candidate) => candidate.config.ability === "input");

  return (
    <div className="flex h-full flex-col text-[12px]" data-flow-history={slug}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <FlowsBreadcrumb>
          <span className="truncate font-semibold">{flow?.flow.name ?? slug}</span>
          <span className="text-muted">/</span>
          <span className="text-muted">{t("flows.history.title")}</span>
        </FlowsBreadcrumb>
        <span className="flex-1" />
        <button
          onClick={() => {
            openDesigner(slug);
          }}
          className={ghost}
        >
          <Pencil size={12} /> {t("flows.history.edit")}
        </button>
        {run !== undefined && input !== undefined && run.status !== "running" && (
          <button
            onClick={() => {
              rerunFrom(run.id, input.id).catch(failedTo(t("flows.history.again")));
            }}
            className={ghost}
            data-flow-run-again
          >
            <RotateCcw size={12} /> {t("flows.history.again")}
          </button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,264px)_1fr_minmax(260px,300px)]">
        <RunList
          slug={slug}
          heads={heads}
          chosen={chosen}
          onChoose={(id) => {
            setChosen(id);
            setStep(null);
          }}
        />
        {run === undefined ? (
          <p className="col-span-2 px-4 py-4 text-muted">
            {heads?.length === 0 ? t("flows.history.empty") : t("flows.history.loading")}
          </p>
        ) : (
          <RunBody run={run} selected={step ?? stepThatMatters(run)} onSelect={setStep} />
        )}
      </div>
    </div>
  );
}

function RunList({
  slug,
  heads,
  chosen,
  onChoose,
}: {
  slug: string;
  heads: RunHead[] | null;
  chosen: string | null;
  onChoose: (id: string) => void;
}) {
  const t = useT();
  const locale = useI18n((state) => state.locale);
  const resume = useFlows((s) => s.resume);
  const openRun = useFlows((s) => s.openRun);
  if (heads === null)
    return <p className="border-r border-line bg-panel px-3 py-3 text-muted">{t("flows.history.loading")}</p>;
  return (
    <ul className="min-h-0 overflow-y-auto border-r border-line bg-panel">
      {heads.map((head) => {
        const outcome = outcomeOf(head);
        const given = head.first.kind === "run-started" ? givenLine(head.first.bundle, t) : "";
        const cost = head.last.kind === "run-done" ? `$${head.last.costUsd.toFixed(2)}` : "";
        return (
          <li key={head.run} data-flow-history-run={head.run}>
            <button
              onClick={() => {
                onChoose(head.run);
              }}
              className={`flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left ${
                chosen === head.run
                  ? "bg-elevated shadow-[inset_2px_0_0_var(--accent)]"
                  : "hover:bg-elevated/60"
              }`}
            >
              <OutcomeIcon outcome={outcome} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="flex-1 truncate font-medium">{t(`flows.history.${outcome}`)}</span>
                  <span className="shrink-0 text-[10.5px] text-muted">
                    {new Date(head.first.at).toLocaleString(locale, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {[given, cost].filter((part) => part !== "").join(" · ")}
                </span>
              </span>
            </button>
            {outcome === "interrupted" && (
              <button
                onClick={() => {
                  openRun(head.run);
                  void resume(slug, head.run).catch(failedTo(t("flows.history.resume")));
                }}
                className="mx-3 mb-2 flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-fg"
              >
                <Play size={11} /> {t("flows.history.resume")}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What a run was given, in a few words: the first line of its text, else how many things it was handed. */
function givenLine(bundle: InputBundle, t: ReturnType<typeof useT>): string {
  const text = bundle.text.trim().split("\n")[0] ?? "";
  if (text !== "") return text;
  return bundle.items.length === 0 ? "" : t("flows.history.items", { n: bundle.items.length });
}

function OutcomeIcon({ outcome }: { outcome: RunOutcome }) {
  const box = "mt-px shrink-0";
  switch (outcome) {
    case "done":
      return <CheckCircle2 size={14} className={`${box} text-ok`} />;
    case "failed":
      return <XCircle size={14} className={`${box} text-danger`} />;
    case "cancelled":
    case "interrupted":
      return <CircleSlash size={14} className={`${box} text-muted`} />;
  }
}

const ghost =
  "flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg";
