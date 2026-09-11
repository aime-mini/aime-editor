import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, RefreshCw, Square, TriangleAlert, Wrench } from "lucide-react";
import { useT } from "../i18n";
import { destroys, fillable, fillOp, opCommand, type ProposedOp } from "../lib/cloudOps";
import { slotOf, useCloud, type CloudResource } from "../stores/cloud";
import { CopyButton, Note } from "./CloudDetail";

/**
 * The work a developer can do to one resource, from inside Aime.
 *
 * The whole chain is visible on purpose, because every one of these commands
 * runs against somebody's real cloud: the AI proposed the operations for this
 * KIND of resource (never for this resource, and never with a shell of its
 * own), Aime proved each one against the CLI installed here, the command is
 * shown filled in with the project and the account it will be pinned to, and
 * only a click on "Run it" starts anything. A read - a log tail, a listing -
 * says so and needs no confirm.
 *
 * Values are editable, the command is not: the words and flags are what Aime
 * checked, and the value beside a flag is the developer's own data (`KEY=VALUE`
 * on an env var is the obvious case). Whatever is edited is checked again
 * before it runs.
 */
export function CloudOps({ resource }: { resource: CloudResource }) {
  const t = useT();
  const state = useCloud((s) => s.ops[slotOf(s.tab, resource.kind)]);
  const planOps = useCloud((s) => s.planOps);
  const running = useCloud((s) => s.running);

  useEffect(() => {
    void planOps(resource);
  }, [planOps, resource]);

  if (state === undefined || state.kind === "planning") {
    return (
      <Note icon={Loader2} spin>
        {t("cloud.opsPlanning", { kind: resource.kind })}
      </Note>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="flex flex-col gap-2">
        <Note icon={TriangleAlert}>{t("cloud.opsFailed")}</Note>
        <p className="text-[11px] text-muted">{state.reason}</p>
        <AskAgain resource={resource} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {running !== null && running.resourceId === resource.id && <OpOutput />}
      <div className="flex flex-col gap-2">
        {state.ops.map((op) => (
          <OpRow key={op.label} resource={resource} op={op} />
        ))}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted">
        <AskAgain resource={resource} />
        {state.rejected.length > 0 && (
          <span title={state.rejected.map((entry) => `${entry.label}: ${entry.reason}`).join("\n")}>
            {t("cloud.opsRefused", { count: state.rejected.length })}
          </span>
        )}
      </div>
    </div>
  );
}

/** Forgets this kind's operations and asks the AI for them again. */
function AskAgain({ resource }: { resource: CloudResource }) {
  const t = useT();
  const planOps = useCloud((s) => s.planOps);
  const kind = useCloud((s) => slotOf(s.tab, resource.kind));
  return (
    <button
      onClick={() => {
        useCloud.setState((state) => ({ ops: { ...state.ops, [kind]: undefined } }));
        void planOps(resource);
      }}
      className="flex items-center gap-1 text-accent hover:underline"
    >
      <RefreshCw size={11} /> {t("cloud.opsAgain")}
    </button>
  );
}

/**
 * One operation: what it does, what it changes, and the command it will run.
 *
 * A write opens the command for a look before anything happens - that is the
 * confirm. A read has nothing to confirm, so it runs on the first click.
 */
function OpRow({ resource, op }: { resource: CloudResource; op: ProposedOp }) {
  const t = useT();
  const account = useCloud((s) => s.accounts[s.tab]?.find((entry) => entry.id === s.selected[s.tab]));
  const runOp = useCloud((s) => s.runOp);
  const running = useCloud((s) => s.running);
  const [open, setOpen] = useState(false);
  const filled = useMemo(() => fillOp(op, resource), [op, resource]);
  const [args, setArgs] = useState<string[]>(filled);
  const [typedName, setTypedName] = useState("");
  // Aime's own reading of the command, not the AI's word for it: an operation
  // is destructive because of what it says.
  const removes = destroys(op.args);
  const busy = running !== null && running.code === null;
  const ready = fillable(op, resource) && account !== undefined;

  const start = (tokens: string[]) => {
    setOpen(false);
    setTypedName("");
    void runOp(resource, op, tokens);
  };

  return (
    <div className="rounded-lg border border-line bg-bg/40">
      <div className="flex items-start gap-2 px-3 py-2">
        <Wrench size={13} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{op.label}</p>
          {/* The AI usually says "changes nothing" itself; only when it says
              nothing at all does Aime supply the words. */}
          <p className="text-[11px] text-muted">{op.changes === "" ? t("cloud.opsReads") : op.changes}</p>
          {!fillable(op, resource) && <p className="text-[11px] text-warn">{t("cloud.opsNeedsRegion")}</p>}
        </div>
        <button
          disabled={busy || !ready}
          onClick={() => {
            if (op.writes) {
              setArgs(filled);
              setTypedName("");
              setOpen(!open);
            } else {
              start(filled);
            }
          }}
          className="flex shrink-0 items-center gap-1.5 rounded border border-line px-2.5 py-1 hover:border-accent disabled:opacity-40"
        >
          <Play size={11} /> {t("cloud.opsRun")}
        </button>
      </div>

      {open && account !== undefined && (
        <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
          <p className="text-[11px] text-muted">{t("cloud.opsConfirm")}</p>
          <div className="flex items-start gap-2 rounded-md border border-line bg-panel px-2 py-1.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px]">
              {opCommand(args, account.id, account.owner)}
            </code>
            <CopyButton text={opCommand(args, account.id, account.owner)} label={t("cloud.copy")} />
          </div>
          <ValueFields args={args} onArgs={setArgs} />
          {removes && (
            <label className="flex flex-col gap-1 rounded-md border border-danger/50 bg-danger/10 px-2 py-1.5">
              <span className="text-[11px] text-danger">
                {t("cloud.opsTypeName", { name: resource.name })}
              </span>
              <input
                value={typedName}
                onChange={(event) => {
                  setTypedName(event.target.value);
                }}
                spellCheck={false}
                className="rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] outline-none focus:border-danger"
              />
            </label>
          )}
          <div className="flex items-center gap-2">
            <button
              disabled={removes && typedName !== resource.name}
              onClick={() => {
                start(args);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
                removes ? "bg-danger text-white" : "bg-accent text-bg"
              }`}
            >
              {t(removes ? "cloud.opsGoRemove" : "cloud.opsGo")}
            </button>
            <button
              onClick={() => {
                setOpen(false);
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-fg"
            >
              {t("cloud.opsCancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The values of the command, each editable in place.
 *
 * Only values: a token that follows a `--flag` and is not itself a flag. The
 * words and the flags are what Aime checked against the CLI, so they are shown
 * and not touched, while `KEY=VALUE` on an env var is exactly the thing the
 * person came here to type.
 */
function ValueFields({ args, onArgs }: { args: string[]; onArgs: (args: string[]) => void }) {
  const t = useT();
  const editable = args
    .map((token, index) => ({ token, index }))
    .filter(
      ({ token, index }) => index > 0 && !token.startsWith("--") && (args[index - 1] ?? "").startsWith("--"),
    );
  if (editable.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">{t("cloud.opsEdit")}</p>
      <div className="flex flex-wrap gap-2">
        {editable.map(({ token, index }) => (
          <label key={index} className="flex items-center gap-1.5 text-[11px]">
            <span className="font-mono text-muted">{args[index - 1]}</span>
            <input
              value={token}
              onChange={(event) => {
                const next = [...args];
                next[index] = event.target.value;
                onArgs(next);
              }}
              className="w-44 rounded border border-line bg-panel px-1.5 py-0.5 font-mono outline-none focus:border-accent"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/** What the running operation is printing, and how it ended. */
function OpOutput() {
  const t = useT();
  const running = useCloud((s) => s.running);
  const stopOp = useCloud((s) => s.stopOp);
  const clearOp = useCloud((s) => s.clearOp);
  if (running === null) return null;

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-accent/40 bg-panel p-2.5">
      <div className="flex items-center gap-2">
        {running.code === null ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
        ) : (
          <Play size={12} className={running.code === 0 ? "text-ok" : "text-danger"} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{running.label}</span>
        {running.code === null ? (
          <button
            onClick={() => void stopOp()}
            className="flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
          >
            <Square size={10} /> {t("cloud.opsStop")}
          </button>
        ) : (
          <button onClick={clearOp} className="text-[11px] text-muted hover:text-fg">
            {t("cloud.opsCancel")}
          </button>
        )}
      </div>
      <code className="block break-all font-mono text-[10.5px] text-muted">{running.command}</code>
      <pre className="max-h-56 overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap">
        {running.lines.join("\n") || t("cloud.opsRunning")}
      </pre>
      {running.code !== null && (
        <p className={`text-[11px] ${running.code === 0 ? "text-ok" : "text-danger"}`}>
          {t("cloud.opsDone", { code: running.code })}
        </p>
      )}
    </section>
  );
}
