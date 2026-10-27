import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Eye, FolderOpen, Loader2, Paperclip, Play, X } from "lucide-react";
import { useT } from "../../i18n";
import { needsCompiling } from "../../lib/flows/compiler";
import type { Flow, InputBundle, InputHint, InputItem } from "../../lib/flows/model";
import { isWithin, relativeTo } from "../../lib/repositories";
import { useFlows } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { TrustDialog } from "./TrustDialog";

/**
 * Running a flow: a composer like the chat box - type, attach files and
 * folders - with the flow's input hints above it as a guide, its parameters
 * as fields, and where the run works below. Nothing here refuses an input
 * the flow did not expect.
 */
export function RunDialog({ slug, flow, onClose }: { slug: string; flow: Flow; onClose: () => void }) {
  const t = useT();
  const start = useFlows((s) => s.start);
  const openRun = useFlows((s) => s.openRun);
  const trusted = useFlows((s) => s.trusted);
  const trust = useFlows((s) => s.trust);
  const offered = useFlows((s) => s.pendingInput);
  const [text, setText] = useState(offered?.text ?? "");
  const [items, setItems] = useState<InputItem[]>(offered?.items ?? []);
  const [preview, setPreview] = useState(false);
  const [gate, setGate] = useState<"unknown" | "trusted" | "asking">("unknown");
  useEffect(() => {
    trusted(slug)
      .then((ok) => {
        setGate(ok ? "trusted" : "asking");
      })
      .catch(() => {
        setGate("asking");
      });
  }, [slug, trusted]);
  const [params, setParams] = useState<Record<string, string>>(
    Object.fromEntries(
      flow.input.hints
        .filter((hint) => hint.default !== undefined)
        .map((hint) => [hint.name, hint.default ?? ""]),
    ),
  );
  const [starting, setStarting] = useState(false);
  // Steps whose text changed since their command or jq was written: the run
  // has the AI write them again first, which takes a turn each.
  const toCompile = flow.steps.filter(needsCompiling).length;
  const fields = flow.input.hints.filter((hint) => hint.default !== undefined);
  const guides = flow.input.hints.filter((hint) => hint.default === undefined);

  const attach = async (directory: boolean) => {
    const picked = await open({ directory, multiple: true });
    if (picked === null) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setItems((current) => [
      ...current,
      ...paths.map((ref) => ({ kind: directory ? ("folder" as const) : ("file" as const), ref })),
    ]);
  };

  const run = async () => {
    setStarting(true);
    const bundle: InputBundle = { text: text.trim(), items, params };
    try {
      const id = await start(slug, bundle, preview);
      openRun(id);
      onClose();
    } finally {
      setStarting(false);
    }
  };

  if (gate === "asking") {
    return (
      <TrustDialog
        flow={flow}
        onTrust={() => {
          trust(slug)
            .then(() => {
              setGate("trusted");
            })
            .catch(failedTo(t("flows.trust.run")));
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-20" onClick={onClose}>
      <div
        role="dialog"
        aria-label={t("flows.run.title", { name: flow.name })}
        className="w-[560px] max-w-[92vw] rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <Play size={14} className="text-accent" />
          <span className="flex-1 text-[13px] font-semibold">
            {t("flows.run.title", { name: flow.name })}
          </span>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 text-[12px]">
          {guides.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">{t("flows.run.expects")}</span>
              {guides.map((hint) => (
                <span
                  key={hint.name}
                  className="rounded-full border border-line px-2 py-0.5 text-[11px]"
                  title={hint.note}
                >
                  {hint.name}
                </span>
              ))}
            </div>
          )}
          {fields.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {fields.map((hint) => (
                <label key={hint.name} className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted">{hint.name}</span>
                  {hint.choices !== undefined && hint.choices.length > 0 ? (
                    <select
                      value={params[hint.name] ?? ""}
                      onChange={(e) => {
                        setParams({ ...params, [hint.name]: e.target.value });
                      }}
                      className={field}
                    >
                      {hint.choices.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  ) : hint.kind === "folder" || hint.kind === "file" ? (
                    <PathField
                      hint={hint}
                      value={params[hint.name] ?? ""}
                      onChange={(value) => {
                        setParams({ ...params, [hint.name]: value });
                      }}
                    />
                  ) : (
                    <input
                      value={params[hint.name] ?? ""}
                      onChange={(e) => {
                        setParams({ ...params, [hint.name]: e.target.value });
                      }}
                      className={field}
                    />
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="rounded-lg border border-line bg-elevated">
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void run();
              }}
              placeholder={t("flows.run.placeholder")}
              rows={4}
              className="w-full resize-none bg-transparent px-3 py-2 outline-none"
              data-flow-input
            />
            {items.length > 0 && (
              <div className="flex flex-wrap gap-1 px-3 pb-2">
                {items.map((item, index) => (
                  <span
                    key={`${item.kind}-${item.ref}`}
                    className="flex items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 text-[11px]"
                  >
                    {item.kind === "folder" ? <FolderOpen size={11} /> : <Paperclip size={11} />}
                    <span className="max-w-56 truncate">{item.ref.split(/[\\/]/).pop()}</span>
                    <button
                      onClick={() => {
                        setItems(items.filter((_, i) => i !== index));
                      }}
                      className="text-muted hover:text-fg"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1 border-t border-line px-2 py-1">
              <button
                onClick={() => void attach(false).catch(failedTo(t("flows.run.attach")))}
                className={chip}
              >
                <Paperclip size={12} /> {t("flows.run.attachFiles")}
              </button>
              <button
                onClick={() => void attach(true).catch(failedTo(t("flows.run.attach")))}
                className={chip}
              >
                <FolderOpen size={12} /> {t("flows.run.attachFolder")}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-muted">
            {t(flow.settings.where === "inPlace" ? "flows.run.inPlace" : "flows.run.worktree")}
          </p>
          <label className="flex items-center gap-2 text-[11.5px]">
            <input
              type="checkbox"
              checked={preview}
              onChange={(e) => {
                setPreview(e.target.checked);
              }}
              data-flow-preview
            />
            <Eye size={12} className="text-muted" />
            <span>{t("flows.run.preview")}</span>
            <span className="text-[10.5px] text-muted">{t("flows.run.previewHint")}</span>
          </label>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="flex-1 text-[11px] text-muted" data-flow-start-note>
            {starting && toCompile > 0
              ? t("flows.run.compiling", { n: toCompile })
              : t("flows.run.resumeNote")}
          </span>
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void run().catch(failedTo(t("flows.run.title", { name: flow.name })))}
            disabled={starting}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 font-medium text-white bg-accent-strong hover:opacity-90 disabled:opacity-50"
            data-flow-start
          >
            {starting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}{" "}
            {t("flows.run.go")} <kbd className="ml-1 text-[10px] opacity-70">Ctrl+Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A parameter that names a folder or a file: typed, or picked. A pick inside
 * the workspace is written relative to it, which is how steps read paths in
 * and what still holds when the run works in a worktree beside the workspace.
 */
function PathField({
  hint,
  value,
  onChange,
}: {
  hint: InputHint;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const root = useFlows((s) => s.root);
  const pick = async () => {
    const picked = await open({
      directory: hint.kind === "folder",
      multiple: false,
      defaultPath: root ?? undefined,
    });
    if (typeof picked !== "string") return;
    if (root === null || !isWithin(picked, root)) {
      onChange(picked);
      return;
    }
    onChange(relativeTo(root, picked) || ".");
  };
  return (
    <span className="flex gap-1">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={`${field} min-w-0 flex-1`}
        data-flow-param={hint.name}
      />
      <button
        onClick={() => void pick().catch(failedTo(t("flows.run.pick")))}
        title={t("flows.run.pick")}
        className="rounded border border-line px-1.5 text-muted hover:border-accent hover:text-fg"
        data-flow-param-pick={hint.name}
      >
        <FolderOpen size={12} />
      </button>
    </span>
  );
}

const field = "rounded border border-line bg-elevated px-2 py-1 text-[12px] outline-none focus:border-accent";
const chip =
  "flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted hover:bg-panel hover:text-fg";
