import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { translate } from "../i18n";
import {
  compileStep as compileOne,
  drawFlow,
  editFlow,
  explainFailure,
  hashOf,
  needsCompiling,
  type FailureReading,
} from "../lib/flows/compiler";
import {
  runFlow,
  withoutReplays,
  type Ask,
  type Platform,
  type RunEvent,
  type RunOutcome,
  type StepContext,
} from "../lib/flows/engine";
import { realExecutors, type Services } from "../lib/flows/executors";
import { fingerprintOf } from "../lib/flows/fingerprint";
import {
  flowWrites,
  slugOf,
  type Flow,
  type InputBundle,
  type InputItem,
  type Step,
  type StepOutput,
} from "../lib/flows/model";
import { notify } from "../lib/flows/notify";
import { TEMPLATES } from "../lib/flows/templates";
import { validate, type Problem } from "../lib/flows/validate";
import { told } from "./notices";

/**
 * The flows of the open workspace and the runs in flight.
 *
 * The engine (`lib/flows/engine.ts`) decides what runs when; this store gives
 * it a place to run - a worktree beside the workspace when the flow writes
 * files - writes its journal through the backend, keeps a view of each run
 * for the screen, answers the engine's questions (a human step, the cost
 * limit) with what the person clicks, and drives the compiler: drawing and
 * editing flows from a description, compiling a step from its text, reading
 * a failed step. The person's own library of flows (app data) sits beside
 * the project's.
 */

/** Mirror of the Rust `StoredFlow`. */
export interface StoredFlow {
  slug: string;
  flow: Flow;
}

export type StepState = "idle" | "running" | "done" | "failed" | "skipped" | "waiting";

export interface StepView {
  state: StepState;
  round: number;
  attempt: number;
  summary: string;
  error: string | null;
  /** The last lines the step logged. */
  log: string[];
  /** A for-each: items done and failed so far, and what the done ones cost. */
  items?: { done: number; failed: number; costUsd: number };
  /** What the step produced, for the inspector's Input and Output tabs. */
  output?: StepOutput;
  /** When its latest attempt started and ended (epoch ms), for the run's progress list. */
  startedAt?: number;
  endedAt?: number;
  /** What the step's AI calls cost, as its CLI reported it. */
  costUsd?: number;
}

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export interface RunView {
  id: string;
  slug: string;
  flow: Flow;
  status: RunStatus;
  error: string | null;
  steps: Partial<Record<string, StepView>>;
  /** A human step waiting for an answer. */
  waiting: { step: Step; ask: Ask } | null;
  /** The cost limit was reached; the run waits to be told to go on. */
  paused: { costUsd: number; limitUsd: number } | null;
  costUsd: number;
  root: string;
  workRoot: string;
  startedAt: number;
  /** When the run ended; absent while it runs. */
  endedAt?: number;
  preview: boolean;
  /** What the run was handed: its text, items and parameters. */
  given: InputBundle;
  /** What the AI made of a failed step, by step id. */
  readings: Partial<Record<string, FailureReading>>;
}

/** Mirror of the Rust `RunHead`: a run's first and last journal events. */
export interface RunHead {
  run: string;
  first: RunEvent;
  last: RunEvent;
}

/** Mirror of the Rust `RunRequest`: a second `aime run <flow>` launch. */
interface RunRequest {
  cwd: string;
  flow: string;
  text: string;
  files: string[];
}

/** What the flows tab shows in the editor area. */
export type FlowsTabView =
  | { kind: "hub" }
  | { kind: "designer"; slug: string }
  | { kind: "history"; slug: string }
  | { kind: "run"; runId: string };

const LOG_LINES_KEPT = 40;

interface FlowsState {
  root: string | null;
  flows: StoredFlow[];
  /** The person's own flows, kept in the app data, usable in any project. */
  mine: StoredFlow[];
  runs: Record<string, RunView>;
  view: FlowsTabView;
  /** The step being tried in the designer, while it runs. */
  trying: string | null;
  /** The AI is drawing or editing a flow. */
  drawing: boolean;
  secretNames: string[];
  /** Something handed in from elsewhere (a file, a ticket) waiting for a flow to run with. */
  pendingInput: InputBundle | null;
  load: (root: string) => Promise<void>;
  loadMine: () => Promise<void>;
  loadSecrets: () => Promise<void>;
  save: (slug: string, flow: Flow) => Promise<void>;
  remove: (slug: string) => Promise<void>;
  saveMine: (slug: string, flow: Flow) => Promise<void>;
  removeMine: (slug: string) => Promise<void>;
  copyToProject: (slug: string) => Promise<string>;
  copyToMine: (slug: string) => Promise<void>;
  takeTemplate: (key: string) => Promise<string>;
  /** Makes a flow from a description; returns its slug. */
  draw: (description: string) => Promise<string>;
  editByDescription: (slug: string, request: string) => Promise<string[]>;
  tryStep: (slug: string, stepId: string) => Promise<void>;
  /** Whether this content of the flow was agreed to on this machine. */
  trusted: (slug: string) => Promise<boolean>;
  trust: (slug: string) => Promise<void>;
  /** Starts a run; the id comes back at once and the run goes on in the background. */
  start: (slug: string, bundle: InputBundle, preview?: boolean) => Promise<string>;
  /** Carries an earlier run on from its journal. */
  resume: (slug: string, runId: string) => Promise<void>;
  /** A new run of the flow as it is now, with everything before `stepId` taken from `runId`. */
  rerunFrom: (runId: string, stepId: string) => Promise<string>;
  explain: (runId: string, stepId: string) => Promise<void>;
  applyReading: (runId: string, stepId: string) => Promise<void>;
  cancel: (runId: string) => void;
  answer: (runId: string, answer: unknown) => void;
  continueAfterCost: (runId: string, goOn: boolean) => void;
  problemsOf: (flow: Flow) => Problem[];
  openHub: () => void;
  openDesigner: (slug: string) => void;
  openHistory: (slug: string) => void;
  openRun: (runId: string) => void;
  /**
   * Puts a past run in memory as its journal tells it - every step's state,
   * output and log replayed, nothing run - for the history to show.
   */
  loadRun: (slug: string, runId: string) => Promise<RunView>;
  listRuns: (slug: string) => Promise<RunHead[]>;
  /** Something to run a flow with, from the tree, the board or the chat. */
  offerInput: (bundle: InputBundle) => void;
  /** Tells the OS when a run needs a person; returns the way to stop telling. */
  watchAsks: () => () => void;
  /** Hears `aime run <flow>` launches; returns the way to stop hearing. */
  watchRunRequests: () => Promise<() => void>;
}

/** What each run keeps for itself beside the view: the handles the engine's questions resolve with. */
interface Live {
  controller: AbortController;
  answer: ((value: unknown) => void) | null;
  costAnswer: ((goOn: boolean) => void) | null;
}

const live = new Map<string, Live>();
/** The input of a run between `start` and the engine picking it up. */

export const useFlows = create<FlowsState>((set, get, api) => {
  const patchRun = (runId: string, patch: (run: RunView) => RunView) => {
    set((state) => {
      const run = (state.runs as Partial<Record<string, RunView>>)[runId];
      if (run === undefined) return state;
      return { runs: { ...state.runs, [runId]: patch(run) } };
    });
  };
  const patchStep = (runId: string, stepId: string, patch: (step: StepView) => StepView) => {
    patchRun(runId, (run) => ({
      ...run,
      steps: { ...run.steps, [stepId]: patch(run.steps[stepId] ?? freshStep()) },
    }));
  };
  const rootOrThrow = () => {
    const { root } = get();
    if (root === null) throw new Error("no workspace is open");
    return root;
  };
  const storedOrThrow = (slug: string) => {
    const stored = get().flows.find((candidate) => candidate.slug === slug);
    if (stored === undefined) throw new Error(`no flow "${slug}" here`);
    return stored;
  };

  /**
   * A run rebuilt from its journal and put in memory: every step's state,
   * output and log replayed, nothing run. What carrying a run on and reading
   * one back in the history both start from.
   */
  const replayJournal = async (slug: string, id: string) => {
    const root = rootOrThrow();
    const events = await readJournal(root, slug, id);
    const started = events.find(
      (event): event is Extract<RunEvent, { kind: "run-started" }> => event.kind === "run-started",
    );
    if (started === undefined) throw new Error(`run ${id} left no journal to read back`);
    const run = newRun(slug, started.flow, root, started.workRoot, false, givenIn(events), id);
    run.startedAt = started.at;
    set((state) => ({ runs: { ...state.runs, [id]: run } }));
    for (const event of events) applyEvent(id, event, patchRun, patchStep);
    return { run, started, events };
  };

  /** Turns an engine event into what the screen shows, then writes it down. */
  const journal = (run: RunView) => async (event: RunEvent) => {
    applyEvent(run.id, event, patchRun, patchStep);
    await invoke("flow_journal_append", { root: run.root, flow: run.slug, run: run.id, event });
  };

  const servicesFor = (run: RunView): Services => ({
    ask: (step, question) =>
      new Promise((resolve) => {
        const handles = live.get(run.id);
        if (handles === undefined) return;
        handles.answer = resolve;
        patchRun(run.id, (current) => ({ ...current, waiting: { step, ask: question } }));
      }),
    flow: (slug) => get().flows.find((stored) => stored.slug === slug)?.flow,
    // A sub-flow journals beside its parent, under the parent's id and its own step.
    journal: (subRun, event) =>
      invoke("flow_journal_append", { root: run.root, flow: run.slug, run: `${run.id}-${subRun}`, event }),
    trackerConnection: () => invoke<string | null>("tracker_binding", { rootPath: run.root }),
  });

  const drive = async (run: RunView, resumeFrom?: RunEvent[]) => {
    const controller = new AbortController();
    live.set(run.id, { controller, answer: null, costAnswer: null });
    const platform = await invoke<Platform>("host_platform");
    const services = servicesFor(run);
    let outcome: RunOutcome;
    try {
      outcome = await runFlow({
        flow: run.flow,
        bundle: run.given,
        root: run.root,
        workRoot: run.workRoot,
        platform,
        executors: realExecutors(services),
        ask: services.ask,
        confirmCost: (costUsd, limitUsd) =>
          new Promise((resolve) => {
            const handles = live.get(run.id);
            if (handles === undefined) return;
            handles.costAnswer = resolve;
            patchRun(run.id, (current) => ({ ...current, paused: { costUsd, limitUsd } }));
          }),
        journal: journal(run),
        signal: controller.signal,
        resumeFrom,
        preview: run.preview,
      });
    } finally {
      live.delete(run.id);
    }
    patchRun(run.id, (current) => ({
      ...current,
      status: outcome.status,
      error: outcome.error ?? null,
      costUsd: outcome.costUsd,
      waiting: null,
      paused: null,
    }));
  };

  /** Every compiled step whose text changed is compiled again before a run. */
  const compileStale = async (slug: string): Promise<Flow> => {
    const root = rootOrThrow();
    let { flow } = storedOrThrow(slug);
    let changed = false;
    for (const step of flow.steps) {
      if (!needsCompiling(step)) continue;
      const compiled = await compileOne(flow, step, sampleScopeFor(get().runs, slug, flow, step.id), root);
      flow = {
        ...flow,
        steps: flow.steps.map((candidate) => (candidate.id === step.id ? compiled : candidate)),
      };
      changed = true;
    }
    if (changed) await get().save(slug, flow);
    return flow;
  };

  const newRun = (
    slug: string,
    flow: Flow,
    root: string,
    workRoot: string,
    preview: boolean,
    given: InputBundle,
    id = runId(),
  ): RunView => ({
    id,
    slug,
    flow,
    status: "running",
    error: null,
    steps: {},
    waiting: null,
    paused: null,
    costUsd: 0,
    root,
    workRoot,
    startedAt: Date.now(),
    preview,
    given,
    readings: {},
  });

  return {
    root: null,
    flows: [],
    mine: [],
    runs: {},
    view: { kind: "hub" },
    trying: null,
    drawing: false,
    secretNames: [],
    pendingInput: null,

    load: async (root) => {
      const flows = await invoke<StoredFlow[]>("flow_list", { root });
      set((state) => ({ root, flows, view: root === state.root ? state.view : { kind: "hub" } }));
    },

    loadMine: async () => {
      const mine = await invoke<StoredFlow[]>("my_flow_list");
      set({ mine });
    },

    loadSecrets: async () => {
      const secretNames = await invoke<string[]>("secret_names");
      set({ secretNames });
    },

    save: async (slug, flow) => {
      const root = rootOrThrow();
      await invoke("flow_save", { root, slug, flow });
      // Written here, by the person: this content is theirs to run.
      await invoke("flow_trust", { root, slug, hash: fingerprintOf(flow) });
      await get().load(root);
    },

    remove: async (slug) => {
      const root = rootOrThrow();
      await invoke("flow_delete", { root, slug });
      await get().load(root);
    },

    saveMine: async (slug, flow) => {
      await invoke("my_flow_save", { slug, flow });
      await get().loadMine();
    },

    removeMine: async (slug) => {
      await invoke("my_flow_delete", { slug });
      await get().loadMine();
    },

    copyToProject: async (slug) => {
      const stored = get().mine.find((candidate) => candidate.slug === slug);
      if (stored === undefined) throw new Error(`no flow "${slug}" of yours`);
      const target = uniqueSlug(
        slug,
        get().flows.map((flow) => flow.slug),
      );
      await get().save(target, stored.flow);
      return target;
    },

    copyToMine: async (slug) => {
      const stored = storedOrThrow(slug);
      await get().saveMine(
        uniqueSlug(
          slug,
          get().mine.map((flow) => flow.slug),
        ),
        stored.flow,
      );
    },

    takeTemplate: async (key) => {
      const template = TEMPLATES.find((candidate) => candidate.key === key);
      if (template === undefined) throw new Error(`no template "${key}"`);
      const slug = uniqueSlug(
        slugOf(template.flow.name),
        get().flows.map((flow) => flow.slug),
      );
      await get().save(slug, structuredClone(template.flow));
      return slug;
    },

    draw: async (description) => {
      const root = rootOrThrow();
      set({ drawing: true });
      try {
        const drawn = await drawFlow(description, root);
        const slug = uniqueSlug(
          slugOf(drawn.flow.name),
          get().flows.map((flow) => flow.slug),
        );
        await get().save(slug, drawn.flow);
        if (drawn.notes.length > 0)
          told(translate("flows.draw.decided", { name: drawn.flow.name }), drawn.notes.join(" · "));
        return slug;
      } finally {
        set({ drawing: false });
      }
    },

    editByDescription: async (slug, request) => {
      const root = rootOrThrow();
      const stored = storedOrThrow(slug);
      set({ drawing: true });
      try {
        const edited = await editFlow(stored.flow, request, root);
        await get().save(slug, edited.flow);
        return edited.notes;
      } finally {
        set({ drawing: false });
      }
    },

    tryStep: async (slug, stepId) => {
      const root = rootOrThrow();
      const { flow } = storedOrThrow(slug);
      const step = flow.steps.find((candidate) => candidate.id === stepId);
      if (step === undefined) throw new Error(`no step "${stepId}"`);
      const input = sampleInputFor(get().runs, slug, flow, stepId) ?? {};
      const latest = latestRun(get().runs, slug);
      const bundle = latest?.given ?? NOTHING_GIVEN;
      const id = `try-${slug}`;
      const run = newRun(slug, flow, root, root, true, bundle, id);
      run.steps = latest === undefined ? {} : { ...latest.steps };
      set((state) => ({ trying: stepId, runs: { ...state.runs, [id]: run } }));
      const controller = new AbortController();
      live.set(id, { controller, answer: null, costAnswer: null });
      patchStep(id, stepId, (view) => ({
        ...view,
        state: "running",
        error: null,
        log: [],
        output: undefined,
      }));
      try {
        const platform = await invoke<Platform>("host_platform");
        const context: StepContext = {
          flow,
          step,
          round: 1,
          attempt: 1,
          input,
          settled: { ...outputsOf(latest), ...input },
          bundle,
          root,
          workRoot: root,
          platform,
          signal: controller.signal,
          preview: true,
          log: (line) => {
            patchStep(id, stepId, (view) => ({ ...view, log: [...view.log, line].slice(-LOG_LINES_KEPT) }));
          },
        };
        const result = await realExecutors(servicesFor(run)).run(context);
        patchStep(id, stepId, (view) => ({
          ...view,
          state: "done",
          summary: result.output.summary,
          output: result.output,
        }));
      } catch (error: unknown) {
        patchStep(id, stepId, (view) => ({
          ...view,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        live.delete(id);
        patchRun(id, (current) => ({ ...current, status: "done" }));
        set({ trying: null });
      }
    },

    trusted: (slug) => {
      const root = rootOrThrow();
      const { flow } = storedOrThrow(slug);
      return invoke<boolean>("flow_trusted", { root, slug, hash: fingerprintOf(flow) });
    },

    trust: async (slug) => {
      const root = rootOrThrow();
      const { flow } = storedOrThrow(slug);
      await invoke("flow_trust", { root, slug, hash: fingerprintOf(flow) });
    },

    start: async (slug, bundle, preview = false) => {
      const root = rootOrThrow();
      const flow = await compileStale(slug);
      const problems = validate(flow).filter((problem) => problem.kind === "error");
      if (problems.length > 0) throw new Error(problems.map((problem) => problem.message).join("; "));
      const id = runId();
      const workRoot = preview ? root : await placeRun(root, id, flow);
      const run = newRun(slug, flow, root, workRoot, preview, bundle, id);
      set((state) => ({ runs: { ...state.runs, [id]: run }, pendingInput: null }));
      void drive(run).catch((error: unknown) => {
        patchRun(id, (current) => ({ ...current, status: "failed", error: String(error) }));
      });
      return id;
    },

    resume: async (slug, id) => {
      const { run, events } = await replayJournal(slug, id);
      patchRun(id, (current) => ({
        ...current,
        status: "running",
        error: null,
        waiting: null,
        paused: null,
      }));
      // The journal of the earlier attempt, without its ending: this one writes its own.
      await drive(
        run,
        events.filter((event) => event.kind !== "run-done"),
      );
    },

    rerunFrom: async (earlierId, stepId) => {
      const earlier = (get().runs as Partial<Record<string, RunView>>)[earlierId];
      if (earlier === undefined) throw new Error("that run is no longer in memory");
      const root = rootOrThrow();
      const flow = await compileStale(earlier.slug);
      const events = await readJournal(root, earlier.slug, earlierId);
      const cut = events.findIndex((event) => event.kind === "step-started" && event.step === stepId);
      // A for-each that stopped partway keeps the items it finished: run again,
      // it does the rest rather than hours of work over.
      const finishedItems =
        cut === -1
          ? []
          : events.slice(cut).filter((event) => event.kind === "item-done" && event.step === stepId);
      const kept = [
        ...(cut === -1 ? events : events.slice(0, cut)).filter(
          (event) => event.kind !== "run-done" && event.kind !== "run-started",
        ),
        ...finishedItems,
      ];
      const id = runId();
      const bundle = earlier.given;
      const run = newRun(earlier.slug, flow, root, earlier.workRoot, earlier.preview, bundle, id);
      set((state) => ({ runs: { ...state.runs, [id]: run } }));
      const started: RunEvent = {
        kind: "run-started",
        flow,
        bundle,
        root,
        workRoot: earlier.workRoot,
        at: Date.now(),
      };
      // The steps it keeps are this run's record too: the engine replays them
      // without writing them, so they are written here, once.
      const record = journal(run);
      await invoke("flow_journal_append", { root, flow: earlier.slug, run: id, event: started });
      for (const event of kept) await record(event);
      void drive(run, kept).catch((error: unknown) => {
        patchRun(id, (current) => ({ ...current, status: "failed", error: String(error) }));
      });
      set({ view: { kind: "run", runId: id } });
      return id;
    },

    explain: async (id, stepId) => {
      const run = (get().runs as Partial<Record<string, RunView>>)[id];
      if (run === undefined) throw new Error("that run is no longer in memory");
      const reading = await explainFailure(run, stepId, run.root);
      patchRun(id, (current) => ({ ...current, readings: { ...current.readings, [stepId]: reading } }));
    },

    applyReading: async (id, stepId) => {
      const run = (get().runs as Partial<Record<string, RunView>>)[id];
      const change = run?.readings[stepId]?.change;
      if (run === undefined || change === undefined || change === null) return;
      const { flow } = storedOrThrow(run.slug);
      const next: Flow = {
        ...flow,
        steps: flow.steps.map((step) =>
          step.id === stepId
            ? { ...step, config: change, compiled: { from: hashOf(step.does), at: Date.now() } }
            : step,
        ),
      };
      await get().save(run.slug, next);
    },

    cancel: (id) => {
      live.get(id)?.controller.abort(new Error("stopped"));
    },

    answer: (id, answer) => {
      const handles = live.get(id);
      if (handles?.answer === null || handles === undefined) return;
      const resolve = handles.answer;
      handles.answer = null;
      patchRun(id, (run) => ({ ...run, waiting: null }));
      resolve(answer);
    },

    continueAfterCost: (id, goOn) => {
      const handles = live.get(id);
      if (handles?.costAnswer === null || handles === undefined) return;
      const resolve = handles.costAnswer;
      handles.costAnswer = null;
      patchRun(id, (run) => ({ ...run, paused: null }));
      resolve(goOn);
    },

    problemsOf: (flow) => validate(flow),

    openHub: () => {
      set({ view: { kind: "hub" } });
    },

    openDesigner: (slug) => {
      set({ view: { kind: "designer", slug } });
    },

    openHistory: (slug) => {
      set({ view: { kind: "history", slug } });
    },

    openRun: (id) => {
      set({ view: { kind: "run", runId: id } });
    },

    loadRun: async (slug, id) => {
      const known = (get().runs as Partial<Record<string, RunView>>)[id];
      if (known !== undefined) return known;
      const { events } = await replayJournal(slug, id);
      // A run the app was closed in the middle of has no ending in its journal;
      // read back, it is a run that stopped there.
      if (!events.some((event) => event.kind === "run-done")) {
        patchRun(id, (current) => ({ ...current, status: "cancelled" }));
      }
      return get().runs[id];
    },

    listRuns: (slug) => {
      const { root } = get();
      if (root === null) return Promise.resolve([]);
      return invoke<RunHead[]>("flow_runs", { root, flow: slug });
    },

    offerInput: (bundle) => {
      set({ pendingInput: bundle, view: { kind: "hub" } });
    },

    watchAsks: () => {
      let announced = new Set<string>();
      return api.subscribe((state) => {
        const needing = new Map<string, RunView>();
        for (const run of Object.values(state.runs)) {
          if (run.waiting !== null) needing.set(`${run.id}:${run.waiting.step.id}`, run);
          else if (run.paused !== null) needing.set(`${run.id}:cost`, run);
        }
        for (const [key, run] of needing) {
          if (announced.has(key)) continue;
          void notify(
            run.flow.name,
            run.waiting !== null
              ? translate("flows.notify.waiting", { step: run.waiting.step.name })
              : translate("flows.notify.cost", { spent: run.costUsd.toFixed(2) }),
          );
        }
        announced = new Set(needing.keys());
      });
    },

    watchRunRequests: () =>
      listen<RunRequest>("flows:run-request", ({ payload }) => {
        const { root, flows } = get();
        // Another window may hold that folder; this one says nothing for it.
        if (root === null || !samePath(root, payload.cwd)) return;
        const slug = flows.some((flow) => flow.slug === payload.flow)
          ? payload.flow
          : flows.find((flow) => slugOf(flow.flow.name) === slugOf(payload.flow))?.slug;
        if (slug === undefined) {
          told(
            translate("flows.cli.unknown", { flow: payload.flow }),
            flows.map((flow) => flow.slug).join(", ") || translate("flows.panel.empty"),
          );
          return;
        }
        const items: InputItem[] = payload.files.map((ref) => ({ kind: "file", ref }));
        void get()
          .start(slug, { text: payload.text, items, params: {} })
          .then((id) => {
            get().openRun(id);
          })
          .catch((error: unknown) => {
            told(
              translate("flows.cli.failed", { flow: slug }),
              error instanceof Error ? error.message : String(error),
            );
          });
      }),
  };
});

const NOTHING_GIVEN: InputBundle = { text: "", items: [], params: {} };

/**
 * What a run was handed, read back from its journal: the input step's value,
 * else what the run started with. A rerun used to start with nothing - it took
 * the bundle from memory, gone once the app restarted - and its parameters
 * came out empty; its input step still carries the real ones.
 */
function givenIn(events: RunEvent[]): InputBundle {
  const input = events.find(
    (event): event is Extract<RunEvent, { kind: "step-done" }> =>
      event.kind === "step-done" && event.step === "input",
  );
  if (input !== undefined && isBundle(input.output.value)) return input.output.value;
  const started = events.find(
    (event): event is Extract<RunEvent, { kind: "run-started" }> => event.kind === "run-started",
  );
  return started?.bundle ?? NOTHING_GIVEN;
}

function isBundle(value: unknown): value is InputBundle {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InputBundle>;
  return (
    typeof candidate.text === "string" &&
    Array.isArray(candidate.items) &&
    typeof candidate.params === "object"
  );
}

/**
 * Where a run works: a flow that writes files gets a worktree beside the
 * workspace (named by the run, as task runs are), unless it asks to run in
 * place; a flow that writes nothing runs where it is. A workspace that is no
 * git repository runs in place and the first step's log says so.
 */
async function placeRun(root: string, id: string, flow: Flow): Promise<string> {
  const wants = flow.settings.where;
  if (wants === "inPlace" || (wants === "auto" && !flowWrites(flow))) return root;
  const path = `${root.replace(/[\\/]+$/, "")}-flow-${id}`;
  try {
    await invoke("git_worktree_add", { root, path });
    return path;
  } catch (error: unknown) {
    if (wants === "worktree") {
      throw new Error(`could not make a worktree for the run: ${String(error)}`, { cause: error });
    }
    return root;
  }
}

/** `20261022-141503-x7k2`: sorts by time, and is a file name everywhere. */
export function runId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const tail = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${tail}`;
}

function freshStep(): StepView {
  return { state: "idle", round: 0, attempt: 0, summary: "", error: null, log: [] };
}

function uniqueSlug(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${String(n)}`)) n += 1;
  return `${base}-${String(n)}`;
}

function samePath(a: string, b: string): boolean {
  const norm = (path: string) =>
    path
      .replace(/[\\/]+$/, "")
      .replace(/\\/g, "/")
      .toLowerCase();
  return norm(a) === norm(b);
}

/** The newest run of a flow in memory, tries included. */
export function latestRun(runs: Record<string, RunView>, slug: string): RunView | undefined {
  return Object.values(runs)
    .filter((run) => run.slug === slug)
    .sort((a, b) => b.startedAt - a.startedAt)
    .at(0);
}

/** What a step was given in a run: the outputs of the steps wired into it. */
export function stepInputIn(
  run: RunView | undefined,
  flow: Flow,
  stepId: string,
): Record<string, StepOutput> | undefined {
  if (run === undefined) return undefined;
  const input: Record<string, StepOutput> = {};
  for (const wire of flow.wires) {
    const output = run.steps[wire.from]?.output;
    if (wire.to === stepId && output !== undefined) input[wire.from] = output;
  }
  return Object.keys(input).length === 0 ? undefined : input;
}

/** Every output a run has, by step: what a step tried alone resolves its templates against. */
function outputsOf(run: RunView | undefined): Record<string, StepOutput> {
  const outputs: Record<string, StepOutput> = {};
  for (const [id, step] of Object.entries(run?.steps ?? {})) {
    if (step?.output !== undefined) outputs[id] = step.output;
  }
  return outputs;
}

/** A run's journal as every reader takes it: without what older builds wrote twice. */
async function readJournal(root: string, slug: string, id: string): Promise<RunEvent[]> {
  return withoutReplays(await invoke<RunEvent[]>("flow_journal_read", { root, flow: slug, run: id }));
}

/**
 * What a step's jq and templates could read in the newest run of its flow -
 * every output there, its own inputs first: the sample it is compiled on.
 */
export function sampleScopeFor(
  runs: Record<string, RunView>,
  slug: string,
  flow: Flow,
  stepId: string,
): Record<string, StepOutput> | undefined {
  const latest = latestRun(runs, slug);
  if (latest === undefined) return undefined;
  return { ...outputsOf(latest), ...stepInputIn(latest, flow, stepId) };
}

/** What a step was given in the newest run of its flow - the sample it is tried on. */
export function sampleInputFor(
  runs: Record<string, RunView>,
  slug: string,
  flow: Flow,
  stepId: string,
): Record<string, StepOutput> | undefined {
  return stepInputIn(latestRun(runs, slug), flow, stepId);
}

/** What one journal event changes on the screen. */
export function applyEvent(
  id: string,
  event: RunEvent,
  patchRun: (runId: string, patch: (run: RunView) => RunView) => void,
  patchStep: (runId: string, stepId: string, patch: (step: StepView) => StepView) => void,
): void {
  switch (event.kind) {
    case "step-started":
      patchStep(id, event.step, (step) => ({
        ...step,
        state: "running",
        round: event.round,
        attempt: event.attempt,
        error: null,
        items: undefined,
        startedAt: event.at,
        endedAt: undefined,
      }));
      break;
    case "step-done": {
      // A for-each's items were counted as they ended; only the rest of its total is new.
      let fresh = event.costUsd ?? 0;
      patchStep(id, event.step, (step) => {
        fresh -= step.items?.costUsd ?? 0;
        return {
          ...step,
          state: "done",
          summary: event.output.summary,
          error: null,
          output: event.output,
          endedAt: event.at,
          costUsd: event.costUsd === undefined ? step.costUsd : (step.costUsd ?? 0) + fresh,
        };
      });
      if (fresh !== 0) patchRun(id, (run) => ({ ...run, costUsd: run.costUsd + fresh }));
      break;
    }
    case "step-failed":
      patchStep(id, event.step, (step) => ({
        ...step,
        state: event.final ? "failed" : "running",
        error: event.error,
        endedAt: event.final ? event.at : step.endedAt,
      }));
      break;
    case "item-done": {
      const cost = event.costUsd ?? 0;
      patchStep(id, event.step, (step) => ({
        ...step,
        costUsd: (step.costUsd ?? 0) + cost,
        items: {
          done: (step.items?.done ?? 0) + 1,
          failed: step.items?.failed ?? 0,
          costUsd: (step.items?.costUsd ?? 0) + cost,
        },
      }));
      // Counted as each item ends, so the total moves while a long for-each runs.
      if (cost > 0) patchRun(id, (run) => ({ ...run, costUsd: run.costUsd + cost }));
      break;
    }
    case "item-failed":
      patchStep(id, event.step, (step) => ({
        ...step,
        items: {
          done: step.items?.done ?? 0,
          failed: (step.items?.failed ?? 0) + 1,
          costUsd: step.items?.costUsd ?? 0,
        },
      }));
      break;
    case "waiting":
      patchStep(id, event.step, (step) => ({ ...step, state: "waiting" }));
      break;
    case "answered":
      patchStep(id, event.step, (step) => ({ ...step, state: "running" }));
      break;
    case "skipped":
      patchStep(id, event.step, (step) => ({ ...step, state: "skipped" }));
      break;
    case "log":
      patchStep(id, event.step, (step) => ({
        ...step,
        log: [...step.log, event.line].slice(-LOG_LINES_KEPT),
      }));
      break;
    case "run-done":
      patchRun(id, (run) => ({
        ...run,
        status: event.status,
        error: event.error ?? null,
        costUsd: event.costUsd,
        endedAt: event.at,
      }));
      break;
    case "run-started":
    case "run-paused":
      break;
  }
}
