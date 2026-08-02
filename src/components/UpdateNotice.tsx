import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Loader2, X } from "lucide-react";
import { useT } from "../i18n";
import { useSettings } from "../stores/settings";

type Phase = "idle" | "downloading" | "failed";

/** What the backend can say about a version the user does not have yet. */
interface UpdateSummary {
  version: string;
  notes: string | null;
  date: string | null;
}

/**
 * Tells the user a new version exists, and installs it when they say so.
 *
 * Checked once per launch and never again: an editor that interrupts while
 * someone is typing has misjudged its own importance. Dismissing hides it for
 * this session, and nothing is downloaded until the user asks for it.
 *
 * The check runs in Rust because that is the only side that can choose an
 * endpoint - the JavaScript updater can only ask the one baked into the
 * config, which would make a second channel impossible.
 */
export function UpdateNotice() {
  const channel = useSettings((s) => s.updateChannel);
  const [update, setUpdate] = useState<UpdateSummary | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [dismissed, setDismissed] = useState(false);
  const t = useT();

  useEffect(() => {
    let stale = false;
    invoke<UpdateSummary | null>("update_check", { channel })
      .then((found) => {
        if (!stale) setUpdate(found);
      })
      .catch((err: unknown) => {
        // No network, no release published yet, a build without a signing key:
        // none of that is worth a word to a user who did not ask about updates.
        console.warn("update check skipped:", err);
      });
    return () => {
      stale = true;
    };
  }, [channel]);

  if (!update || dismissed) return null;

  const install = async () => {
    setPhase("downloading");
    try {
      // Installing ends with the app restarting, so nothing follows this.
      await invoke("update_install", { channel });
    } catch (err: unknown) {
      console.error("update failed:", err);
      setPhase("failed");
    }
  };

  return (
    <div className="flex items-center gap-2 border-b border-accent/40 bg-accent-soft px-3 py-1 text-[12px]">
      <Download size={12} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">
        {t("update.available", { version: update.version })}
        {channel === "beta" && ` · ${t("settings.channel.beta.short")}`}
      </span>
      {phase === "failed" && <span className="shrink-0 text-danger">{t("update.failed")}</span>}
      <button
        onClick={() => void install()}
        disabled={phase === "downloading"}
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
