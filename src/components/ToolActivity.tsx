import { useState } from "react";
import { ChevronRight, Loader2, Wrench } from "lucide-react";
import { useT } from "../i18n";
import type { BackgroundTask, MessagePart, ToolStep } from "../lib/types";
import { formatElapsed, useSecondsSince } from "./useSecondsSince";

export type ToolPart = Extract<MessagePart, { kind: "tool" }>;

/** A command shorter than this needs no clock: it is over before anyone wonders. */
const CLOCK_AFTER_SECONDS = 5;

/**
 * The tool calls an answer made between two pieces of text, folded into one block.
 *
 * An agent that investigates runs dozens of commands, and a chip each pushed the
 * answer off the screen (reported 2026-09-29). Folded, the block says how many
 * steps there were and of which kind, and keeps in view only what is running
 * now; one click lays every step out again.
 *
 * @param liveTail the answer is still being written and this block ends it, so
 *   its last call is the one in flight.
 * @param activeAgents calls whose subagent is still at work in the background,
 *   wherever they sit in the answer.
 */
export function ToolRun({
  tools,
  liveTail,
  activeAgents,
}: {
  tools: ToolPart[];
  liveTail: boolean;
  activeAgents: ReadonlySet<string>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lastIndex = tools.length - 1;
  const isRunning = (part: ToolPart, index: number) =>
    (liveTail && index === lastIndex) || (part.id !== undefined && activeAgents.has(part.id));

  if (tools.length === 1) return <ToolChip part={tools[0]} running={isRunning(tools[0], 0)} />;

  const shown = tools
    .map((part, index) => ({ part, index }))
    .filter(({ part, index }) => open || index === lastIndex || isRunning(part, index));
  return (
    <div className="my-1 flex max-w-full flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
        className="flex w-fit max-w-full items-center gap-1 text-[11px] text-muted hover:text-fg"
      >
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="shrink-0">{t("ai.toolSteps", { count: tools.length })}</span>
        <span className="min-w-0 truncate">· {countByName(tools)}</span>
      </button>
      {shown.map(({ part, index }) => (
        <ToolChip key={index} part={part} running={isRunning(part, index)} />
      ))}
    </div>
  );
}

/** `Bash 12 · Read 2`, the most used tool first. */
function countByName(tools: readonly { name: string }[]): string {
  const counts = new Map<string, number>();
  for (const { name } of tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name} ${String(count)}`)
    .join(" · ");
}

/**
 * One tool call: its name always, then as much of the command as there is room
 * for. A fixed cap is a width the panel never agreed to - narrow the panel and
 * the chip drew over the edge - so the detail truncates instead.
 *
 * A call that started a subagent also carries that subagent's own steps: folded
 * to a count, with the step it is on shown under it while it works.
 */
function ToolChip({ part, running }: { part: ToolPart; running: boolean }) {
  const t = useT();
  const seconds = useSecondsSince(running);
  const [open, setOpen] = useState(false);
  const steps = part.steps ?? [];
  const currentStep = steps.at(-1);
  return (
    <div className="my-0.5 flex max-w-full flex-col">
      <span
        className="flex w-fit max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-0.5 font-mono text-[11px] text-muted"
        title={part.detail}
      >
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
        ) : (
          <Wrench size={11} className="shrink-0 text-accent" />
        )}
        <span className="shrink-0">{part.name}</span>
        {part.detail && <span className="min-w-0 truncate">· {part.detail}</span>}
        {seconds >= CLOCK_AFTER_SECONDS && <span className="shrink-0">· {formatElapsed(seconds)}</span>}
        {steps.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => {
              setOpen((was) => !was);
            }}
            className="flex shrink-0 items-center gap-0.5 font-sans hover:text-fg"
          >
            · {steps.length === 1 ? t("ai.toolStep") : t("ai.toolSteps", { count: steps.length })}
            <ChevronRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        )}
      </span>
      {open ? <StepList steps={steps} /> : running && currentStep && <StepList steps={[currentStep]} />}
    </div>
  );
}

/** A subagent's steps, indented under the call that started it. */
function StepList({ steps }: { steps: ToolStep[] }) {
  return (
    <ul className="ml-2 flex max-w-full flex-col border-l border-line pl-2 font-mono text-[11px] text-muted">
      {steps.map((step, index) => (
        <li key={index} className="flex min-w-0 items-center gap-1.5 py-px" title={step.detail}>
          <span className="shrink-0">{step.name}</span>
          {step.detail && <span className="min-w-0 truncate">· {step.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Says why a turn that has stopped talking has not ended: the CLI is still
 * running something in the background, and the turn only ends when that does.
 *
 * Without it that wait looked exactly like a hang - an answer that had gone
 * quiet with the Stop button still lit - and the way out people found was to
 * restart the app (reported 2026-09-29).
 */
export function BackgroundNotice({ tasks }: { tasks: BackgroundTask[] }) {
  const t = useT();
  const seconds = useSecondsSince(tasks.length > 0);
  if (tasks.length === 0) return null;
  return (
    <div
      role="status"
      className="flex max-w-[92%] items-start gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11px] text-muted"
    >
      <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-accent" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-fg">
          {tasks.length === 1
            ? t("ai.backgroundWaitingOne")
            : t("ai.backgroundWaiting", { count: tasks.length })}{" "}
          · {formatElapsed(seconds)}
        </span>
        {tasks.map((task) => (
          <span key={task.id} className="truncate" title={task.description}>
            {task.description || task.id}
          </span>
        ))}
        <span>{t("ai.backgroundHint")}</span>
      </div>
    </div>
  );
}
