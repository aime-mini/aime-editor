import { useEffect } from "react";
import { Bug, ChevronDown, ChevronRight, CircleDot, Download, Loader2, Play } from "lucide-react";
import { useT } from "../i18n";
import { displayLine } from "../lib/dap/launch";
import { fileNameOf, relativeTo } from "../lib/dap/paths";
import type { Scope, StackFrame, Variable } from "../lib/dap/protocol";
import { languageOf } from "../lib/languages";
import { useDebug } from "../stores/debug";
import { useWorkspace } from "../stores/workspace";

/** A collapsible-looking section header — the panel is short enough not to collapse. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line">
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">{title}</div>
      <div className="pb-1">{children}</div>
    </div>
  );
}

/** The button that starts a run, or explains why it cannot. */
function StartRow() {
  const { adapters, downloading, status, probeAdapter, downloadAdapter, start } = useDebug();
  const openFilePath = useWorkspace((s) => s.openFilePath);
  const t = useT();

  const languageId = openFilePath ? languageOf(openFilePath) : null;

  // Probing runs a process, so it happens when the panel is on screen and the
  // answer is about to be shown - not for every file the user opens.
  useEffect(() => {
    if (languageId) void probeAdapter(languageId);
  }, [languageId, probeAdapter]);

  if (!openFilePath || !languageId) {
    return <p className="px-2 py-2 text-[11.5px] text-muted">{t("debug.openFileFirst")}</p>;
  }

  const adapter = adapters[languageId];
  if (adapter === undefined) {
    return <p className="px-2 py-2 text-[11.5px] text-muted">{t("debug.probing")}</p>;
  }
  if (adapter === null) {
    return <p className="px-2 py-2 text-[11.5px] text-muted">{t("debug.unsupported", { languageId })}</p>;
  }

  if (!adapter.available) {
    const busy = downloading.includes(languageId);
    return (
      <div className="space-y-1.5 px-2 py-2">
        <p className="text-[11.5px] text-warn">{t("debug.missing", { adapter: adapter.adapterId })}</p>
        {adapter.downloadable ? (
          <button
            onClick={() => void downloadAdapter(languageId)}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {busy ? t("debug.downloading") : t("debug.download")}
          </button>
        ) : (
          <p className="font-mono text-[11px] text-muted">{adapter.installHint}</p>
        )}
      </div>
    );
  }

  return (
    <div className="px-2 py-2">
      <button
        onClick={() => void start()}
        disabled={status.kind !== "idle"}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {status.kind === "starting" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
        {t("debug.startFile", { file: fileNameOf(openFilePath) })}
      </button>
      <p className="mt-1 text-center text-[10.5px] text-muted">{t("debug.startHint")}</p>
    </div>
  );
}

function CallStack({ frames }: { frames: StackFrame[] }) {
  const { selectedFrameId, selectFrame } = useDebug();
  const { rootPath, openFile } = useWorkspace();
  const t = useT();

  if (frames.length === 0) return <p className="px-2 text-[11.5px] text-muted">{t("debug.noStack")}</p>;

  return (
    <div>
      {frames.map((frame) => {
        const path = frame.source?.path;
        return (
          <button
            key={frame.id}
            onClick={() => {
              // Selecting a frame shows its variables; the file it lives in is
              // opened too, because a stack you cannot read is just a list.
              if (path) void openFile(path);
              void selectFrame(frame.id);
            }}
            className={`flex w-full items-baseline gap-1.5 px-2 py-0.5 text-left text-[11.5px] hover:bg-elevated ${
              frame.id === selectedFrameId ? "bg-elevated text-fg" : "text-muted"
            }`}
          >
            <span className="truncate">{frame.name}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-muted/70">
              {path
                ? `${rootPath ? relativeTo(rootPath, path) : fileNameOf(path)}:${String(frame.line)}`
                : "—"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function VariableRow({ variable, depth }: { variable: Variable; depth: number }) {
  const { variables, expanded, toggleVariable } = useDebug();
  const expandable = variable.variablesReference !== 0;
  const open = expanded.includes(variable.variablesReference);
  const children = variables[variable.variablesReference] ?? [];

  return (
    <>
      <button
        onClick={() => {
          if (expandable) void toggleVariable(variable.variablesReference);
        }}
        style={{ paddingLeft: `${String(8 + depth * 10)}px` }}
        className="flex w-full items-baseline gap-1 py-0.5 pr-2 text-left text-[11.5px] hover:bg-elevated"
        title={variable.type}
      >
        <span className="w-3 shrink-0 text-muted">
          {expandable && (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
        </span>
        <span className="shrink-0 text-accent">{variable.name}</span>
        <span className="truncate font-mono text-[11px] text-muted">{variable.value}</span>
      </button>
      {open &&
        children.map((child) => (
          <VariableRow key={`${child.name}-${child.value}`} variable={child} depth={depth + 1} />
        ))}
    </>
  );
}

function Variables({ scopes }: { scopes: Scope[] }) {
  const { variables, expanded, toggleVariable } = useDebug();
  const t = useT();

  if (scopes.length === 0) return <p className="px-2 text-[11.5px] text-muted">{t("debug.noVariables")}</p>;

  return (
    <div>
      {scopes.map((scope) => {
        const open = expanded.includes(scope.variablesReference);
        return (
          <div key={`${scope.name}-${String(scope.variablesReference)}`}>
            <button
              onClick={() => void toggleVariable(scope.variablesReference)}
              className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-[11.5px] text-fg hover:bg-elevated"
            >
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {scope.name}
            </button>
            {open &&
              (variables[scope.variablesReference] ?? []).map((variable) => (
                <VariableRow key={`${variable.name}-${variable.value}`} variable={variable} depth={1} />
              ))}
          </div>
        );
      })}
    </div>
  );
}

function Breakpoints() {
  const { breakpoints, toggleBreakpoint, clearBreakpoints } = useDebug();
  const { rootPath, openFile } = useWorkspace();
  const t = useT();

  const entries = Object.entries(breakpoints).filter(([, list]) => list.length > 0);
  if (entries.length === 0) {
    return <p className="px-2 text-[11.5px] text-muted">{t("debug.noBreakpoints")}</p>;
  }

  return (
    <div>
      {entries.map(([path, list]) =>
        list.map((breakpoint) => (
          <div
            key={`${path}:${String(breakpoint.line)}`}
            className="group flex items-center gap-1.5 px-2 py-0.5 text-[11.5px]"
          >
            <CircleDot
              size={10}
              className={
                breakpoint.verified ? "text-danger" : breakpoint.message ? "text-warn" : "text-muted"
              }
            />
            <button
              onClick={() => void openFile(path)}
              className="min-w-0 flex-1 truncate text-left text-muted hover:text-fg"
              // An adapter that refused the line said why; that reason is the
              // difference between "not attached yet" and "never will be".
              title={breakpoint.message ?? path}
            >
              {rootPath ? relativeTo(rootPath, path) : fileNameOf(path)}:{displayLine(breakpoint)}
            </button>
            <button
              onClick={() => {
                toggleBreakpoint(path, displayLine(breakpoint));
              }}
              className="rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger"
              title={t("debug.removeBreakpoint")}
            >
              ×
            </button>
          </div>
        )),
      )}
      <button
        onClick={clearBreakpoints}
        className="mt-1 w-full px-2 text-left text-[10.5px] text-muted hover:text-danger"
      >
        {t("debug.clearBreakpoints")}
      </button>
    </div>
  );
}

/**
 * The Run and Debug view: what to start, where execution is, and what the
 * variables hold. Everything that needs the program stopped is simply empty
 * while it runs, which is the honest state rather than a spinner.
 */
export function DebugPanel() {
  const { status, frames, scopes } = useDebug();
  const t = useT();

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <StartRow />
      {status.kind === "failed" && (
        <p className="border-b border-danger/40 bg-danger/10 px-2 py-1.5 text-[11.5px] text-danger">
          {status.reason}
        </p>
      )}
      {status.kind !== "idle" && (
        <>
          <Section title={t("debug.callStack")}>
            <CallStack frames={frames} />
          </Section>
          <Section title={t("debug.variables")}>
            <Variables scopes={scopes} />
          </Section>
        </>
      )}
      <Section title={t("debug.breakpoints")}>
        <Breakpoints />
      </Section>
      {status.kind === "idle" && (
        <p className="flex items-start gap-1.5 px-2 py-2 text-[10.5px] text-muted">
          <Bug size={11} className="mt-0.5 shrink-0" />
          {t("debug.gutterHint")}
        </p>
      )}
    </div>
  );
}
