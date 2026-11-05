import { KeyRound, RotateCw } from "lucide-react";
import { useT } from "../i18n";
import { asksToSignInAgain } from "../lib/signInAsked";
import { useAi } from "../stores/ai";
import { useWorkspace } from "../stores/workspace";
import { useSignIn } from "./useSignIn";

/**
 * The end of the conversation when a turn did not finish.
 *
 * When the CLI gives up on the AI service - measured with it unreachable: ten
 * retries over three minutes, which the live bubble counts out - or the CLI
 * dies, or the app was closed in the middle of a turn, the reason stays on
 * screen with one button that picks the turn up again, rather than leaving a
 * restart of the app as the only way out.
 *
 * A reason that says the CLI's sign-in expired also carries the way to sign in
 * again: the CLI's status still reports the old login, so this error is the
 * only place that knows it has to be redone.
 */
export function TurnRecovery() {
  const t = useT();
  const running = useAi((s) => s.running);
  const interrupted = useAi((s) => s.interrupted);
  const lastError = useAi((s) => s.lastError);
  const resumable = useAi((s) => s.sessionId !== null);
  const resumeTurn = useAi((s) => s.resumeTurn);
  const rootPath = useWorkspace((s) => s.rootPath);
  const signIn = useSignIn();
  const signInAgain = !running && lastError !== null && asksToSignInAgain(lastError) ? signIn : null;

  return (
    <>
      {lastError && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          {lastError}
          {signInAgain && (
            <button
              type="button"
              onClick={signInAgain.start}
              title={t("ai.signInWith", { command: signInAgain.command })}
              className="mt-2 flex items-center gap-1.5 rounded-md bg-accent-strong px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
            >
              <KeyRound size={12} /> {t("ai.signInAgain")}
            </button>
          )}
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
