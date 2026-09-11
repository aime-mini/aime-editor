import { createElement, useMemo, useState } from "react";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MapPin,
  Play,
  Plug,
  RefreshCw,
  Sparkles,
  Tag,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "../i18n";
import { CloudOps } from "./CloudOps";
import type { TranslationKey } from "../i18n/en";
import { disabledApi, enableApiCommand, shortCliError, type DisabledApi } from "../lib/cloudErrors";
import { shortKind } from "../lib/cloudIcons";
import { mapOf, UNTAGGED } from "../lib/cloudMap";
import { connectionRows, countOf, propertiesOf, type PropertyRow } from "../lib/cloudProperties";
import { commandOf, factFor, type PlannedRead } from "../lib/cloudReads";
import {
  answerKey,
  slotOf,
  useCloud,
  type AnswerState,
  type CloudResource,
  type PlanState,
} from "../stores/cloud";
import { ServiceBadge, TIER_LABELS } from "./CloudMap";
import { runInTerminal } from "../stores/terminals";

/**
 * One resource, opened: what it is, how it is configured, how to connect to it.
 *
 * Laid out the way the AWS Toolkit and the Azure portal lay a resource out - a
 * header that says what this is, then tabs - because that is the shape people
 * already know how to read. The configuration comes from the CLI itself,
 * through reads the AI planned ONCE for this kind and Aime checked
 * (`stores/cloud.ts`, `cloud/reads.rs`); the first resource of a kind waits for
 * that plan, every later one does not.
 *
 * The connection tab is the point of the whole panel for a developer: the
 * endpoint, the host, the port, pulled out of whatever the payload called them
 * and put first, each with a copy button. Anything that can carry a credential
 * is behind its own click, shown only here, and never written anywhere.
 */
export function CloudDetail({ resource }: { resource: CloudResource }) {
  const t = useT();
  const openDetail = useCloud((s) => s.openDetail);
  const tab = useCloud((s) => s.tab);
  const plan = useCloud((s) => s.plans[slotOf(s.tab, resource.kind)]);
  const [pane, setPane] = useState<Pane>("overview");
  const tags = Object.entries(resource.tags);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-12"
      onClick={() => {
        openDetail(null);
      }}
    >
      <section
        className="flex max-h-[85vh] w-[860px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <ServiceBadge kind={resource.kind} size={6} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 truncate text-[15px] font-semibold">{resource.name}</h2>
              <span
                className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[11px] text-muted"
                title={resource.kind}
              >
                {shortKind(resource.kind)}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
              {resource.location !== "" && (
                <span className="flex items-center gap-1">
                  <MapPin size={11} /> {resource.location}
                </span>
              )}
              {resource.group !== "" && <span>{resource.group}</span>}
              <span className="flex items-center gap-1 uppercase tracking-wide">{tab}</span>
            </div>
          </div>
          <CopyButton text={resource.id} label={t("cloud.copyId")} />
          <button
            onClick={() => {
              openDetail(null);
            }}
            title={t("cloud.close")}
            className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={14} />
          </button>
        </header>

        <nav className="flex shrink-0 gap-1 border-b border-line px-3">
          {PANES.map((candidate) => (
            <button
              key={candidate}
              onClick={() => {
                setPane(candidate);
              }}
              className={`border-b-2 px-3 py-1.5 ${
                pane === candidate
                  ? "border-accent font-medium text-fg"
                  : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t(PANE_LABELS[candidate])}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {pane === "overview" && <OverviewPane resource={resource} plan={plan} tags={tags} />}
          {pane === "connect" && <ConnectPane resource={resource} plan={plan} />}
          {pane === "ops" && <CloudOps resource={resource} />}
          {pane === "related" && <RelatedPane resource={resource} />}
          {pane === "raw" && <RawPane resource={resource} plan={plan} />}
        </div>
      </section>
    </div>
  );
}

type Pane = "overview" | "connect" | "ops" | "related" | "raw";
const PANES: Pane[] = ["overview", "connect", "ops", "related", "raw"];
const PANE_LABELS: Record<Pane, TranslationKey> = {
  overview: "cloud.paneOverview",
  connect: "cloud.paneConnect",
  ops: "cloud.opsTitle",
  related: "cloud.paneRelated",
  raw: "cloud.paneRaw",
};

/** The configuration, from the reads planned as `overview`, and the facts already in hand. */
function OverviewPane({
  resource,
  plan,
  tags,
}: {
  resource: CloudResource;
  plan: PlanState | undefined;
  tags: [string, string][];
}) {
  const t = useT();
  const reads = plan?.kind === "ready" ? plan.reads.filter((read) => read.purpose === "overview") : [];

  return (
    <div className="flex flex-col gap-4">
      <PlanNotice plan={plan} resource={resource} expecting={reads.length === 0} />
      {reads.map((read) => (
        <ReadBlock key={read.label} resource={resource} read={read} />
      ))}

      <section>
        <SectionLabel icon={Tag} text={t("cloud.tags", { count: tags.length })} />
        {tags.length === 0 ? (
          <p className="text-muted">{t("cloud.noTags")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map(([key, value]) => (
              <span key={key} className="flex items-center rounded-md border border-line bg-bg text-[11px]">
                <span className="px-1.5 py-0.5 text-muted">{key}</span>
                <span className="border-l border-line px-1.5 py-0.5">{value === "" ? "—" : value}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionLabel icon={Braces} text={t("cloud.field.id")} />
        <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-2 py-1.5">
          <code className="min-w-0 flex-1 break-all text-[11px]">{resource.id}</code>
          <CopyButton text={resource.id} label={t("cloud.copyId")} />
        </div>
      </section>
    </div>
  );
}

/**
 * How to connect: the connection rows first, then the reads that carry them,
 * then the secrets behind their own click.
 */
function ConnectPane({ resource, plan }: { resource: CloudResource; plan: PlanState | undefined }) {
  const t = useT();
  const cloudId = useCloud((s) => s.tab);
  const answers = useCloud((s) => s.answers);
  const reads = plan?.kind === "ready" ? plan.reads : [];
  const open = reads.filter((read) => read.purpose !== "secret");
  const secrets = reads.filter((read) => read.purpose === "secret");
  // What a developer pastes, worked out from the resource's own identity: no
  // call, no waiting, and for a topic or a bucket it is the whole answer. A
  // fact this particular resource cannot fill in is left out (`factFor`).
  const facts = (plan?.kind === "ready" ? plan.facts : []).flatMap((fact) => {
    const value = factFor(fact, resource);
    return value === null ? [] : [{ key: fact.label, kind: "value" as const, value }];
  });

  // Whatever the loaded answers call an endpoint, pulled to the top.
  const highlights = useMemo(() => {
    const rows: PropertyRow[] = [];
    for (const read of open) {
      const answer = answers[answerKey(resource, read)];
      if (answer?.kind === "loaded") rows.push(...connectionRows(propertiesOf(answer.json)));
    }
    return rows;
  }, [answers, open, resource]);

  return (
    <div className="flex flex-col gap-4">
      {/* What Aime already holds, before any read runs: reported 2026-09-09,
          the first resource of a kind showed nothing but "asking the AI" on
          exactly the tab a developer opens - and the identifier, the region
          and the account are half of what gets pasted into a config. */}
      <section>
        <SectionLabel icon={Braces} text={t("cloud.connectIdentity")} />
        <PropertyTable rows={identityRows(resource, cloudId, t)} />
      </section>

      {facts.length > 0 && (
        <section>
          <SectionLabel icon={Plug} text={t("cloud.connectFacts")} />
          <PropertyTable rows={facts} highlight />
        </section>
      )}

      <PlanNotice plan={plan} resource={resource} expecting={reads.length === 0} />

      {highlights.length > 0 && (
        <section>
          <SectionLabel icon={Sparkles} text={t("cloud.connectHighlights")} />
          <PropertyTable rows={highlights} highlight />
        </section>
      )}

      {open
        .filter((read) => read.purpose === "connection")
        .map((read) => (
          <ReadBlock key={read.label} resource={resource} read={read} />
        ))}

      {secrets.length > 0 && (
        <section>
          <SectionLabel icon={EyeOff} text={t("cloud.secrets", { count: secrets.length })} />
          <p className="mb-2 text-[11px] text-muted">{t("cloud.secretsHint")}</p>
          <div className="flex flex-col gap-2">
            {secrets.map((read) => (
              <ReadBlock key={read.label} resource={resource} read={read} />
            ))}
          </div>
        </section>
      )}

      {plan?.kind === "ready" &&
        open.filter((read) => read.purpose === "connection").length === 0 &&
        secrets.length === 0 && <p className="text-muted">{t("cloud.connectNone")}</p>}
    </div>
  );
}

/**
 * The rows Aime can fill in with no call at all: the identifier the cloud gave
 * this resource, where it lives, and which account it is in. For an AWS
 * resource the identifier IS the ARN, which is what an application config
 * asks for - so it is here, copyable, before any read has run.
 */
function identityRows(
  resource: CloudResource,
  cloudId: string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): PropertyRow[] {
  const rows: PropertyRow[] = [{ key: t("cloud.field.id"), kind: "value", value: resource.id }];
  if (resource.location !== "") {
    rows.push({ key: t("cloud.field.location"), kind: "value", value: resource.location });
  }
  if (resource.group !== "") {
    rows.push({ key: t("cloud.field.group"), kind: "value", value: resource.group });
  }
  rows.push({ key: t("cloud.field.cloud"), kind: "value", value: cloudId });
  return rows;
}

/**
 * Where the plan stands, said only when there is something to say: while the AI
 * is planning this kind, when planning failed, and when the plan holds nothing
 * for this pane - each with what it means and what was refused.
 */
function PlanNotice({
  plan,
  resource,
  expecting,
}: {
  plan: PlanState | undefined;
  resource: CloudResource;
  expecting: boolean;
}) {
  const t = useT();
  const kind = shortKind(resource.kind);
  if (plan === undefined || plan.kind === "planning") {
    return (
      <Note icon={Loader2} spin>
        {t("cloud.planning", { kind })}
      </Note>
    );
  }
  if (plan.kind === "failed") {
    return (
      <Note icon={TriangleAlert} tone="danger">
        {plan.reason}
      </Note>
    );
  }
  return (
    <>
      {expecting && <Note icon={Braces}>{t("cloud.readsNone")}</Note>}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
        {plan.rejected.length > 0 && <Rejected rejected={plan.rejected} />}
        <Replan resource={resource} kind={kind} />
      </div>
    </>
  );
}

/**
 * Asks the AI again how this kind is read. Here because a plan is proven
 * against the CLI's grammar and not against the cloud: `gcloud projects
 * describe <path>` passed every check and the service answered
 * INVALID_ARGUMENT (2026-09-05), and without this the wrong plan would have
 * been every project's answer for good.
 */
function Replan({ resource, kind }: { resource: CloudResource; kind: string }) {
  const t = useT();
  const replan = useCloud((s) => s.replan);
  return (
    <button
      onClick={() => void replan(resource)}
      title={t("cloud.replanHint")}
      className="flex items-center gap-1 hover:text-fg"
    >
      <RefreshCw size={11} />
      {t("cloud.replan", { kind })}
    </button>
  );
}

/** The reads Aime refused, folded: useful when the plan looks thin, noise otherwise. */
function Rejected({ rejected }: { rejected: { label: string; reason: string }[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[11px] text-muted">
      <button
        onClick={() => {
          setOpen(!open);
        }}
        className="flex items-center gap-1 hover:text-fg"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {t("cloud.rejectedReads", { count: rejected.length })}
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 pl-4">
          {rejected.map((entry) => (
            <li key={entry.label}>
              <code>{entry.label}</code> — {entry.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One planned read and its answer: the command as a heading a developer can
 * copy and run themselves, the answer as a table.
 *
 * A `secret` read waits for the click here and nowhere else; its answer stays
 * in this store and this pane, and a second click hides it again.
 */
function ReadBlock({ resource, read }: { resource: CloudResource; read: PlannedRead }) {
  const t = useT();
  const cloudId = useCloud((s) => s.tab);
  const account = useCloud((s) => s.selected[s.tab] ?? "");
  const answer = useCloud((s) => s.answers[answerKey(resource, read)]);
  const runRead = useCloud((s) => s.runRead);
  const [hidden, setHidden] = useState(false);
  const secret = read.purpose === "secret";
  const rows = useMemo(() => (answer?.kind === "loaded" ? propertiesOf(answer.json) : []), [answer]);
  const command = commandOf(cloudId, account, resource, read);

  return (
    <section className={`rounded-lg border ${secret ? "border-warn/40" : "border-line"}`}>
      <header className="flex items-center gap-2 border-b border-line bg-bg/60 px-2.5 py-1.5">
        {secret ? (
          <EyeOff size={12} className="shrink-0 text-warn" />
        ) : (
          <Play size={12} className="shrink-0 text-accent" />
        )}
        <code className="min-w-0 flex-1 truncate text-[11px]" title={command}>
          {read.label}
        </code>
        <AnswerStatus answer={answer} rows={rows} />
        <CopyButton text={command} label={t("cloud.copyCommand")} />
        {secret ? (
          <button
            onClick={() => {
              if (answer?.kind === "loaded") setHidden(!hidden);
              else void runRead(resource, read);
            }}
            className="flex shrink-0 items-center gap-1 rounded border border-warn/60 px-2 py-0.5 text-warn hover:bg-warn/10"
          >
            {answer?.kind === "loaded" && !hidden ? <EyeOff size={11} /> : <Eye size={11} />}
            {answer?.kind === "loaded" && !hidden ? t("cloud.hideSecret") : t("cloud.revealSecret")}
          </button>
        ) : (
          <button
            onClick={() => void runRead(resource, read)}
            title={t("cloud.readAgain")}
            className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <RefreshCw size={11} />
          </button>
        )}
      </header>
      {answer?.kind === "failed" && (
        <ReadFailure reason={answer.reason} onFixed={() => void runRead(resource, read)} />
      )}
      {answer?.kind === "loaded" && !(secret && hidden) && (
        <div className="p-2">
          <PropertyTable rows={rows} />
        </div>
      )}
    </section>
  );
}

/** The state of one answer, in one word and an icon. */
function AnswerStatus({ answer, rows }: { answer: AnswerState | undefined; rows: PropertyRow[] }) {
  const t = useT();
  if (answer === undefined) return null;
  if (answer.kind === "loading") return <Loader2 size={12} className="shrink-0 animate-spin text-muted" />;
  if (answer.kind === "failed") return <TriangleAlert size={12} className="shrink-0 text-danger" />;
  return (
    <span className="shrink-0 text-[10px] text-muted">
      {t("cloud.propertyCount", { count: countOf(rows) })}
    </span>
  );
}

/**
 * Why a read has no answer, and - when the CLI named one - the way past it.
 *
 * A read that fails on a project with the API switched off is the common case
 * and the one worth acting on: measured 2026-09-11 across a real Google
 * account, 12 of 26 log sinks answered nothing else, and the sentence that
 * comes back names both the API and the page that enables it. Showing that as
 * plain red text asks a developer to read a paragraph and go to the console;
 * the button is the same command Aime would have run anyway.
 */
function ReadFailure({ reason, onFixed }: { reason: string; onFixed: () => void }) {
  const t = useT();
  const offApi = useMemo(() => disabledApi(reason), [reason]);
  return (
    <div className="flex flex-col gap-2 p-2.5">
      <pre className="max-h-40 overflow-auto text-[11px] whitespace-pre-wrap text-danger">
        {failureText(reason, t)}
      </pre>
      {offApi !== null && <ApiOffFix api={offApi} onEnabled={onFixed} />}
    </div>
  );
}

/**
 * Turns on the API this read needs, in a terminal where it can be watched.
 *
 * The same rule as everywhere else in this panel: enabling an API is a write
 * to the user's own project, so the exact command is on the button and the
 * click is the consent.
 */
function ApiOffFix({ api, onEnabled }: { api: DisabledApi; onEnabled: () => void }) {
  const t = useT();
  const command = enableApiCommand(api);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {command !== null && (
        <button
          onClick={() => {
            runInTerminal(command, t("cloud.apiEnabling", { api: api.display }));
            onEnabled();
          }}
          title={command}
          className="flex items-center gap-1.5 rounded bg-accent px-2 py-1 text-[11px] font-medium text-bg"
        >
          <Play size={11} /> {t("cloud.apiEnable", { api: api.display })}
        </button>
      )}
      {api.url !== null && (
        <button
          onClick={() => void openUrl(api.url ?? "")}
          className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-fg"
        >
          <ExternalLink size={11} /> {t("cloud.apiOpenPage")}
        </button>
      )}
    </div>
  );
}

/**
 * The backend's structured refusal, turned into a sentence; anything else is
 * the CLI's own words, cut to the ones a person reads - `gcloud` answers a
 * wrong identifier with a whole HTML error page (`shortCliError`).
 */
function failureText(reason: string, t: ReturnType<typeof useT>): string {
  const unsupported = /^UNSUPPORTED_READ::(.+)$/.exec(reason);
  return unsupported === null
    ? shortCliError(reason)
    : t("cloud.readUnsupported", { command: unsupported[1] });
}

/**
 * Properties as a two-column table, nested groups folded under their key.
 *
 * Top-level sections start open and everything nested inside them folded: a
 * describe answer's `VpcConfig` or `Environment` is there when wanted and out
 * of the way when not, and the values a person opened the resource for are on
 * screen without a click.
 */
export function PropertyTable({ rows, highlight = false }: { rows: PropertyRow[]; highlight?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-md border ${highlight ? "border-accent/40" : "border-line"}`}>
      {rows.map((row, index) => (
        <PropertyLine key={`${row.key}-${String(index)}`} row={row} depth={0} highlight={highlight} />
      ))}
    </div>
  );
}

/** Values that read better in a monospace face: identifiers, addresses, paths. */
const CODE_LIKE = /^(arn:|https?:|\/|[a-z0-9-]+\.[a-z0-9.-]+(:\d+)?$|[0-9a-f-]{20,}$)/i;

function PropertyLine({ row, depth, highlight }: { row: PropertyRow; depth: number; highlight: boolean }) {
  const t = useT();
  // A top-level section - `Configuration`, `properties` - is what the reader
  // came for and starts open; what is nested inside it waits for a click.
  const [open, setOpen] = useState(depth === 0);
  const indent = { paddingLeft: `${String(0.75 + depth * 1)}rem` };

  if (row.kind === "group") {
    return (
      <>
        <button
          onClick={() => {
            setOpen(!open);
          }}
          style={indent}
          className="flex w-full items-center gap-1 border-b border-line py-1 pr-2 text-left last:border-b-0 hover:bg-elevated"
        >
          {open ? (
            <ChevronDown size={11} className="text-muted" />
          ) : (
            <ChevronRight size={11} className="text-muted" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{row.key}</span>
          <span className="text-[10px] tabular-nums text-muted">
            {t("cloud.propertyCount", { count: countOf(row.rows) })}
          </span>
        </button>
        {open &&
          row.rows.map((child, index) => (
            <PropertyLine
              key={`${child.key}-${String(index)}`}
              row={child}
              depth={depth + 1}
              highlight={false}
            />
          ))}
      </>
    );
  }

  const code = CODE_LIKE.test(row.value);
  return (
    <div
      style={indent}
      className={`group flex items-start gap-3 border-b border-line py-1 pr-2 last:border-b-0 ${
        highlight ? "bg-accent/5" : ""
      }`}
    >
      {row.key !== "" && (
        <span className="w-44 shrink-0 truncate text-muted" title={row.key}>
          {row.key}
        </span>
      )}
      <span className={`min-w-0 flex-1 break-all ${code ? "font-mono text-[11px]" : ""}`}>{row.value}</span>
      {row.value !== "—" && (
        <span className="shrink-0 opacity-0 group-hover:opacity-100">
          <CopyButton text={row.value} label={t("cloud.copyValue")} />
        </span>
      )}
    </div>
  );
}

/**
 * The other resources this one is deployed alongside, on the basis the map is
 * using - the team's own statement of what belongs together.
 */
function RelatedPane({ resource }: { resource: CloudResource }) {
  const t = useT();
  const tab = useCloud((s) => s.tab);
  const accountId = useCloud((s) => s.selected[s.tab]);
  const slot = accountId === undefined ? null : slotOf(tab, accountId);
  const state = useCloud((s) => (slot === null ? undefined : s.resources[slot]));
  const basis = useCloud((s) => (slot === null ? undefined : s.basis[slot]));
  const openDetail = useCloud((s) => s.openDetail);

  const family = useMemo(() => {
    if (state?.kind !== "loaded") return null;
    const { apps } = mapOf(state.resources, basis);
    return apps.find((app) => app.resources.some((member) => member.id === resource.id)) ?? null;
  }, [state, basis, resource.id]);

  if (family === null || family.resources.length < 2)
    return <p className="text-muted">{t("cloud.relatedNone")}</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">
        {t(family.name === UNTAGGED ? "cloud.relatedGroup" : "cloud.relatedApp", {
          app: family.name,
          count: family.resources.length - 1,
        })}
      </p>
      {family.tiers.map(([tier, owned]) => (
        <section key={tier}>
          <SectionLabel text={`${t(TIER_LABELS[tier])} · ${String(owned.length)}`} />
          <div className="flex flex-wrap gap-1.5">
            {owned.map((sibling) => (
              <button
                key={sibling.id}
                onClick={() => {
                  openDetail(sibling);
                }}
                disabled={sibling.id === resource.id}
                title={`${sibling.name} · ${sibling.kind}`}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${
                  sibling.id === resource.id
                    ? "border-accent bg-accent/10 text-fg"
                    : "border-line text-muted hover:border-accent hover:text-fg"
                }`}
              >
                <ServiceBadge kind={sibling.kind} />
                <span className="max-w-48 truncate">{sibling.name}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Every answer as the CLI printed it - the ground truth when a table surprises. */
function RawPane({ resource, plan }: { resource: CloudResource; plan: PlanState | undefined }) {
  const t = useT();
  const answers = useCloud((s) => s.answers);
  const loaded =
    plan?.kind === "ready"
      ? plan.reads
          .map((read) => ({ read, answer: answers[answerKey(resource, read)] }))
          .filter((entry) => entry.answer?.kind === "loaded")
      : [];
  if (loaded.length === 0) return <p className="text-muted">{t("cloud.rawNone")}</p>;
  return (
    <div className="flex flex-col gap-3">
      {loaded.map(({ read, answer }) => (
        <section key={read.label}>
          <SectionLabel text={read.label} />
          <pre className="max-h-96 overflow-auto rounded-md border border-line bg-bg p-2 text-[11px] whitespace-pre">
            {answer?.kind === "loaded" ? prettyJson(answer.json) : ""}
          </pre>
        </section>
      ))}
    </div>
  );
}

/** One click to the clipboard, with the tick that says it happened. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
      title={label}
      className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-fg"
    >
      {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
    </button>
  );
}

function SectionLabel({ icon, text }: { icon?: LucideIcon; text: string }) {
  return (
    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] tracking-wide text-muted uppercase">
      {icon !== undefined && createElement(icon, { size: 11 })}
      {text}
    </p>
  );
}

/** One line that says what is going on, with the icon that says which kind. */
export function Note({
  icon,
  spin = false,
  tone = "muted",
  children,
}: {
  icon: LucideIcon;
  spin?: boolean;
  tone?: "muted" | "danger";
  children: React.ReactNode;
}) {
  const colour =
    tone === "danger" ? "border-danger/40 bg-danger/10 text-danger" : "border-line bg-bg/60 text-muted";
  return (
    <p className={`flex items-start gap-2 rounded-md border px-2.5 py-2 ${colour}`}>
      {createElement(icon, { size: 13, className: `mt-px shrink-0 ${spin ? "animate-spin" : ""}` })}
      <span className="min-w-0 whitespace-pre-wrap break-words">{children}</span>
    </p>
  );
}

/**
 * The CLI's JSON, indented for reading; left exactly as it arrived when it will
 * not parse, because a surprising answer is still the answer.
 */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text.trim();
  }
}
