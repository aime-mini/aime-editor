import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Download, Loader2, X } from "lucide-react";
import { useT } from "../i18n";

type Phase = "idle" | "downloading" | "ready" | "failed";

/**
 * Tells the user a new version exists, and installs it when they say so.
 *
 * Checked once per launch and never again: an editor that interrupts while
 * someone is typing has misjudged its own importance. Dismissing hides it for
 * this session, and nothing is downloaded until the user asks for it.
 */
export function UpdateNotice() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [dismissed, setDismissed] = useState(false);
  const t = useT();

  // Loaded on demand rather than imported at the top: an updater that cannot
  // load - no network, an old build, a stale dev server - must cost the user
  // an update check, never the whole editor.
  useEffect(() => {
    // A mutable holder rather than a plain flag: the effect body runs after an
    // await, so the value must be read at that later moment, not captured.
    const cancelled = { value: false };
    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        // The plugin types check() as always returning an Update while it
        // actually answers null when there is nothing newer, so the result is
        // taken as unknown and narrowed here rather than trusted.
        const found: unknown = await check();
        if (!cancelled.value && found) setUpdate(found as Update);
      } catch (err: unknown) {
        console.warn("update check skipped:", err);
      }
    })();
    return () => {
      cancelled.value = true;
    };
  }, []);

  if (!update || dismissed) return null;

  const install = async () => {
    setPhase("downloading");
    try {
      await update.downloadAndInstall();
      setPhase("ready");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err: unknown) {
      console.error("update failed:", err);
      setPhase("failed");
    }
  };

  return (
    <div className="flex items-center gap-2 border-b border-accent/40 bg-accent-soft px-3 py-1 text-[12px]">
      <Download size={12} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">{t("update.available", { version: update.version })}</span>
      {phase === "failed" && <span className="shrink-0 text-danger">{t("update.failed")}</span>}
      <button
        onClick={() => void install()}
        disabled={phase === "downloading" || phase === "ready"}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {phase === "downloading" && <Loader2 size={11} className="animate-spin" />}
        {phase === "downloading" ? t("update.installing") : t("update.install")}
      </button>
      <button
        onClick={() => {
          setDismissed(true);
        }}
        title={t("update.later")}
        className="shrink-0 rounded p-1 text-muted hover:text-fg"
      >
        <X size={11} />
      </button>
    </div>
  );
}
