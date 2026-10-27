import { useEffect, useState } from "react";
import {
  Copy,
  Download,
  KeyRound,
  Loader2,
  LogIn,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n/en";
import { emptyFlow, slugOf, type Flow } from "../../lib/flows/model";
import { TEMPLATES } from "../../lib/flows/templates";
import { validate } from "../../lib/flows/validate";
import { useFlows, type StoredFlow } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { PromptModal } from "../PromptModal";
import { ABILITIES } from "./abilities";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { RunDialog } from "./RunDialog";
import { outcomeOf, useNewestRuns } from "./useNewestRuns";

/**
 * The flows of this project, as the design's first screen: one sentence is
 * enough for Aime to draw a flow; the project's flows as cards; the person's
 * own; the templates. What was handed in from elsewhere (a file, a ticket)
 * waits at the top for a flow to run with.
 */
export function FlowsHub() {
  const t = useT();
  const {
    flows,
    mine,
    runs,
    drawing,
    pendingInput,
    draw,
    save: saveFlow,
    remove,
    removeMine,
    copyToProject,
    copyToMine,
    takeTemplate,
    openDesigner,
    loadMine,
    loadSecrets,
    openRun,
    resume,
  } = useFlows();
  const newestRuns = useNewestRuns(flows);
  const [description, setDescription] = useState("");
  const [naming, setNaming] = useState(false);
  const [running, setRunning] = useState<StoredFlow | null>(null);
  const [connections, setConnections] = useState(false);

  useEffect(() => {
    void loadMine().catch(failedTo(t("flows.hub.mine")));
    void loadSecrets().catch(failedTo(t("flows.hub.connections")));
  }, [loadMine, loadSecrets, t]);

  const drawIt = async () => {
    const text = description.trim();
    if (text === "") return;
    const slug = await draw(text);
    setDescription("");
    openDesigner(slug);
  };

  const create = async (name: string) => {
    const slug = uniqueSlug(
      slugOf(name),
      flows.map((flow) => flow.slug),
    );
    await saveFlow(slug, emptyFlow(name));
    openDesigner(slug);
  };

  const importFlow = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Flow", extensions: ["json"] }],
    });
    if (picked === null) return;
    const text = await invoke<string>("read_file", { path: picked });
    const flow = JSON.parse(text) as Flow;
    const errors = validate(flow).filter((problem) => problem.kind === "error");
    if (errors.length > 0) throw new Error(errors.map((problem) => problem.message).join("; "));
    const slug = uniqueSlug(
      slugOf(flow.name),
      flows.map((stored) => stored.slug),
    );
    await saveFlow(slug, flow);
    openDesigner(slug);
  };

  const exportFlow = async (stored: StoredFlow) => {
    const target = await save({
      defaultPath: `${stored.slug}.json`,
      filters: [{ name: "Flow", extensions: ["json"] }],
    });
    if (target === null) return;
    await invoke("write_file", { path: target, content: JSON.stringify(stored.flow, null, 2) });
  };

  const lastOf = (slug: string) =>
    Object.values(runs)
      .filter((run) => run.slug === slug && !run.id.startsWith("try-"))
      .sort((a, b) => b.startedAt - a.startedAt)
      .at(0);

  /** The card's word on the flow: this session's newest run, else the newest one on disk. */
  const statusOf = (slug: string): CardStatus => {
    const live = lastOf(slug);
    if (live !== undefined) {
      const tone = live.status === "done" ? "ok" : live.status === "failed" ? "bad" : "busy";
      return { label: t(`flows.status.${live.status}`), tone, interrupted: null };
    }
    const head = newestRuns.get(slug);
    if (head === undefined) return { label: t("flows.hub.neverRan"), tone: "none", interrupted: null };
    const outcome = outcomeOf(head);
    const tone = outcome === "done" ? "ok" : outcome === "failed" ? "bad" : "none";
    return {
      label: t(`flows.history.${outcome}`),
      tone,
      interrupted: outcome === "interrupted" ? head.run : null,
    };
  };

  const carryOn = (slug: string, run: string) => {
    openRun(run);
    void resume(slug, run).catch(failedTo(t("flows.history.resume")));
  };

  const examples: TranslationKey[] = [
    "flows.hub.example1",
    "flows.hub.example2",
    "flows.hub.example3",
    "flows.hub.example4",
  ];

  return (
    <div className="h-full overflow-y-auto px-6 py-5 text-[12px]" data-flows-hub>
      {pendingInput !== null && (
        <div
          className="mb-4 flex items-center gap-2 rounded-lg border border-accent/50 bg-accent-soft/40 px-3 py-2"
          data-flows-pending
        >
          <Play size={13} className="text-accent" />
          <span className="flex-1">
            {t("flows.hub.pending", {
              what:
                pendingInput.items.map((item) => item.ref.split(/[\\/]/).pop()).join(", ") ||
                pendingInput.text,
            })}
          </span>
          <button
            onClick={() => {
              useFlows.setState({ pendingInput: null });
            }}
            className="rounded p-1 text-muted hover:text-fg"
            title={t("common.cancel")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <section className="mb-6 rounded-xl border border-line bg-panel p-4">
        <div className="flex items-start gap-3">
          <Sparkles size={16} className="mt-1 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey))
                  void drawIt().catch(failedTo(t("flows.hub.draw")));
              }}
              placeholder={t("flows.hub.drawPlaceholder")}
              rows={2}
              className="w-full resize-none rounded-lg border border-line bg-elevated px-3 py-2 text-[13px] outline-none focus:border-accent"
              data-flows-draw-input
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">{t("flows.hub.examples")}</span>
              {examples.map((key) => (
                <button
                  key={key}
                  onClick={() => {
                    setDescription(t(key));
                  }}
                  className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => void drawIt().catch(failedTo(t("flows.hub.draw")))}
            disabled={drawing || description.trim() === ""}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent-strong px-3 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            data-flows-draw
          >
            {drawing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}{" "}
            {t("flows.hub.draw")}
          </button>
        </div>
      </section>

      <SectionTitle title={t("flows.hub.project")} note={t("flows.hub.projectNote", { n: flows.length })}>
        <button
          onClick={() => {
            setNaming(true);
          }}
          className={ghost}
          data-flows-new
        >
          <Plus size={12} /> {t("flows.panel.new")}
        </button>
        <button onClick={() => void importFlow().catch(failedTo(t("flows.hub.import")))} className={ghost}>
          <Upload size={12} /> {t("flows.hub.import")}
        </button>
        <button
          onClick={() => {
            setConnections(true);
          }}
          className={ghost}
          data-flows-connections
        >
          <KeyRound size={12} /> {t("flows.hub.connections")}
        </button>
      </SectionTitle>
      <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {flows.map((stored) => {
          const status = statusOf(stored.slug);
          const errors = validate(stored.flow).filter((problem) => problem.kind === "error").length;
          return (
            <article
              key={stored.slug}
              className="flex flex-col rounded-lg border border-line bg-panel p-3"
              data-flows-card={stored.slug}
            >
              <Strip flow={stored.flow} />
              <b className="mt-2 text-[13px] font-semibold">{stored.flow.name}</b>
              <p className="mt-1 line-clamp-2 min-h-[2.6em] text-[11.5px] text-muted">
                {stored.flow.description || t("flows.hub.noDescription")}
              </p>
              <p className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted">
                <LogIn size={11} className="shrink-0" />
                {/* Its own box: an ellipsis needs one, a flex row's bare text gets none. */}
                <span className="truncate">
                  {stored.flow.input.hints.length > 0
                    ? stored.flow.input.hints.map((hint) => hint.name).join(" · ")
                    : t("flows.inspector.inputFree")}
                </span>
              </p>
              {/* The actions wrap under the status on a narrow card rather than squeezing it onto two lines. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line pt-2">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] whitespace-nowrap ${STATUS_TONE[status.tone]}`}
                  data-flows-status={stored.slug}
                >
                  {status.label}
                </span>
                {status.interrupted !== null && (
                  <button
                    onClick={() => {
                      carryOn(stored.slug, status.interrupted ?? "");
                    }}
                    className={ghost}
                    data-flows-resume={stored.slug}
                  >
                    <Play size={11} /> {t("flows.history.resume")}
                  </button>
                )}
                {errors > 0 && (
                  <span className="shrink-0 text-[10.5px] whitespace-nowrap text-danger">
                    {t("flows.designer.problems", { n: errors })}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => {
                      setRunning(stored);
                    }}
                    disabled={errors > 0}
                    className="flex items-center gap-1 rounded-md bg-accent-strong px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                    data-flows-run={stored.slug}
                  >
                    <Play size={11} /> {t("flows.designer.run")}
                  </button>
                  <button
                    onClick={() => {
                      openDesigner(stored.slug);
                    }}
                    className={icon}
                    title={t("flows.panel.open")}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => void exportFlow(stored).catch(failedTo(t("flows.hub.export")))}
                    className={icon}
                    title={t("flows.hub.export")}
                  >
                    <Download size={12} />
                  </button>
                  <button
                    onClick={() => void copyToMine(stored.slug).catch(failedTo(t("flows.hub.keep")))}
                    className={icon}
                    title={t("flows.hub.keep")}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    onClick={() => void remove(stored.slug).catch(failedTo(t("flows.panel.delete")))}
                    className={`${icon} hover:text-danger`}
                    title={t("flows.panel.delete")}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
        {flows.length === 0 && <p className="text-muted">{t("flows.panel.empty")}</p>}
      </div>

      <SectionTitle title={t("flows.hub.mine")} note={t("flows.hub.mineNote")} />
      <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {mine.map((stored) => (
          <article key={stored.slug} className="flex flex-col rounded-lg border border-line bg-panel p-3">
            <Strip flow={stored.flow} />
            <b className="mt-2 text-[13px] font-semibold">{stored.flow.name}</b>
            <p className="mt-1 line-clamp-2 min-h-[2.6em] text-[11.5px] text-muted">
              {stored.flow.description || t("flows.hub.noDescription")}
            </p>
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
              <span className="flex-1" />
              <button
                onClick={() =>
                  void copyToProject(stored.slug)
                    .then(openDesigner)
                    .catch(failedTo(t("flows.hub.useHere")))
                }
                className={ghost}
              >
                <Copy size={11} /> {t("flows.hub.useHere")}
              </button>
              <button
                onClick={() => void removeMine(stored.slug).catch(failedTo(t("flows.panel.delete")))}
                className={`${icon} hover:text-danger`}
                title={t("flows.panel.delete")}
              >
                <X size={12} />
              </button>
            </div>
          </article>
        ))}
        {mine.length === 0 && <p className="text-muted">{t("flows.hub.mineEmpty")}</p>}
      </div>

      <SectionTitle title={t("flows.hub.templates")} note={t("flows.hub.templatesNote")} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {TEMPLATES.map((template) => (
          <article
            key={template.key}
            className="flex flex-col rounded-lg border border-dashed border-line bg-panel/60 p-3"
            data-flows-template={template.key}
          >
            <Strip flow={template.flow} />
            <b className="mt-2 text-[13px] font-semibold">
              {t(`flows.template.${template.key}` as TranslationKey)}
            </b>
            <p className="mt-1 line-clamp-3 text-[11.5px] text-muted">
              {t(`flows.template.${template.key}.note` as TranslationKey)}
            </p>
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
              <span className="text-[10.5px] text-muted">
                {t("flows.designer.steps", { n: template.flow.steps.length })}
              </span>
              <span className="flex-1" />
              <button
                onClick={() =>
                  void takeTemplate(template.key)
                    .then(openDesigner)
                    .catch(failedTo(t("flows.hub.useTemplate")))
                }
                className={ghost}
                data-flows-template-use
              >
                {t("flows.hub.useTemplate")}
              </button>
            </div>
          </article>
        ))}
      </div>

      {naming && (
        <PromptModal
          title={t("flows.panel.newTitle")}
          initialValue={t("flows.panel.newDefault")}
          submitLabel={t("flows.panel.create")}
          onSubmit={(name) => {
            setNaming(false);
            void create(name).catch(failedTo(t("flows.panel.newTitle")));
          }}
          onClose={() => {
            setNaming(false);
          }}
        />
      )}
      {running !== null && (
        <RunDialog
          slug={running.slug}
          flow={running.flow}
          onClose={() => {
            setRunning(null);
          }}
        />
      )}
      {connections && (
        <ConnectionsDialog
          onClose={() => {
            setConnections(false);
          }}
        />
      )}
    </div>
  );
}

function SectionTitle({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Workflow size={13} className="text-accent" />
      <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</h2>
      {note !== undefined && <span className="text-[11px] text-muted/70">{note}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** The steps of a flow as a strip of their colours - what a card says about the shape of a flow. */
function Strip({ flow }: { flow: Flow }) {
  return (
    <div className="flex items-center gap-0.5">
      {flow.steps.map((step) => (
        <i
          key={step.id}
          className={`h-1.5 w-4 rounded-sm ${ABILITIES[step.config.ability].swatch.split(" ")[0]}`}
          title={step.name}
        />
      ))}
    </div>
  );
}

function uniqueSlug(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${String(n)}`)) n += 1;
  return `${base}-${String(n)}`;
}

const ghost =
  "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-fg";
const icon = "rounded p-1 text-muted hover:bg-elevated hover:text-fg";

/** What a card says about its flow's runs, and the run it can carry on. */
interface CardStatus {
  label: string;
  tone: "none" | "ok" | "bad" | "busy";
  interrupted: string | null;
}

const STATUS_TONE: Record<CardStatus["tone"], string> = {
  none: "bg-elevated text-muted",
  ok: "bg-ok/15 text-ok",
  bad: "bg-danger/15 text-danger",
  busy: "bg-accent-soft text-accent",
};
