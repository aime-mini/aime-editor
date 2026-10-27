import {
  ERROR_PORT,
  OUT_PORT,
  type Flow,
  type HumanConfig,
  type InputBundle,
  type Step,
  type StepOutput,
  type Wire,
  stepWrites,
} from "./model";
import { fill } from "./template";
import { loopWires } from "./validate";

/**
 * The run of a flow: which step runs when, with what, and what the journal
 * says about it.
 *
 * Dataflow, not a program counter. Every wire carries a token: pending until
 * its source has settled, live when the source took it, dead when it did not
 * (the other branch of a gate, a step that was skipped). A step runs when
 * every wire into it has settled and at least one is live; a step whose wires
 * are all dead is skipped, and so is everything only it would have reached.
 * A wire back to an earlier step is a loop: taking it starts the target's next
 * round at once, counted against the wire's `maxRounds`.
 *
 * The engine never touches the outside world itself: the executors do, and
 * the journal is written by the caller. That is what makes a run resumable -
 * started again with its journal, every step whose result is on record is
 * replayed from it, and the run carries on from the first step that is not -
 * and testable with executors that merely remember what they were asked.
 */

export type Platform = "windows" | "macos" | "linux";

export interface Ask {
  mode: HumanConfig["mode"];
  prompt: string;
  options?: string[];
  fields?: { name: string; note?: string }[];
  /** What the step was given, for the person to see. */
  input: Record<string, StepOutput>;
}

export interface StepContext {
  flow: Flow;
  step: Step;
  round: number;
  attempt: number;
  /** The output of every live upstream step, by step id; `input` for the input step's. */
  input: Record<string, StepOutput>;
  /**
   * Every step that has settled in this run so far, by id: what a `{{step.value}}`
   * resolves against, so a step can name the analysis three steps back
   * without a wire from it.
   */
  settled: Record<string, StepOutput>;
  bundle: InputBundle;
  /** The workspace the flow belongs to. */
  root: string;
  /** Where files are read and written: the worktree of this run, or the workspace. */
  workRoot: string;
  platform: Platform;
  signal: AbortSignal;
  log: (line: string) => void;
  /** A run that shows what it would send to the outside world and sends nothing. */
  preview: boolean;
}

export interface StepResult {
  output: StepOutput;
  costUsd?: number;
  /** A gate's answer: the label of the branch to take. */
  branch?: string;
}

/** What runs a step of each ability. */
export interface Executors {
  run: (context: StepContext) => Promise<StepResult>;
}

export type RunEvent =
  | { kind: "run-started"; flow: Flow; bundle: InputBundle; root: string; workRoot: string; at: number }
  | { kind: "step-started"; step: string; round: number; attempt: number; at: number }
  | {
      kind: "step-done";
      step: string;
      round: number;
      output: StepOutput;
      costUsd?: number;
      branch?: string;
      at: number;
    }
  | {
      kind: "step-failed";
      step: string;
      round: number;
      attempt: number;
      error: string;
      final: boolean;
      at: number;
    }
  | {
      kind: "item-done";
      step: string;
      round: number;
      index: number;
      output: StepOutput;
      costUsd?: number;
      at: number;
    }
  | { kind: "item-failed"; step: string; round: number; index: number; error: string; at: number }
  | { kind: "waiting"; step: string; round: number; ask: Ask; at: number }
  | { kind: "answered"; step: string; round: number; answer: unknown; at: number }
  | { kind: "skipped"; step: string; at: number }
  | { kind: "log"; step: string; round: number; line: string; at: number }
  | { kind: "run-paused"; reason: "cost"; costUsd: number; limitUsd: number; at: number }
  | {
      kind: "run-done";
      status: "done" | "failed" | "cancelled";
      error?: string;
      costUsd: number;
      at: number;
    };

export interface RunOptions {
  flow: Flow;
  bundle: InputBundle;
  root: string;
  workRoot: string;
  platform: Platform;
  executors: Executors;
  /** A human step: resolves with the person's answer, however long that takes. */
  ask: (step: Step, ask: Ask) => Promise<unknown>;
  /** The cost limit was reached: resolves true to go on with as much again. */
  confirmCost: (spentUsd: number, limitUsd: number) => Promise<boolean>;
  journal: (event: RunEvent) => Promise<void>;
  signal: AbortSignal;
  /** The journal of this run's earlier attempt, to carry on from. */
  resumeFrom?: RunEvent[];
  now?: () => number;
  /** Every step that reaches outside previews instead; the rest run as usual. */
  preview?: boolean;
}

export interface RunOutcome {
  status: "done" | "failed" | "cancelled";
  error?: string;
  costUsd: number;
  outputs: Map<string, StepOutput>;
}

/** Thrown by an executor for a result the person declined; it ends the run without being an error. */
export class Declined extends Error {}

const LOOP_LIMIT = "loop limit reached";

export async function runFlow(options: RunOptions): Promise<RunOutcome> {
  const run = new FlowRun(options);
  return run.start();
}

type WireState = "pending" | "live" | "dead";
type StepState = "idle" | "running" | "done" | "failed" | "dead";

const wireKey = (wire: Wire) => `${wire.from}:${wire.port}->${wire.to}`;

class FlowRun {
  private readonly steps = new Map<string, Step>();
  private readonly loops: Set<Wire>;
  private readonly wireState = new Map<string, WireState>();
  private readonly stepState = new Map<string, StepState>();
  private readonly outputs = new Map<string, StepOutput>();
  private readonly rounds = new Map<string, number>();
  private readonly loopRounds = new Map<string, number>();
  private readonly recorded: RecordedRun;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private inFlight = 0;
  private costUsd = 0;
  private limitUsd: number | undefined;
  private ended: RunOutcome | null = null;
  private finish: (outcome: RunOutcome) => void = () => undefined;

  constructor(private readonly options: RunOptions) {
    for (const step of options.flow.steps) {
      this.steps.set(step.id, step);
      this.stepState.set(step.id, "idle");
    }
    this.loops = new Set(loopWires(options.flow));
    for (const wire of options.flow.wires) {
      if (!this.loops.has(wire)) this.wireState.set(wireKey(wire), "pending");
    }
    this.recorded = recordedOf(options.resumeFrom ?? []);
    this.now = options.now ?? Date.now;
    this.limitUsd = options.flow.settings.costLimitUsd;
    options.signal.addEventListener("abort", () => {
      this.end({ status: "cancelled", costUsd: this.costUsd, outputs: this.outputs });
    });
  }

  async start(): Promise<RunOutcome> {
    const { flow, bundle, root, workRoot } = this.options;
    const input = flow.steps.find((step) => step.config.ability === "input");
    if (input === undefined) {
      return { status: "failed", error: "the flow has no input step", costUsd: 0, outputs: this.outputs };
    }
    const outcome = new Promise<RunOutcome>((resolve) => {
      this.finish = resolve;
    });
    if (this.options.resumeFrom === undefined) {
      await this.options.journal({ kind: "run-started", flow, bundle, root, workRoot, at: this.now() });
    }
    this.launch(input, 1);
    return outcome;
  }

  // ---- scheduling --------------------------------------------------------------

  private launch(step: Step, round: number) {
    if (this.ended !== null) return;
    this.stepState.set(step.id, "running");
    this.rounds.set(step.id, round);
    this.inFlight += 1;
    void this.execute(step, round)
      .catch((error: unknown) => {
        // A bug in the engine itself, not in the step: the run must still end.
        this.end({ status: "failed", error: describe(error), costUsd: this.costUsd, outputs: this.outputs });
      })
      .finally(() => {
        this.inFlight -= 1;
        if (this.inFlight === 0 && this.ended === null) {
          this.end({ status: "done", costUsd: this.costUsd, outputs: this.outputs });
        }
      });
  }

  /** The upstream outputs a step runs on: every source that has one. */
  private inputOf(step: Step): Record<string, StepOutput> {
    const input: Record<string, StepOutput> = {};
    for (const wire of this.options.flow.wires) {
      if (wire.to !== step.id) continue;
      const live = this.loops.has(wire) || this.wireState.get(wireKey(wire)) === "live";
      const output = this.outputs.get(wire.from);
      if (live && output !== undefined) input[wire.from] = output;
    }
    return input;
  }

  private settled(step: Step, result: StepResult) {
    if (this.ended !== null) return;
    this.outputs.set(step.id, result.output);
    this.stepState.set(step.id, "done");
    const outgoing = this.options.flow.wires.filter((wire) => wire.from === step.id);
    const isTaken = (wire: Wire) =>
      step.config.ability === "gate" ? wire.port === result.branch : wire.port === OUT_PORT;
    // A step that just sent the run round a loop will settle again; the wires
    // it did not take this time stay pending for that, rather than dying.
    const loopsAgain = outgoing.some((wire) => isTaken(wire) && this.loops.has(wire));
    for (const wire of outgoing) {
      if (isTaken(wire)) this.take(wire);
      else if (!loopsAgain) this.drop(wire);
    }
  }

  /**
   * Before a loop's next round: the steps of its body - from the target
   * through to the step that sent the run back - are idle again, and the
   * wires between them pending, so each runs once more when its turn comes.
   */
  private resetLoopBody(target: Step, source: Step) {
    const forward = this.options.flow.wires.filter((wire) => !this.loops.has(wire));
    const from = (id: string, pick: (wire: Wire) => string, where: (wire: Wire, id: string) => boolean) => {
      const seen = new Set<string>();
      const queue = [id];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined || seen.has(current)) continue;
        seen.add(current);
        for (const wire of forward) if (where(wire, current)) queue.push(pick(wire));
      }
      return seen;
    };
    const ahead = from(
      target.id,
      (wire) => wire.to,
      (wire, id) => wire.from === id,
    );
    const behind = from(
      source.id,
      (wire) => wire.from,
      (wire, id) => wire.to === id,
    );
    const body = new Set([...ahead].filter((id) => behind.has(id)));
    for (const id of body) {
      this.stepState.set(id, "idle");
    }
    for (const wire of forward) {
      if (body.has(wire.from) && body.has(wire.to)) this.wireState.set(wireKey(wire), "pending");
    }
  }

  private failed(step: Step, error: string) {
    if (this.ended !== null) return;
    this.stepState.set(step.id, "failed");
    const errorWires = this.options.flow.wires.filter(
      (wire) => wire.from === step.id && wire.port === ERROR_PORT,
    );
    if (step.onError === "errorWire" && errorWires.length > 0) {
      this.outputs.set(step.id, { value: { error }, files: [], summary: error });
      for (const wire of this.options.flow.wires) {
        if (wire.from !== step.id) continue;
        if (wire.port === ERROR_PORT) this.take(wire);
        else this.drop(wire);
      }
      return;
    }
    this.end({
      status: "failed",
      error: `${step.name}: ${error}`,
      costUsd: this.costUsd,
      outputs: this.outputs,
    });
  }

  private take(wire: Wire) {
    const target = this.steps.get(wire.to);
    if (target === undefined) return;
    if (this.loops.has(wire)) {
      const key = wireKey(wire);
      const round = (this.loopRounds.get(key) ?? 0) + 1;
      this.loopRounds.set(key, round);
      const source = this.steps.get(wire.from);
      if (round > (wire.maxRounds ?? 0)) {
        if (source !== undefined) this.failed(source, LOOP_LIMIT);
        return;
      }
      if (source !== undefined) this.resetLoopBody(target, source);
      this.launch(target, (this.rounds.get(target.id) ?? 0) + 1);
      return;
    }
    this.wireState.set(wireKey(wire), "live");
    this.consider(target);
  }

  private drop(wire: Wire) {
    if (this.loops.has(wire)) return;
    this.wireState.set(wireKey(wire), "dead");
    const target = this.steps.get(wire.to);
    if (target !== undefined) this.consider(target);
  }

  private consider(step: Step) {
    if (this.stepState.get(step.id) !== "idle") return;
    const incoming = this.options.flow.wires.filter((wire) => wire.to === step.id && !this.loops.has(wire));
    const states = incoming.map((wire) => this.wireState.get(wireKey(wire)) ?? "pending");
    const live = states.some((state) => state === "live");
    const settled = states.every((state) => state !== "pending");
    if (settled && !live) {
      this.stepState.set(step.id, "dead");
      void this.options.journal({ kind: "skipped", step: step.id, at: this.now() });
      for (const wire of this.options.flow.wires) if (wire.from === step.id) this.drop(wire);
      return;
    }
    if (live && (settled || step.joinFirst === true)) {
      this.launch(step, (this.rounds.get(step.id) ?? 0) + 1);
    }
  }

  /** Whether the run has ended, asked rather than read: the field changes under an await. */
  private over(): boolean {
    return this.ended !== null;
  }

  private end(outcome: RunOutcome) {
    if (this.ended !== null) return;
    this.ended = outcome;
    this.abort.abort();
    void this.options
      .journal({
        kind: "run-done",
        status: outcome.status,
        error: outcome.error,
        costUsd: outcome.costUsd,
        at: this.now(),
      })
      .finally(() => {
        this.finish(outcome);
      });
  }

  // ---- one step ---------------------------------------------------------------

  private async execute(step: Step, round: number) {
    const recorded = this.recorded.done.get(`${step.id}#${String(round)}`);
    if (recorded !== undefined) {
      // Already in the journal, cost and all: written again, a resumed run
      // would show every earlier step's cost twice and grow its journal.
      this.costUsd += recorded.costUsd ?? 0;
      this.settled(step, recorded);
      return;
    }
    const input = this.inputOf(step);
    const attempts = step.retries + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.over()) return;
      await this.options.journal({ kind: "step-started", step: step.id, round, attempt, at: this.now() });
      try {
        const result = await this.attempt(step, round, attempt, input);
        if (this.over()) return;
        await this.options.journal({
          kind: "step-done",
          step: step.id,
          round,
          output: result.output,
          costUsd: result.costUsd,
          branch: result.branch,
          at: this.now(),
        });
        // A for-each was charged item by item, so the limit could stop it midway.
        if (step.forEach !== true) await this.charge(result.costUsd);
        this.settled(step, result);
        return;
      } catch (error: unknown) {
        if (this.over()) return;
        const message = describe(error);
        const final = attempt === attempts || error instanceof Declined;
        await this.options.journal({
          kind: "step-failed",
          step: step.id,
          round,
          attempt,
          error: message,
          final,
          at: this.now(),
        });
        if (final) {
          this.failed(step, message);
          return;
        }
      }
    }
  }

  private async attempt(
    step: Step,
    round: number,
    attempt: number,
    input: Record<string, StepOutput>,
  ): Promise<StepResult> {
    if (step.config.ability === "human") return this.askPerson(step, round, input);
    if (step.forEach === true) return this.eachItem(step, round, attempt, input);
    return this.once(step, round, attempt, input);
  }

  private async once(
    step: Step,
    round: number,
    attempt: number,
    input: Record<string, StepOutput>,
  ): Promise<StepResult> {
    const context = this.contextOf(step, round, attempt, input);
    try {
      return await this.options.executors.run(context);
    } finally {
      context.release();
    }
  }

  /** One run per item of the list input, `parallel` at a time, joined back in order. */
  private async eachItem(
    step: Step,
    round: number,
    attempt: number,
    input: Record<string, StepOutput>,
  ): Promise<StepResult> {
    const items = listIn(input);
    if (items === null) {
      throw new Error("for each item needs a list: the step's input holds none");
    }
    const outputs: (StepOutput | undefined)[] = new Array<StepOutput | undefined>(items.length).fill(
      undefined,
    );
    const failures: { index: number; error: string }[] = [];
    let costUsd = 0;
    let next = 0;
    const worker = async () => {
      while (next < items.length && !this.over()) {
        const index = next;
        next += 1;
        const recorded = this.recorded.items.get(`${step.id}#${String(round)}#${String(index)}`);
        if (recorded !== undefined) {
          outputs[index] = recorded;
          continue;
        }
        const context = this.contextOf(step, round, attempt, {
          ...input,
          item: {
            value: items[index],
            files: [],
            summary: `item ${String(index + 1)} of ${String(items.length)}`,
          },
        });
        try {
          const result = await this.options.executors.run(context);
          outputs[index] = result.output;
          // Kept like a replayed item, so a retry of the step does only the items that failed.
          this.recorded.items.set(`${step.id}#${String(round)}#${String(index)}`, result.output);
          costUsd += result.costUsd ?? 0;
          await this.options.journal({
            kind: "item-done",
            step: step.id,
            round,
            index,
            output: result.output,
            costUsd: result.costUsd,
            at: this.now(),
          });
          await this.charge(result.costUsd);
        } catch (error: unknown) {
          const message = describe(error);
          failures.push({ index, error: message });
          await this.options.journal({
            kind: "item-failed",
            step: step.id,
            round,
            index,
            error: message,
            at: this.now(),
          });
          if (step.onError !== "skipItems") {
            next = items.length; // no more items are started
          }
        } finally {
          context.release();
        }
      }
    };
    // Items that change files share one working tree: run side by side, they
    // would edit over each other and test each other's half-written code.
    const parallel = stepWrites(step) ? 1 : this.options.flow.settings.parallel;
    const width = Math.max(1, Math.min(parallel, items.length));
    await Promise.all(Array.from({ length: width }, worker));
    if (failures.length > 0 && (step.onError !== "skipItems" || failures.length === items.length)) {
      const first = failures[0];
      throw new Error(`item ${String(first.index + 1)}: ${first.error}`);
    }
    const kept = outputs.filter((output): output is StepOutput => output !== undefined);
    return {
      output: {
        value: outputs.map((output) => output?.value ?? null),
        files: kept.flatMap((output) => output.files),
        summary:
          failures.length === 0
            ? `${String(items.length)} items`
            : `${String(kept.length)} of ${String(items.length)} items, ${String(failures.length)} failed`,
      },
      costUsd,
    };
  }

  private async askPerson(step: Step, round: number, input: Record<string, StepOutput>): Promise<StepResult> {
    if (step.config.ability !== "human") throw new Error("not a human step");
    const answered = this.recorded.answers.get(`${step.id}#${String(round)}`);
    const ask: Ask = {
      mode: step.config.mode,
      // Filled like an AI step's instruction: the person is asked about the
      // analysis itself, not about `{{analyse.value}}`.
      prompt: fill(step.does, { outputs: this.scopeFor(input), bundle: this.options.bundle }),
      options: step.config.options,
      fields: step.config.fields,
      input,
    };
    let answer: unknown;
    if (answered !== undefined) {
      answer = answered;
    } else {
      await this.options.journal({ kind: "waiting", step: step.id, round, ask, at: this.now() });
      answer = await this.options.ask(step, ask);
      await this.options.journal({ kind: "answered", step: step.id, round, answer, at: this.now() });
    }
    if (step.config.mode === "approve" && !isApproved(answer)) {
      throw new Declined(
        typeof answer === "object" && answer !== null && "note" in answer ? String(answer.note) : "declined",
      );
    }
    return { output: { value: answer, files: [], summary: summarize(answer) } };
  }

  /** What a template in a step resolves against: every settled step, its own inputs first. */
  private scopeFor(input: Record<string, StepOutput>): Record<string, StepOutput> {
    return { ...Object.fromEntries(this.outputs), ...input };
  }

  private contextOf(
    step: Step,
    round: number,
    attempt: number,
    input: Record<string, StepOutput>,
  ): StepContext & { release: () => void } {
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
    };
    this.abort.signal.addEventListener("abort", onAbort);
    const timer =
      step.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            controller.abort(new Error(`timed out after ${String(step.timeoutMs)} ms`));
          }, step.timeoutMs);
    return {
      flow: this.options.flow,
      step,
      round,
      attempt,
      input,
      settled: this.scopeFor(input),
      bundle: this.options.bundle,
      root: this.options.root,
      workRoot: this.options.workRoot,
      platform: this.options.platform,
      preview: this.options.preview === true,
      signal: controller.signal,
      log: (line) => {
        void this.options.journal({ kind: "log", step: step.id, round, line, at: this.now() });
      },
      release: () => {
        this.abort.signal.removeEventListener("abort", onAbort);
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  // ---- cost ---------------------------------------------------------------------

  private async charge(costUsd: number | undefined) {
    if (costUsd === undefined || costUsd <= 0) return;
    this.costUsd += costUsd;
    if (this.limitUsd === undefined || this.costUsd < this.limitUsd) return;
    await this.options.journal({
      kind: "run-paused",
      reason: "cost",
      costUsd: this.costUsd,
      limitUsd: this.limitUsd,
      at: this.now(),
    });
    const goOn = await this.options.confirmCost(this.costUsd, this.limitUsd);
    if (!goOn) {
      this.end({
        status: "cancelled",
        error: "stopped at the cost limit",
        costUsd: this.costUsd,
        outputs: this.outputs,
      });
      return;
    }
    this.limitUsd = this.costUsd + (this.options.flow.settings.costLimitUsd ?? 0);
  }
}

// ---- the journal of an earlier attempt --------------------------------------------

interface RecordedRun {
  done: Map<string, StepResult>;
  items: Map<string, StepOutput>;
  answers: Map<string, unknown>;
}

/** What an earlier attempt settled, keyed by step and round, to replay instead of redo. */
function recordedOf(events: RunEvent[]): RecordedRun {
  const done = new Map<string, StepResult>();
  const items = new Map<string, StepOutput>();
  const answers = new Map<string, unknown>();
  for (const event of events) {
    switch (event.kind) {
      case "step-done":
        done.set(`${event.step}#${String(event.round)}`, {
          output: event.output,
          costUsd: event.costUsd,
          branch: event.branch,
        });
        break;
      case "item-done":
        items.set(`${event.step}#${String(event.round)}#${String(event.index)}`, event.output);
        break;
      case "answered":
        answers.set(`${event.step}#${String(event.round)}`, event.answer);
        break;
      default:
        break;
    }
  }
  return { done, items, answers };
}

// ---- helpers -------------------------------------------------------------------------

/** The list a for-each runs over: the one upstream value that is a list. */
function listIn(input: Record<string, StepOutput>): unknown[] | null {
  const lists = Object.values(input)
    .map((output) => output.value)
    .filter((value): value is unknown[] => Array.isArray(value));
  return lists.length === 1 ? lists[0] : null;
}

function isApproved(answer: unknown): boolean {
  if (answer === true) return true;
  return (
    typeof answer === "object" && answer !== null && (answer as { approved?: unknown }).approved === true
  );
}

export function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * A journal without what older builds wrote again on a resume: they journaled
 * every replayed step a second time, so read back as it was, such a run showed
 * its earlier steps running again and their cost twice. Once a step's round
 * has ended, a later start or end of that same round is one of those replays.
 */
export function withoutReplays(events: RunEvent[]): RunEvent[] {
  const ended = new Set<string>();
  return events.filter((event) => {
    if (event.kind !== "step-started" && event.kind !== "step-done") return true;
    const key = `${event.step}#${String(event.round)}`;
    if (ended.has(key)) return false;
    if (event.kind === "step-done") ended.add(key);
    return true;
  });
}
