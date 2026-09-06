import { useEffect, useRef } from "react";
import {
  ArrowLeft,
  Check,
  Circle,
  ExternalLink,
  FileText,
  Loader2,
  Rocket,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "../i18n";
import { commandLine, readLine, type DeployPlan, type Survey } from "../lib/deploy";
import { shortKind } from "../lib/cloudIcons";
import { slotOf, useCloud, type CloudAccount } from "../stores/cloud";
import { useDeploy, type DeployLogLine, type StepRun } from "../stores/deploy";
import { CopyButton, Note } from "./CloudDetail";

/**
 * The deploy in front of an account's resources: what the AI found, the plan
 * waiting to be confirmed, the steps as they run, the URL that answered.
 *
 * One rule shapes the page: nothing runs that is not on it. The confirm view
 * shows every command exactly as Aime will run it, the settings that are
 * promised to stay, the files the AI will write and the request that will
 * prove the result - and the only way forward is the Deploy button.
 */
export function DeployPane({ slot }: { slot: string }) {
  const t = useT();
  const deploy = useDeploy((s) => s.slots[slot]);
  const { close, cancel, confirm, dismiss, start } = useDeploy();
  if (deploy === undefined) return null;
  const { stage, account, cloudId, log } = deploy;
  const live = stage.kind !== "confirm" && stage.kind !== "done" && stage.kind !== "blocked";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <Rocket size={16} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold">
            {t("deploy.title", { account: account.label })}
          </h2>
          <p className="truncate text-[11px] text-muted">
            {t("deploy.project")} <span className="font-mono">{account.id}</span>
            {account.owner !== "" && (
              <>
                {" "}
                {t("deploy.signedInAs")} <span className="font-mono">{account.owner}</span>
              </>
            )}
          </p>
        </div>
        {live && (
          <button
            onClick={() => void cancel(slot)}
            className="flex shrink-0 items-center gap-1.5 rounded border border-line px-2 py-1 text-muted hover:border-danger hover:text-danger"
          >
            <X size={11} /> {t("deploy.stop")}
          </button>
        )}
        <button
          onClick={close}
          title={t("deploy.back")}
          className="flex shrink-0 items-center gap-1.5 rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
        >
          <ArrowLeft size={11} /> {t("deploy.back")}
        </button>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-5">
        {(stage.kind === "surveying" || stage.kind === "planning") && (
          <Note icon={Loader2} spin>
            {t(stage.kind === "surveying" ? "deploy.stageSurveying" : "deploy.stagePlanning")}
          </Note>
        )}

        {stage.kind === "confirm" && (
          <Confirm
            cloudId={cloudId}
            account={account}
            survey={stage.survey}
            plan={stage.plan}
            onGo={() => void confirm(slot)}
            onCancel={() => void cancel(slot)}
          />
        )}

        {(stage.kind === "deploying" || stage.kind === "proving") && <Steps steps={stage.steps} />}

        {stage.kind === "done" && (
          <>
            <div className="mb-4 rounded-md border border-ok/40 bg-ok/10 px-3 py-2.5">
              <p className="flex items-center gap-2 text-[13px] font-medium text-ok">
                <ShieldCheck size={14} /> {t("deploy.doneTitle")}
              </p>
              <button
                onClick={() => {
                  openUrl(stage.url).catch(console.error);
                }}
                className="mt-1 flex items-center gap-1.5 font-mono text-[12px] text-accent hover:underline"
                title={t("deploy.openUrl")}
              >
                <ExternalLink size={11} /> {stage.url}
              </button>
              <p className="mt-1 text-[11.5px] text-muted">
                {t("deploy.doneDetail", { status: stage.probe.status, ms: stage.probe.durationMs })}
                {stage.kept > 0 && ` ${t("deploy.kept", { count: stage.kept })}`}
              </p>
            </div>
            <Steps steps={stage.steps} />
            <AgainOrClose
              onAgain={() => void start(cloudId, account)}
              onClose={() => {
                dismiss(slot);
              }}
            />
          </>
        )}

        {stage.kind === "blocked" && (
          <>
            <Note icon={TriangleAlert} tone="danger">
              <span className="font-medium">{t("deploy.blockedTitle")}</span>
              {"\n"}
              {stage.reason}
            </Note>
            <AgainOrClose
              onAgain={() => void start(cloudId, account)}
              onClose={() => {
                dismiss(slot);
              }}
            />
            {stage.steps.length > 0 && (
              <div className="mt-4">
                <Steps steps={stage.steps} />
              </div>
            )}
          </>
        )}

        <Log log={log} />
      </div>
    </div>
  );
}

/** The page a person reads before anything runs. */
function Confirm({
  cloudId,
  account,
  survey,
  plan,
  onGo,
  onCancel,
}: {
  cloudId: string;
  account: CloudAccount;
  survey: Survey;
  plan: DeployPlan;
  onGo: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const resources = useCloud((s) => s.resources[slotOf(cloudId, account.id)]);
  const existing =
    plan.target.resourceId === null || resources?.kind !== "loaded"
      ? null
      : (resources.resources.find((one) => one.id === plan.target.resourceId) ?? null);
  const existingLabel =
    existing === null
      ? (plan.target.resourceId ?? "")
      : `${shortKind(existing.kind)} ${existing.name}${existing.location === "" ? "" : ` · ${existing.location}`}`;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[13.5px] font-medium">{t("deploy.confirmTitle")}</p>
        <p className="mt-0.5 text-[11.5px] text-muted">{t("deploy.confirmHint")}</p>
      </div>

      <Section title={plan.summary}>
        <p className="text-[12px] text-muted">
          {t("deploy.app", { name: survey.app.name, kind: survey.app.kind, stack: survey.app.stack })}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
          <dt className="text-muted">{t("deploy.project")}</dt>
          <dd className="font-mono">
            {account.id}
            {account.owner !== "" && <span className="text-muted"> · {account.owner}</span>}
          </dd>
          {plan.target.region !== "" && (
            <>
              <dt className="text-muted">{t("deploy.region")}</dt>
              <dd className="font-mono">{plan.target.region}</dd>
            </>
          )}
        </dl>
        {plan.target.existing ? (
          <p className="mt-2 text-[12px]">{t("deploy.targetExisting", { resource: existingLabel })}</p>
        ) : (
          <p className="mt-2 text-[12px]">{t("deploy.targetNew")}</p>
        )}
        {plan.proposal !== null && (
          <dl className="mt-2 space-y-1.5 rounded-md border border-line bg-bg/60 px-3 py-2 text-[12px]">
            <Proposal label={t("deploy.proposalArchitecture")} text={plan.proposal.architecture} />
            <Proposal label={t("deploy.proposalCost")} text={plan.proposal.cost} />
            <Proposal label={t("deploy.proposalPerformance")} text={plan.proposal.performance} />
          </dl>
        )}
      </Section>

      {plan.keep.length > 0 && (
        <Section title={t("deploy.keepTitle")} hint={t("deploy.keepHint")}>
          <ul className="space-y-1 text-[12px]">
            {plan.keep.map((keep) => (
              <li key={`${keep.read.label}#${keep.path}`} className="flex items-baseline gap-2">
                <ShieldCheck size={12} className="mt-0.5 shrink-0 text-ok" />
                <span>
                  {keep.label} <span className="font-mono text-muted">({keep.path})</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {plan.files.length > 0 && (
        <Section title={t("deploy.filesTitle")}>
          <ul className="space-y-1 text-[12px]">
            {plan.files.map((file) => (
              <li key={file.path} className="flex items-baseline gap-2">
                <FileText size={12} className="mt-0.5 shrink-0 text-muted" />
                <span>
                  <span className="font-mono">{file.path}</span>
                  {file.why !== "" && <span className="text-muted"> - {file.why}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t("deploy.stepsTitle")}>
        <ol className="space-y-2">
          {plan.steps.map((step, index) => (
            <li key={`${String(index)}-${step.label}`}>
              <p className="text-[12px]">
                <span className="text-muted">{index + 1}.</span> {step.label}
                {step.changes !== "" && <span className="text-muted"> - {step.changes}</span>}
              </p>
              <Command text={commandLine(step, account)} />
            </li>
          ))}
        </ol>
      </Section>

      {plan.prove !== null && (
        <Section title={t("deploy.proveTitle")}>
          <p className="text-[12px]">
            {t("deploy.proveLine", {
              path: plan.prove.path,
              command: plan.prove.read.label,
              expect: plan.prove.expect,
            })}
          </p>
          <Command text={readLine(plan.prove.read, account)} />
        </Section>
      )}

      {survey.missing.length > 0 && (
        <Section title={t("deploy.missingTitle")}>
          <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-muted">
            {survey.missing.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>
      )}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <button
          onClick={onGo}
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
        >
          <Rocket size={13} /> {t("deploy.go")}
        </button>
        <button
          onClick={onCancel}
          className="rounded border border-line px-3 py-1.5 text-[12.5px] text-muted hover:text-fg"
        >
          {t("deploy.cancel")}
        </button>
      </div>
    </div>
  );
}

/** A deploy at rest: plan it again from the survey, or forget it. */
function AgainOrClose({ onAgain, onClose }: { onAgain: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <div className="mt-3 flex gap-2">
      <button
        onClick={onAgain}
        className="rounded border border-accent px-2.5 py-1 text-[12px] text-accent hover:bg-accent-soft"
      >
        {t("deploy.again")}
      </button>
      <button
        onClick={onClose}
        className="rounded border border-line px-2.5 py-1 text-[12px] text-muted hover:text-fg"
      >
        {t("deploy.close")}
      </button>
    </div>
  );
}

function Proposal({ label, text }: { label: string; text: string }) {
  if (text === "") return null;
  return (
    <div>
      <dt className="text-[10.5px] tracking-wide text-muted uppercase">{label}</dt>
      <dd className="whitespace-pre-wrap">{text}</dd>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[12.5px] font-medium">{title}</h3>
      {hint !== undefined && <p className="mb-1.5 text-[11px] text-muted">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/** A command line as it will run, with a copy button - the reader's own check. */
function Command({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="mt-1 flex items-start gap-1.5 rounded-md border border-line bg-elevated px-2.5 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-[11.5px] break-all whitespace-pre-wrap">{text}</code>
      <CopyButton text={text} label={t("cloud.copyCommand")} />
    </div>
  );
}

/** The steps with their marks, while the deploy runs and after. */
function Steps({ steps }: { steps: StepRun[] }) {
  const t = useT();
  return (
    <section>
      <h3 className="mb-1.5 text-[11px] tracking-wide text-muted uppercase">{t("deploy.stepsHeading")}</h3>
      <ol className="space-y-1.5">
        {steps.map((run, index) => (
          <li key={`${String(index)}-${run.step.label}`} className="flex items-start gap-2 text-[12px]">
            <Mark state={run.state} />
            <span className={run.state === "pending" ? "text-muted" : ""}>{run.step.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Mark({ state }: { state: StepRun["state"] }) {
  switch (state) {
    case "passed":
      return <Check size={13} className="mt-0.5 shrink-0 text-ok" />;
    case "failed":
      return <X size={13} className="mt-0.5 shrink-0 text-danger" />;
    case "running":
      return <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent" />;
    default:
      return <Circle size={13} className="mt-0.5 shrink-0 text-muted opacity-50" />;
  }
}

/** The log follows itself: during a long step it is the only sign of life. */
function Log({ log }: { log: DeployLogLine[] }) {
  const t = useT();
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [log.length]);
  if (log.length === 0) return null;
  return (
    <section className="mt-6">
      <h3 className="mb-1.5 text-[11px] tracking-wide text-muted uppercase">{t("deploy.logTitle")}</h3>
      <div className="max-h-80 overflow-auto rounded-md border border-line bg-elevated px-3 py-2">
        {log.map((line, index) => (
          <p
            key={index}
            className={`font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap ${
              line.kind === "problem" ? "text-danger" : line.kind === "note" ? "text-fg" : "text-muted"
            }`}
          >
            {line.text}
          </p>
        ))}
        <div ref={tail} />
      </div>
    </section>
  );
}
