import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Brain, Check, Globe, Loader2, X } from "lucide-react";
import { useT } from "../i18n";
import { capabilitiesOf } from "../lib/providers";
import { useAi } from "../stores/ai";
import { useWorkspace } from "../stores/workspace";

type MemoryTab = "global" | "project";

/** Mirror of the Rust `MemoryPaths` (memory.rs). */
interface MemoryPaths {
  globalPath: string;
  projectPath: string | null;
  bridgePath: string | null;
}

/**
 * Editor for the AI's durable memory files (ARCHITECTURE.md §4).
 * Project memory is one canonical `AGENTS.md` shared by every CLI — Codex
 * reads it natively, Claude through an `@AGENTS.md` import that Aime keeps in
 * `CLAUDE.md` on save. Global memory has no such bridge, so it follows the
 * selected provider's own file. The CLIs re-read both every turn.
 */
export function MemoryModal({ onClose }: { onClose: () => void }) {
  const rootPath = useWorkspace((s) => s.rootPath);
  const providerId = useAi((s) => s.providerId);
  const [tab, setTab] = useState<MemoryTab>(rootPath ? "project" : "global");
  const [paths, setPaths] = useState<MemoryPaths | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    invoke<MemoryPaths>("memory_paths", { providerId, rootPath })
      .then(setPaths)
      .catch((err: unknown) => {
        setError(String(err));
      });
  }, [providerId, rootPath]);

  const activePath = paths === null ? null : tab === "global" ? paths.globalPath : paths.projectPath;

  useEffect(() => {
    if (!activePath) return;
    let stale = false;
    invoke<string>("read_file", { path: activePath })
      .then((text) => {
        if (!stale) {
          setContent(text);
          setSavedContent(text);
        }
      })
      .catch(() => {
        // File does not exist yet — start empty; saving will create it.
        if (!stale) {
          setContent("");
          setSavedContent("");
        }
      });
    return () => {
      stale = true;
    };
  }, [activePath]);

  const dirty = content !== savedContent;

  const save = useCallback(async () => {
    if (!activePath || saving) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("write_file", { path: activePath, content });
      // Keep Claude's pointer file importing the canonical AGENTS.md, so the
      // notes stay visible after a provider switch.
      if (tab === "project" && rootPath) await invoke("ensure_memory_bridge", { rootPath });
      setSavedContent(content);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [activePath, content, rootPath, saving, tab]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, save]);

  const tabButton = (which: MemoryTab, icon: React.ReactNode, label: string, disabled = false) => (
    <button
      onClick={() => {
        setTab(which);
      }}
      disabled={disabled}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs ${
        tab === which
          ? "border-accent text-accent"
          : "border-transparent text-muted hover:text-fg disabled:opacity-40"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16" onClick={onClose}>
      <div
        className="flex max-h-[75vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-center border-b border-line pr-2">
          <Brain size={15} className="mx-3 shrink-0 text-accent" />
          {tabButton("project", <Brain size={13} />, t("memory.project"), !rootPath)}
          {tabButton("global", <Globe size={13} />, t("memory.global"))}
          <span className="flex-1" />
          {dirty && <span className="mr-2 size-2 rounded-full bg-accent" title={t("editor.unsavedHint")} />}
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <p className="border-b border-line px-4 py-2 text-[11px] text-muted">
          {tab === "global"
            ? t("memory.globalHint", { provider: capabilitiesOf(providerId).displayName })
            : t("memory.projectHint")}
          {activePath && <span className="ml-1 font-mono">{activePath}</span>}
        </p>

        {error && (
          <div className="border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-[12px] text-danger">
            {error}
          </div>
        )}

        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
          }}
          placeholder={t("memory.placeholder")}
          spellCheck={false}
          className="min-h-64 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted"
        />

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2">
          <span className="flex-1 text-[10px] text-muted">{t("memory.footer")}</span>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving || !activePath}
            className="flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t("memory.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
