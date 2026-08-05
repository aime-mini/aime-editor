import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Bug,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Download,
  ExternalLink,
  Loader2,
  Pencil,
  Play,
  Plug,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Terminal,
  Sparkles,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import { teachableLanguage } from "../lib/dap/availability";
import { displayLine, hasRule, type EditorBreakpoint } from "../lib/dap/launch";
import { fileNameOf, relativeTo } from "../lib/dap/paths";
import type { Scope, StackFrame, Variable } from "../lib/dap/protocol";
import { fileTarget, resolveTarget, type ResolvedTarget } from "../lib/dap/targets";
import { languageOf } from "../lib/languages";
import { useDebug } from "../stores/debug";
import { useSetup } from "../stores/setup";
import { useWorkspace } from "../stores/workspace";
import { ContextMenu } from "./ContextMenu";

/**
 * Languages Aime means to debug, and the tool each one is waiting on.
 *
 * Deliberately not in the Rust catalog: that table holds adapters that exist
 * and have been driven. This is the honest answer to "why not my language",
 * which is a sentence, not a runnable entry — writing it as one would put a
 * language in the table on the strength of its README (ARCHITECTURE.md §5).
 */
interface Planned {
  note: "debug.planned.java" | "debug.planned.cpp";
  /** The tool's own download page — Aime cannot fetch these for you. */
  tool: string;
  page: string;
}

const PLANNED: Record<string, Planned | undefined> = {
  java: {
    note: "debug.planned.java",
    tool: "Eclipse JDT LS",
    page: "https://download.eclipse.org/jdtls/snapshots/?d",
  },
  cpp: { note: "debug.planned.cpp", tool: "LLVM (lldb-dap)", page: "https://releases.llvm.org/" },
  c: { note: "debug.planned.cpp", tool: "LLVM (lldb-dap)", page: "https://releases.llvm.org/" },
};

/** What a breakpoint's rules say, for the pencil's tooltip. */
function ruleSummary(breakpoint: EditorBreakpoint): string | null {
  const parts = [
    breakpoint.condition,
    breakpoint.hitCondition === undefined ? undefined : `hits ${breakpoint.hitCondition}`,
    breakpoint.logMessage === undefined ? undefined : `log: ${breakpoint.logMessage}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A collapsible-looking section header — the panel is short enough not to collapse. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line">
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">{title}</div>
      <div className="pb-1">{children}</div>
    </div>
  );
}

/**
 * What a run would launch, computed once per render from the state it depends on.
 *
 * Deliberately not `useDebug((s) => s.resolved())`: that selector builds a new
 * object every time zustand compares, which is an infinite re-render - measured
 * the hard way, it froze the window and every e2e test with it.
 */
function useResolvedTarget(): ResolvedTarget | null {
  const targets = useDebug((s) => s.targets);
  const chosenTargetId = useDebug((s) => s.chosenTargetId);
  const openFilePath = useWorkspace((s) => s.openFilePath);
  const rootPath = useWorkspace((s) => s.rootPath);
  return useMemo(
    () =>
      rootPath === null
        ? null
        : resolveTarget({
            targets,
            chosenId: chosenTargetId,
            openFilePath,
            openLanguageId: openFilePath === null ? null : languageOf(openFilePath),
            root: rootPath,
          }),
    [targets, chosenTargetId, openFilePath, rootPath],
  );
}

/**
 * Which program a run would launch, with the other candidates one click away.
 *
 * The label is the program, never "the open file": a button that says one thing
 * and runs another is worse than no button. When Aime had to assume - several
 * programs and none in the language of the open file - it says so, because that
 * is exactly the case it can get wrong.
 */
function TargetRow({ resolved }: { resolved: ResolvedTarget }) {
  const { targets, chooseTarget, scanTargets, launchOptions, openArgumentsEditor } = useDebug();
  const { rootPath, openFilePath } = useWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const t = useT();

  const openFileTarget =
    openFilePath !== null && rootPath !== null
      ? fileTarget(openFilePath, languageOf(openFilePath), rootPath)
      : null;
  const choices = [...targets];
  // The open file is a candidate of its own - a one-off script is a real thing
  // to debug - but never twice, and never as a duplicate of a project entry.
  if (openFileTarget && !choices.some((choice) => choice.program === openFileTarget.program)) {
    choices.push(openFileTarget);
  }
  const options = launchOptions[resolved.target.id];
  const passes = (options?.args?.length ?? 0) > 0 || Object.keys(options?.env ?? {}).length > 0;
  const argumentsButton = (
    <button
      onClick={() => {
        openArgumentsEditor(resolved.target.id);
      }}
      title={
        passes
          ? t("debug.argsSet", {
              args: (options?.args ?? []).join(" "),
              count: String(Object.keys(options?.env ?? {}).length),
            })
          : t("debug.argsOpen")
      }
      className={`flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:text-fg ${
        passes ? "text-accent" : ""
      }`}
    >
      <Terminal size={10} />
      {t("debug.args")}
    </button>
  );

  // With one candidate there is nothing to pick, but there is still something to
  // pass to it.
  if (choices.length <= 1) {
    return (
      <div className="flex items-center gap-1.5 px-2 pb-1 text-[10.5px] text-muted">{argumentsButton}</div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 text-[10.5px] text-muted">
      <span className="shrink-0">{t("debug.target")}</span>
      <button
        onClick={(e) => {
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className="flex min-w-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:text-fg"
      >
        <span className="truncate">{resolved.target.label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {argumentsButton}
      {resolved.origin === "assumed" && (
        <span className="truncate text-warn" title={t("debug.targetAssumed")}>
          {t("debug.targetAssumedShort")}
        </span>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
          }}
          items={[
            ...choices.map((choice) => ({
              label: `${choice.id === resolved.target.id ? "✓ " : "   "}${choice.label}`,
              onClick: () => {
                chooseTarget(choice.id);
              },
            })),
            {
              label: t("debug.rescanTargets"),
              icon: <RefreshCw size={12} />,
              onClick: () => void scanTargets({ force: true }),
            },
          ]}
        />
      )}
    </div>
  );
}

/**
 * Which device the program runs on.
 *
 * Only for adapters that need one - Flutter, Android - and the list comes from
 * the adapter's own command (`flutter devices --machine`, `adb devices`), never
 * from a table in Aime. One device is not a choice, so it is taken silently.
 */
function DeviceRow({ languageId, deviceField }: { languageId: string; deviceField: string }) {
  const { devices, chosenDevice, loadDevices, chooseDevice } = useDebug();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const t = useT();

  useEffect(() => {
    void loadDevices(languageId);
  }, [languageId, loadDevices]);

  const available = devices[languageId] ?? [];
  const chosen = available.find((device) => device.id === chosenDevice[languageId]);

  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 text-[10.5px] text-muted">
      <Smartphone size={10} className="shrink-0" />
      <button
        onClick={(e) => {
          setMenu({ x: e.clientX, y: e.clientY });
          void loadDevices(languageId);
        }}
        title={t("debug.deviceHint", { field: deviceField })}
        className="flex min-w-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:text-fg"
      >
        <span className="truncate">{chosen?.label ?? t("debug.deviceNone")}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
          }}
          items={
            available.length === 0
              ? [{ label: t("debug.deviceEmpty"), onClick: () => undefined }]
              : available.map((device) => ({
                  label: `${device.id === chosen?.id ? "✓ " : "   "}${device.label}`,
                  onClick: () => {
                    chooseDevice(languageId, device.id);
                  },
                }))
          }
        />
      )}
    </div>
  );
}

/**
 * Attaching to a program that is already running.
 *
 * A port, because that is what every adapter of this kind takes: `node
 * --inspect` publishes one, `python -m debugpy --listen` publishes one. Which
 * adapter to attach *with* is the same question F5 answers, so it is not asked
 * again here.
 */
function AttachRow() {
  const { attach, attachTo, attachOpen, setAttachOpen, status } = useDebug();
  const [draft, setDraft] = useState(() => String(attachTo?.port ?? 9229));
  const t = useT();
  if (status.kind !== "idle") return null;

  if (!attachOpen) {
    return (
      <button
        onClick={() => {
          setAttachOpen(true);
        }}
        className="flex w-full items-center justify-center gap-1.5 px-2 pb-2 text-[10.5px] text-muted hover:text-fg"
      >
        <Plug size={10} /> {t("debug.attachOpen")}
      </button>
    );
  }

  const go = () => {
    const port = Number(draft.trim());
    if (!Number.isInteger(port) || port <= 0) return;
    void attach({ host: attachTo?.host ?? "127.0.0.1", port });
  };

  return (
    <div className="flex items-center gap-1.5 px-2 pb-2">
      <input
        value={draft}
        autoFocus
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") go();
          if (e.key === "Escape") setAttachOpen(false);
        }}
        placeholder="9229"
        title={t("debug.attachHint")}
        className="w-20 rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-[11.5px] outline-none focus:border-accent"
      />
      <button
        onClick={go}
        className="flex-1 rounded-md border border-accent px-2 py-0.5 text-[11.5px] font-medium text-accent hover:bg-accent/10"
      >
        {t("debug.attach")}
      </button>
      {/*
       * A way back out that can be seen. Escape closes the row too, but only
       * while the port field has focus - which leaves anyone who clicked
       * elsewhere with a form and no exit.
       */}
      <button
        onClick={() => {
          setAttachOpen(false);
        }}
        title={t("common.cancel")}
        className="shrink-0 rounded p-0.5 text-muted hover:bg-elevated hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** The button that starts a run, or explains why it cannot. */
function StartRow() {
  const { adapters, downloading, status, probeAdapter, downloadAdapter, start, scanTargets } = useDebug();
  const { verifyAdapter, verifying, verdicts } = useDebug();
  const { rootPath, openFilePath } = useWorkspace();
  const resolved = useResolvedTarget();
  const t = useT();

  // Reading the project's manifests is what makes F5 run the right thing; doing
  // it when the panel appears keeps it off the path of opening a file.
  useEffect(() => {
    if (rootPath) void scanTargets();
  }, [rootPath, scanTargets]);

  const languageId = resolved?.target.languageId ?? null;

  // Probing runs a process, so it happens when the panel is on screen and the
  // answer is about to be shown - not for every file the user opens.
  useEffect(() => {
    if (languageId) void probeAdapter(languageId);
  }, [languageId, probeAdapter]);

  if (!resolved || languageId === null) {
    return <p className="px-2 py-2 text-[11.5px] text-muted">{t("debug.openFileFirst")}</p>;
  }

  const adapter = adapters[languageId];
  if (adapter === undefined) {
    return <p className="px-2 py-2 text-[11.5px] text-muted">{t("debug.probing")}</p>;
  }
  if (adapter === null) {
    // No adapter for this language. A Markdown file and a C++ file both land
    // here, so the sentence has to be true of both: Aime does not debug them.
    // Where Aime *means* to, the note underneath names the tool it is waiting
    // for - that is the answer people actually want, and it is a missing tool
    // rather than a missing decision.
    const waitingFor = PLANNED[languageId];
    return (
      <div className="space-y-1.5 px-2 py-2 text-[11.5px]">
        <p className="text-muted">{t("debug.unsupported", { languageId })}</p>
        {waitingFor && (
          <>
            <p className="text-muted/80">{t(waitingFor.note)}</p>
            {/* A link, not a Download button: pressing Download elsewhere in
                this panel ends in a working debugger, and these do not yet. */}
            <button
              onClick={() => {
                openUrl(waitingFor.page).catch(console.error);
              }}
              className="flex items-center gap-1.5 text-accent hover:underline"
            >
              <ExternalLink size={11} /> {t("debug.plannedGet", { tool: waitingFor.tool })}
            </button>
          </>
        )}
        {/* A program language can still be taught (learned.rs + dap_verify), so
            the offer lives here — where debugging intent is expressed — and not
            in an editor banner. Documents keep the plain sentence above: no
            agent can give a README a program to step through. */}
        {teachableLanguage(languageId) && (
          <button
            onClick={() => {
              void useSetup.getState().start({
                languageId,
                relativePath: openFilePath === null ? "" : fileNameOf(openFilePath),
                serverCommand: null,
                serverInstallHint: null,
                missingDebugger: null,
                teachDebugger: true,
              });
            }}
            title={t("setup.aiHint")}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-strong px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
          >
            <Sparkles size={11} /> {t("setup.ai")}
          </button>
        )}
      </div>
    );
  }

  if (adapter.learned && !adapter.verified) {
    // An adapter Aime was taught, that Aime has not yet watched stop. It is not
    // offered as working - it is offered as checkable, and the check is a real
    // session that has to hit a real breakpoint (lib/dap/verify.ts).
    const busy = verifying.includes(languageId);
    const verdict = verdicts[languageId];
    return (
      <div className="space-y-1.5 px-2 py-2 text-[11.5px]">
        <p className="text-warn">{t("debug.learnedUnverified", { adapter: adapter.adapterId })}</p>
        {adapter.verifyWith ? (
          <button
            onClick={() => void verifyAdapter(languageId)}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-strong px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            {busy ? t("debug.verifying") : t("debug.verify")}
          </button>
        ) : (
          <p className="text-muted">{t("debug.noVerifyWith")}</p>
        )}
        {verdict && !verdict.ok && (
          <>
            <p className="font-mono text-[11px] whitespace-pre-wrap text-danger">{verdict.detail}</p>
            {/* The loop that makes a taught adapter worth teaching: the agent
                gets its own entry back with the reason Aime rejected it. */}
            <button
              onClick={() => {
                void useSetup.getState().start({
                  languageId,
                  relativePath: openFilePath === null ? "" : fileNameOf(openFilePath),
                  serverCommand: null,
                  serverInstallHint: null,
                  missingDebugger: null,
                  teachDebugger: true,
                  verifyFailure: verdict.detail,
                });
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:text-fg"
            >
              <Sparkles size={11} /> {t("debug.askAiToFix")}
            </button>
          </>
        )}
      </div>
    );
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
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-strong px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
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
    <>
      <div className="px-2 pb-1 pt-2">
        <button
          onClick={() => void start()}
          disabled={status.kind !== "idle"}
          title={resolved.target.program}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-strong px-2 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {status.kind === "starting" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          <span className="truncate">{t("debug.startTarget", { target: resolved.target.label })}</span>
        </button>
      </div>
      <TargetRow resolved={resolved} />
      {adapter.deviceField !== null && (
        <DeviceRow languageId={languageId} deviceField={adapter.deviceField} />
      )}
      <p className="px-2 pb-1 text-center text-[10.5px] text-muted">{t("debug.startHint")}</p>
      <AttachRow />
    </>
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

/**
 * Stopping where a program throws, rather than where it dies.
 *
 * The filters are the adapter's, not Aime's - it names them in `initialize` and
 * Aime remembers the list so these checkboxes exist between runs too. Turning
 * one on mid-run reaches the live session, because that is exactly when someone
 * wants it.
 */
function ExceptionFilters({ languageId }: { languageId: string | null }) {
  const { exceptionFilters, enabledExceptionFilters, toggleExceptionFilter } = useDebug();
  const t = useT();
  const filters = languageId === null ? undefined : exceptionFilters[languageId];
  if (!languageId) return null;
  // The list only exists once an adapter has been asked, so say so rather than
  // leaving an empty box that looks broken.
  if (!filters || filters.length === 0) {
    return <p className="px-2 text-[11.5px] text-muted">{t("debug.exceptionsNone")}</p>;
  }
  const enabled = enabledExceptionFilters[languageId] ?? [];

  return (
    <div>
      {filters.map((filter) => (
        <label
          key={filter.filter}
          title={filter.description ?? filter.label}
          className="flex cursor-pointer items-center gap-1.5 px-2 py-0.5 text-[11.5px] text-muted hover:text-fg"
        >
          <input
            type="checkbox"
            checked={enabled.includes(filter.filter)}
            onChange={() => {
              toggleExceptionFilter(languageId, filter.filter);
            }}
            className="accent-accent"
          />
          {filter.label}
        </label>
      ))}
      <p className="px-2 pt-0.5 text-[10.5px] text-muted/80">{t("debug.exceptionsHint")}</p>
    </div>
  );
}

/**
 * Expressions kept on screen across stops.
 *
 * Evaluated in the frame that is selected, in the protocol's "watch" context,
 * and only while the program is paused - there is nothing to evaluate in
 * otherwise, so the last values stay and go grey rather than blinking out on
 * every step. A failed expression keeps its error: "not defined here" is an
 * answer, and a row that disappears reads as a bug.
 */
function Watches() {
  const { watches, watchValues, addWatch, removeWatch, status } = useDebug();
  const [draft, setDraft] = useState("");
  const t = useT();
  const live = status.kind === "paused";

  return (
    <div>
      {watches.map((expression) => {
        const answer = watchValues[expression];
        return (
          <div key={expression} className="group flex items-baseline gap-1.5 px-2 py-0.5 text-[11.5px]">
            <span className="shrink-0 font-mono text-accent">{expression}</span>
            <span
              className={`min-w-0 flex-1 truncate font-mono ${
                answer?.error === undefined ? (live ? "text-muted" : "text-muted/50") : "text-danger"
              }`}
              title={answer?.error ?? answer?.value}
            >
              {answer?.error ?? answer?.value ?? "—"}
            </span>
            <button
              onClick={() => {
                removeWatch(expression);
              }}
              className="rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger"
              title={t("debug.watchRemove")}
            >
              ×
            </button>
          </div>
        );
      })}
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          addWatch(draft);
          setDraft("");
        }}
        placeholder={t("debug.watchAdd")}
        className="mt-0.5 w-full bg-transparent px-2 py-0.5 font-mono text-[11.5px] outline-none placeholder:text-muted/70"
      />
    </div>
  );
}

function Breakpoints() {
  const { breakpoints, toggleBreakpoint, clearBreakpoints, editBreakpointRule } = useDebug();
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
                void editBreakpointRule(path, displayLine(breakpoint));
              }}
              className={`rounded px-1 hover:text-accent ${
                hasRule(breakpoint) ? "text-accent" : "text-muted opacity-0 group-hover:opacity-100"
              }`}
              title={ruleSummary(breakpoint) ?? t("debug.ruleAction")}
            >
              <Pencil size={10} />
            </button>
            <button
              onClick={() => {
                void toggleBreakpoint(path, displayLine(breakpoint));
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
  // The filters belong to the adapter of whatever would run, which is the same
  // answer the start button uses.
  const debuggedLanguage = useResolvedTarget()?.target.languageId ?? null;

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
      <Section title={t("debug.watch")}>
        <Watches />
      </Section>
      <Section title={t("debug.breakpoints")}>
        <Breakpoints />
      </Section>
      <Section title={t("debug.exceptions")}>
        <ExceptionFilters languageId={debuggedLanguage} />
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
