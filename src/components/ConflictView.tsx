import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, ChevronRight, Loader2, Pencil, Sparkles, X } from "lucide-react";
import { useT } from "../i18n";
import {
  parseConflicts,
  rebuildContent,
  resolvedText,
  type ConflictSection,
  type Resolution,
  type Section,
} from "../lib/conflicts";
import { aiOneshot } from "../lib/aiOneshot";
import { useAi } from "../stores/ai";
import { useGit } from "../stores/git";
import { useWorkspace } from "../stores/workspace";

const CONTEXT_LINES = 3;
const AI_CONTEXT_CHARS = 1_500;

/** Dimmed context between conflicts; long runs collapse to head…tail. */
function ContextBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const t = useT();
  if (expanded || lines.length <= CONTEXT_LINES * 2 + 1) {
    return <pre className="overflow-x-auto px-3 py-1 font-mono text-[12px] text-muted">{text}</pre>;
  }
  return (
    <div className="px-3 py-1 font-mono text-[12px] text-muted">
      <pre className="overflow-x-auto">{lines.slice(0, CONTEXT_LINES).join("\n")}</pre>
      <button
        onClick={() => {
          setExpanded(true);
        }}
        className="my-0.5 w-full rounded border border-dashed border-line py-0.5 text-center text-[11px] hover:border-accent hover:text-fg"
      >
        {t("git.linesHidden", { n: lines.length - CONTEXT_LINES * 2 })}
      </button>
      <pre className="overflow-x-auto">{lines.slice(-CONTEXT_LINES).join("\n")}</pre>
    </div>
  );
}

function SideBlock({
  title,
  label,
  tone,
  code,
  chosen,
  onPick,
}: {
  title: string;
  label: string;
  tone: "ours" | "theirs";
  code: string;
  chosen: boolean;
  onPick: () => void;
}) {
  const toneClasses = tone === "ours" ? "border-ok/40" : "border-accent/40";
  const badgeClasses = tone === "ours" ? "text-ok" : "text-accent";
  return (
    <div className={`min-w-0 flex-1 rounded-md border ${chosen ? "border-accent" : toneClasses}`}>
      <button
        onClick={onPick}
        className={`flex w-full items-center gap-1.5 border-b border-line px-2 py-1 text-[11px] hover:bg-elevated ${badgeClasses}`}
      >
        {chosen && <Check size={11} />}
        <span className="font-semibold">{title}</span>
        <span className="truncate text-muted">{label}</span>
      </button>
      <pre className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-[12px] whitespace-pre">
        {code || " "}
      </pre>
    </div>
  );
}

function ConflictCard({
  index,
  conflict,
  resolution,
  aiBusy,
  canUseAi,
  onResolve,
  onAi,
}: {
  index: number;
  conflict: ConflictSection;
  resolution: Resolution | null;
  aiBusy: boolean;
  canUseAi: boolean;
  onResolve: (resolution: Resolution | null) => void;
  onAi: () => void;
}) {
  const [showBase, setShowBase] = useState(false);
  const [editing, setEditing] = useState(false);
  const t = useT();

  if (resolution) {
    const text = resolvedText(conflict, resolution);
    return (
      <div className="mx-3 my-1.5 rounded-lg border border-ok/50">
        <div className="flex items-center gap-1.5 border-b border-line px-2 py-1 text-[11px]">
          <Check size={11} className="text-ok" />
          <span className="font-semibold text-ok">
            #{index + 1} {t("git.resolved")}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => {
              setEditing(!editing);
            }}
            title={t("git.editResolution")}
            className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={() => {
              onResolve(null);
            }}
            className="rounded px-1.5 py-0.5 text-muted hover:bg-elevated hover:text-fg"
          >
            {t("git.change")}
          </button>
        </div>
        {editing ? (
          <textarea
            value={text}
            onChange={(e) => {
              onResolve({ kind: "custom", text: e.target.value });
            }}
            rows={Math.min(12, text.split("\n").length + 1)}
            className="w-full resize-y bg-elevated px-2 py-1.5 font-mono text-[12px] outline-none"
          />
        ) : (
          <pre className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-[12px] whitespace-pre">
            {text || " "}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="mx-3 my-1.5 rounded-lg border border-danger/50">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1 text-[11px]">
        <span className="font-semibold text-danger">#{index + 1}</span>
        <span className="flex-1" />
        {conflict.base !== null && (
          <button
            onClick={() => {
              setShowBase(!showBase);
            }}
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-muted hover:bg-elevated hover:text-fg"
          >
            {showBase ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {t("git.base")}
          </button>
        )}
      </div>
      <div className="flex gap-1.5 p-1.5">
        <SideBlock
          title={t("git.ours")}
          label={conflict.oursLabel}
          tone="ours"
          code={conflict.ours}
          chosen={false}
          onPick={() => {
            onResolve({ kind: "ours" });
          }}
        />
        <SideBlock
          title={t("git.theirs")}
          label={conflict.theirsLabel}
          tone="theirs"
          code={conflict.theirs}
          chosen={false}
          onPick={() => {
            onResolve({ kind: "theirs" });
          }}
        />
      </div>
      {showBase && conflict.base !== null && (
        <pre className="max-h-32 overflow-auto border-t border-line px-2 py-1.5 font-mono text-[12px] text-muted">
          {conflict.base}
        </pre>
      )}
      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        <button
          onClick={() => {
            onResolve({ kind: "ours" });
          }}
          className="rounded-md border border-line px-2 py-0.5 text-[11px] hover:border-ok hover:text-ok"
        >
          {t("git.acceptOurs")}
        </button>
        <button
          onClick={() => {
            onResolve({ kind: "theirs" });
          }}
          className="rounded-md border border-line px-2 py-0.5 text-[11px] hover:border-accent hover:text-accent"
        >
          {t("git.acceptTheirs")}
        </button>
        <button
          onClick={() => {
            onResolve({ kind: "both" });
          }}
          className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
        >
          {t("git.acceptBoth")}
        </button>
        <span className="flex-1" />
        {canUseAi && (
          <button
            onClick={onAi}
            disabled={aiBusy}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-accent hover:border-accent disabled:opacity-50"
          >
            {aiBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {t("git.aiResolve")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Full-screen merge-conflict resolver for one file. */
export function ConflictView({ relativePath }: { relativePath: string }) {
  const { rootPath, closeDiff, openFilePath, openFile } = useWorkspace();
  const providerHealth = useAi((s) => s.providerHealth);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [resolutions, setResolutions] = useState<(Resolution | null)[]>([]);
  const [aiBusy, setAiBusy] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const absolutePath = rootPath ? `${rootPath}/${relativePath}` : null;

  useEffect(() => {
    if (!absolutePath) return;
    let stale = false;
    invoke<string>("read_file", { path: absolutePath })
      .then((content) => {
        if (stale) return;
        const parsed = parseConflicts(content);
        setSections(parsed);
        setResolutions(parsed.filter((s) => s.kind === "conflict").map(() => null));
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
    return () => {
      stale = true;
    };
  }, [absolutePath]);

  const conflicts = useMemo(
    () => (sections ?? []).filter((s): s is ConflictSection => s.kind === "conflict"),
    [sections],
  );
  const remaining = resolutions.filter((r) => r === null).length;
  const canUseAi = providerHealth === "ok";

  const setResolution = (index: number, resolution: Resolution | null) => {
    setResolutions((prev) => prev.map((r, i) => (i === index ? resolution : r)));
  };

  /** Nearby file text gives the AI enough context to merge sensibly. */
  const contextAround = (conflictIndex: number): string => {
    if (!sections) return "";
    let seen = -1;
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section.kind === "conflict") {
        seen += 1;
        if (seen === conflictIndex) {
          const before = i > 0 ? sections[i - 1] : null;
          const after = i + 1 < sections.length ? sections[i + 1] : null;
          const head = before && before.kind === "text" ? before.text.slice(-AI_CONTEXT_CHARS) : "";
          const tail = after && after.kind === "text" ? after.text.slice(0, AI_CONTEXT_CHARS) : "";
          return `${head}\n<CONFLICT HERE>\n${tail}`;
        }
      }
    }
    return "";
  };

  const resolveWithAi = async (index: number) => {
    const conflict = conflicts[index];
    if (!rootPath || aiBusy !== null) return;
    setAiBusy(index);
    setError(null);
    try {
      const basePart = conflict.base === null ? "" : `\nBASE (common ancestor):\n${conflict.base}\n`;
      const merged = await aiOneshot(
        `Resolve this git merge conflict in ${relativePath}. Output ONLY the merged code for the conflicted region - no markers, no fences, no commentary. Preserve the intent of BOTH sides when they don't contradict.\n\n` +
          `FILE CONTEXT:\n${contextAround(index)}\n\nOURS (${conflict.oursLabel}):\n${conflict.ours}\n${basePart}\nTHEIRS (${conflict.theirsLabel}):\n${conflict.theirs}`,
        rootPath,
      );
      setResolution(index, { kind: "custom", text: merged });
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setAiBusy(null);
    }
  };

  const resolveAllWithAi = async () => {
    for (let i = 0; i < conflicts.length; i++) {
      if (resolutions[i] === null) {
        // Sequential on purpose: each result renders as it lands.
        await resolveWithAi(i);
      }
    }
  };

  const save = async () => {
    if (!sections || !absolutePath || !rootPath || remaining > 0) return;
    setSaving(true);
    setError(null);
    try {
      const content = rebuildContent(sections, resolutions);
      await invoke("write_file", { path: absolutePath, content });
      await invoke("git_stage", { root: rootPath, paths: [relativePath] });
      if (openFilePath === absolutePath) await openFile(absolutePath);
      await useGit.getState().refresh();
      closeDiff();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  let conflictCursor = -1;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="truncate text-muted">{relativePath}</span>
        <span className="rounded bg-danger/15 px-1.5 text-[10px] text-danger">
          {t("git.conflictCount", { n: conflicts.length })}
        </span>
        <span className="flex-1" />
        {canUseAi && remaining > 0 && (
          <button
            onClick={() => void resolveAllWithAi()}
            disabled={aiBusy !== null}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-accent hover:border-accent disabled:opacity-50"
          >
            {aiBusy !== null ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {t("git.aiResolveAll")}
          </button>
        )}
        <button
          onClick={() => void save()}
          disabled={remaining > 0 || saving}
          className="rounded-md bg-accent-strong px-2.5 py-0.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {remaining > 0 ? t("git.remaining", { n: remaining }) : t("git.saveResolved")}
        </button>
        <button onClick={closeDiff} className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg">
          <X size={13} />
        </button>
      </div>

      {error && (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {sections?.map((section, i) => {
          if (section.kind === "text") {
            return <ContextBlock key={`t-${String(i)}`} text={section.text} />;
          }
          conflictCursor += 1;
          const index = conflictCursor;
          return (
            <ConflictCard
              key={`c-${String(i)}`}
              index={index}
              conflict={section}
              resolution={resolutions[index]}
              aiBusy={aiBusy === index}
              canUseAi={canUseAi}
              onResolve={(resolution) => {
                setResolution(index, resolution);
              }}
              onAi={() => void resolveWithAi(index)}
            />
          );
        })}
      </div>
    </div>
  );
}
