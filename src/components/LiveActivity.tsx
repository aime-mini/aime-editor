import { Clock3, CornerDownRight, Loader2, X } from "lucide-react";
import { useT } from "../i18n";
import type { QueuedPrompt } from "../stores/ai";
import type { ApiRetry, TurnActivity } from "../lib/types";
import { formatElapsed, useSecondsFrom } from "./useSecondsSince";

/** Below this a count of characters reads better whole. */
const THOUSAND = 1_000;

/**
 * The line under the conversation that says what the AI is doing this second.
 *
 * It does not scroll with the answer: the reader may be anywhere in the
 * conversation, and the one question that has to be answerable from there is
 * "is it still working, and on what". Every state moves - a bar sweeps along
 * the top edge, the words carry a passing light, the clock climbs - because a
 * quiet mark reads as a hang.
 */
export function LiveActivity({
  activity,
  retrying,
  provider,
}: {
  activity: TurnActivity;
  retrying: ApiRetry | null;
  provider: string;
}) {
  const t = useT();
  const seconds = useSecondsFrom(activity.since);
  const { label, detail } = retrying
    ? { label: t("ai.retrying", { attempt: retrying.attempt, max: retrying.maxAttempts }), detail: "" }
    : describe(activity, provider, t);
  return (
    <div
      // A live region, but not a `status`: that role belongs to the notice of
      // background work, and one turn has one of each.
      aria-live="polite"
      data-activity={activity.kind}
      className="relative flex shrink-0 items-center gap-2 overflow-hidden border-t border-line bg-elevated/60 px-3 py-1.5 text-[11.5px]"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] overflow-hidden">
        <span className="block h-full w-1/4 animate-sweep rounded-full bg-accent" />
      </span>
      <span className="flex w-4 shrink-0 justify-center text-accent">
        {/* Not the thinking dots: those stand where the answer's words will appear. */}
        {activity.kind === "tool" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <span className="size-2 animate-pulse rounded-full bg-accent" />
        )}
      </span>
      <span className="shrink-0 animate-shimmer font-medium text-shimmer">{label}</span>
      {detail && (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted" title={detail}>
          · {shortDetail(detail)}
        </span>
      )}
      <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted tabular-nums">
        {formatElapsed(seconds)}
      </span>
    </div>
  );
}

type Translate = ReturnType<typeof useT>;

function describe(activity: TurnActivity, provider: string, t: Translate): { label: string; detail: string } {
  switch (activity.kind) {
    case "waiting":
      return { label: t("ai.activity.waiting", { provider }), detail: "" };
    case "thinking":
      return { label: t("ai.activity.thinking"), detail: "" };
    case "writing":
      return { label: t("ai.activity.writing"), detail: "" };
    case "tool": {
      if (!activity.preparing)
        return { label: t("ai.activity.running", { tool: activity.name }), detail: activity.detail };
      const label = t("ai.activity.preparing", { tool: activity.name });
      return activity.inputChars === 0
        ? { label, detail: activity.detail }
        : {
            label: `${label} · ${t("ai.activity.written", { count: formatCount(activity.inputChars) })}`,
            detail: activity.detail,
          };
    }
  }
}

/**
 * A path is said by its file name - the end of a long path is the part that
 * matters, and truncation would cut exactly that; anything else is shown as is.
 */
function shortDetail(detail: string): string {
  if (/\s/.test(detail) || !/[\\/]/.test(detail)) return detail;
  return detail.split(/[\\/]/).filter(Boolean).at(-1) ?? detail;
}

function formatCount(count: number): string {
  return count < THOUSAND ? String(count) : `${(count / THOUSAND).toFixed(1)}k`;
}

/** Where a queued message stands, as its label and its `data-queued` say. */
type QueuedState = "waiting" | "handed" | "withdrawing";

function queuedState(item: QueuedPrompt): QueuedState {
  if (item.withdrawing) return "withdrawing";
  return item.sent === null ? "waiting" : "handed";
}

const QUEUED_LABEL = {
  waiting: "ai.queue.waiting",
  handed: "ai.queue.handed",
  withdrawing: "ai.queue.withdrawing",
} as const;

/**
 * Messages written while the AI is still at work. They read as the user's own
 * words, in the place they will take in the conversation, but dashed and
 * labelled: handed over, for the AI to read at its next step, or waiting for
 * the turn to end. Until the AI has read one it can be taken back - a handed
 * one only from a CLI that gives it back (`withdrawable`).
 */
export function QueuedPrompts({
  queued,
  withdrawable,
  onRemove,
}: {
  queued: QueuedPrompt[];
  withdrawable: boolean;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  return queued.map((item) => {
    const state = queuedState(item);
    return (
      <div key={item.id} className="flex flex-col items-end gap-1">
        <div className="flex max-w-[92%] items-start gap-2 rounded-lg border border-dashed border-accent/60 bg-accent-soft/40 px-3 py-2 leading-relaxed break-words whitespace-pre-wrap text-fg/80">
          <span className="min-w-0 flex-1">{item.text}</span>
          {(state === "waiting" || withdrawable) && (
            <button
              onClick={() => {
                onRemove(item.id);
              }}
              disabled={state === "withdrawing"}
              title={t("ai.queue.remove")}
              className="-mr-1 shrink-0 rounded p-0.5 text-muted hover:bg-elevated hover:text-fg disabled:hover:bg-transparent"
            >
              {state === "withdrawing" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            </button>
          )}
        </div>
        <span className="flex items-center gap-1 text-[10.5px] text-muted" data-queued={state}>
          {state === "waiting" ? <Clock3 size={10} /> : <CornerDownRight size={10} />}{" "}
          {t(QUEUED_LABEL[state])}
        </span>
      </div>
    );
  });
}
