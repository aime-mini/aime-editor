import { RotateCw } from "lucide-react";
import { useT } from "../i18n";
import { useAi } from "../stores/ai";
import { useWorkspace } from "../stores/workspace";

/**
 * The end of the conversation when a turn did not finish.
 *
 * When the CLI gives up on the AI service - measured with it unreachable: ten
 * retries over three minutes, which the live bubble counts out - or the CLI
 * dies, or the app was closed in the middle of a turn, the reason stays on
 * screen with one button that picks the turn up again (reported 2026-09-29:
 * the only way out was restarting the app).
 */
export function TurnRecovery() {
  const t = useT();
  const running = useAi((s) => s.running);
  const interrupted = useAi((s) => s.interrupted);
  const lastError = useAi((s) => s.lastError);
  const resumable = useAi((s) => s.sessionId !== null);
  const resumeTurn = useAi((s) => s.resumeTurn);
  const rootPath = useWorkspace((s) => s.rootPath);

  return (
    <>
      {lastError && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          {lastError}
        </div>
      )}
      {!running && interrupted && rootPath && (
        <div className="flex flex-wrap items-center gap-2">
          {!lastError && <span className="text-[12px] text-muted">{t("ai.turnCutOff")}</span>}
          <button
            type="button"
            onClick={() => void resumeTurn(rootPath)}
            title={t(resumable ? "ai.resumeHint" : "ai.retryHint")}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12px] text-fg hover:border-accent"
          >
            <RotateCw size={12} /> {t("ai.resume")}
          </button>
        </div>
      )}
    </>
  );
}
