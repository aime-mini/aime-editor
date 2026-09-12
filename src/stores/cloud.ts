import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { translate } from "../i18n";
import { aiOneshot } from "../lib/aiOneshot";
import { DISCOVER_PROMPT, parseArchitecture } from "../lib/cloudDiscovery";
import type { Basis } from "../lib/cloudMap";
import { renderCloudNote, spliceCloudNote, type CloudNote } from "../lib/cloudMemory";
import { cliRefusal, shortCliError } from "../lib/cloudErrors";
import { opsPrompt, parseOps, sawEmptyList, type CheckedOps, type ProposedOp } from "../lib/cloudOps";
import {
  buildReadPlanPrompt,
  buildReadRepairPrompt,
  parseReadPlan,
  withPlaceholders,
  type FailedRead,
  type AwsCatalog,
  type ConnectionFact,
  type PlannableCloud,
  type PlannedRead,
  type ReadPlan,
  type RejectedRead,
  type StoredPlan,
} from "../lib/cloudReads";
import { runInTerminal } from "./terminals";
import { useWorkspace } from "./workspace";

/**
 * The clouds this machine can reach, and what they hold.
 *
 * Connecting is signing into the vendor's own CLI - Aime never asks for a key,
 * and never stores one (see `src-tauri/src/cloud/`). What this store adds is
 * the half the user asked for: once a cloud is connected, show what is already
 * running there as the applications it is made of, open any resource to its
 * own configuration and connection details, and write the architecture into
 * the project's memory so the next request to deploy or to chase a bug starts
 * from what exists.
 *
 * Reaching the network stays rare on purpose: accounts come from what the CLI
 * keeps on disk (Google Cloud's projects are the one listing that has to ask
 * the cloud, once per tab open), an account's resources are fetched when it is
 * opened and then kept, and one resource's settings when that resource is
 * opened. Every one of those calls is a call into somebody's cloud, and
 * clicking back to something already looked at must cost nothing.
 */

/** Mirror of the Rust `CloudStatus` (cloud/mod.rs). */
export interface CloudStatus {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  version: string | null;
  /** Set when the CLI is a copy Aime downloaded, not one on PATH. */
  path: string | null;
  signedIn: boolean | null;
  account: string | null;
  signInHint: string;
  installHint: string;
  /** Whether Aime could run that install here - see the Rust `CloudStatus`. */
  installable: boolean;
}

/** Mirror of the Rust `MemoryPaths` (memory.rs), as far as a project needs it. */
interface MemoryPaths {
  projectPath: string | null;
}

/** Mirror of the Rust `CloudAccount` (cloud/mod.rs). */
export interface CloudAccount {
  id: string;
  label: string;
  detail: string;
  current: boolean;
  /**
   * Who owns it, when that cloud has such a level: the signed-in user behind
   * an Azure subscription, the Google account behind a project. Empty for an
   * AWS profile, which is just a name in a config file until something calls
   * the cloud (see the Rust doc).
   */
  owner: string;
  /** The Azure tenant, which a sign-in for this account has to name. */
  tenant: string;
  /** The command that signs into THIS account, read from the CLI's own config. */
  signIn: string;
}

/** Mirror of the Rust `CloudResource` (cloud/mod.rs). */
export interface CloudResource {
  id: string;
  name: string;
  /**
   * The name the CLI takes for this resource, which is not always the name
   * shown: a Google service account reads `Default compute service account`
   * and is addressed by its email. Mirrors the Rust `cli_name`; empty for a
   * resource that reached the panel before Aime told the two apart.
   */
  cliName: string;
  kind: string;
  location: string;
  group: string;
  /**
   * The resource's own tags. This is how a team says which application a
   * resource belongs to, which is the question a thousand-row list has to
   * answer - "which of these ten apps is this one part of".
   */
  tags: Record<string, string>;
}

/** What one account's resource list is doing, per account. */
export type ResourceState =
  // No `idle`: a slot with nothing in it is absent from the map, which is the
  // same fact with one representation instead of two.
  | { kind: "loading" }
  | { kind: "loaded"; resources: CloudResource[]; truncated: boolean; readAt: number }
  /** The CLI's own words - which is what says "sign in again" when it does. */
  | { kind: "failed"; reason: string };

/** What the read plan for one KIND of resource is doing. */
export type PlanState =
  | { kind: "planning" }
  | { kind: "ready"; reads: PlannedRead[]; facts: ConnectionFact[]; rejected: RejectedRead[] }
  | { kind: "failed"; reason: string };

/** What the operations for one KIND of resource are doing. */
export type OpsState =
  | { kind: "planning" }
  | { kind: "ready"; ops: ProposedOp[]; rejected: { label: string; reason: string }[] }
  | { kind: "failed"; reason: string };

/** One operation as it runs: the command, its output so far, how it ended. */
export interface RunningOp {
  /** The run id the backend streams `exec:output` under. */
  id: string;
  resourceId: string;
  label: string;
  /** The command line exactly as it runs, project and account included. */
  command: string;
  lines: string[];
  /** Null while it is still running; the exit code once it is over. */
  code: number | null;
}

/** One read's answer for one resource. */
export type AnswerState =
  | { kind: "loading" }
  /** The CLI's own JSON, kept verbatim - it is that cloud's own vocabulary. */
  | { kind: "loaded"; json: string }
  | { kind: "failed"; reason: string };

/** A sign-in started from the panel, as far as it has got. */
export type SignInState =
  /** The CLI's own flow is running in a terminal tab; the panel is asking after it. */
  | { stage: "terminal" }
  | { stage: "starting" }
  /** The CLI issued a code; the page is open and the code is on the clipboard. */
  | { stage: "code"; url: string; code: string }
  /**
   * The page is open; the CLI waits for the code it shows to be pasted back.
   * `rejected` is why the last paste was refused before it reached the CLI.
   */
  | { stage: "page"; url: string; rejected?: string }
  /** The code was handed to the CLI, which is exchanging it. */
  | { stage: "exchanging" }
  | { stage: "done"; ok: boolean; message: string };

/** Mirror of the Rust `SignInEvent` (cloud/sign_in.rs). */
type SignInEvent =
  | { stage: "code"; cloudId: string; url: string; code: string }
  | { stage: "page"; cloudId: string; url: string }
  | { stage: "done"; cloudId: string; ok: boolean; message: string };

/** Mirror of the Rust `CredentialsChanged` (cloud/credentials.rs). */
interface CredentialsChanged {
  cloudId: string;
}

/** The two ways of looking at an account. */
export type CloudViewMode = "map" | "list";

/** One account of one cloud, as a cache key. */
export function slotOf(cloudId: string, accountId: string): string {
  return `${cloudId}/${accountId}`;
}

/** One read of one resource, as a cache key. */
export function answerKey(resource: CloudResource, read: PlannedRead): string {
  return `${resource.id}#${read.label}`;
}

/** Where this install remembers which clouds the user wants tabs for. */
const SHOWN_KEY = "aime.cloud.shown";

/**
 * The clouds the user picked, or null when they have never been asked.
 *
 * Null is not "none": it is the question still open, which is what opens the
 * picker the first time the panel is looked at, and what makes every cloud
 * visible until an answer exists. Requested 2026-09-09 - four tabs is three
 * tabs of somebody else's cloud for a person who uses one.
 */
export function readShownClouds(): string[] | null {
  const raw = localStorage.getItem(SHOWN_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Anything else in that key is an answer nobody gave: ask again rather
    // than draw a panel with no tabs and no way back to them.
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch (error: unknown) {
    console.warn("could not read the chosen clouds:", error);
    return null;
  }
}

/** Clouds whose CLI Aime has a measured way to plan reads for. */
const PLANNABLE: ReadonlySet<string> = new Set<PlannableCloud>(["azure", "aws", "gcp", "supabase"]);

function isPlannable(cloudId: string): cloudId is PlannableCloud {
  return PLANNABLE.has(cloudId);
}

/**
 * Clouds whose CLI opens no browser of its own when told not to: Azure prints
 * a device code, Google Cloud prints its consent page. AWS has no such flow
 * (see `cloud/sign_in.rs`), so its sign-in runs in a terminal tab.
 */
const BROWSER_FREE_SIGN_IN: ReadonlySet<string> = new Set(["azure", "gcp"]);

interface CloudState {
  clouds: CloudStatus[];
  /** False until the first probe answers, so the panel can say "looking". */
  ready: boolean;
  /**
   * True while the four CLIs are being asked again - after an install, a
   * sign-in, a reopen. Reported 2026-09-05: with nothing to say so, a cloud
   * that had just been installed kept reading "not on this machine" for the
   * whole probe, and the probe looked like the answer.
   */
  probing: boolean;
  /** The cloud a discovery is running for, or null. */
  discovering: string | null;
  /** What the last discovery wrote, or why it wrote nothing. */
  result: { cloud: string; wrote: boolean; detail: string } | null;
  /** What every discovery in this session found, newest answer per cloud. */
  notes: Record<string, CloudNote>;

  /**
   * Accounts each cloud's CLI already holds, read from its local state.
   * A cloud absent from the map has not been asked yet - which is not the same
   * as one that answered with none.
   */
  accounts: Record<string, CloudAccount[] | undefined>;
  /** The cloud tab in front of the user. */
  tab: string;
  /**
   * The clouds that get a tab, or null while the user has not said - in which
   * case every cloud is shown, as it was before there was a choice to make.
   */
  shown: string[] | null;
  /** True while the "which clouds do you use" picker is over the panel. */
  picking: boolean;
  /** The account selected per cloud, so switching tabs keeps its place. */
  selected: Record<string, string | undefined>;
  /** Resources per account - loaded once, kept, never re-fetched on a click. */
  resources: Record<string, ResourceState | undefined>;
  /** Map or list, per account, because the choice is about that account. */
  view: Record<string, CloudViewMode | undefined>;
  /** The person's own choice of what an application is, per account. */
  basis: Record<string, Basis | undefined>;
  /** The resource whose detail is open, if any. */
  detail: CloudResource | null;
  /** The read plan per kind, keyed `<cloud>/<kind>`; on disk after the first time. */
  plans: Record<string, PlanState | undefined>;
  /** Every read's answer, keyed by `answerKey`. Never written anywhere else. */
  answers: Record<string, AnswerState | undefined>;
  /** What a developer can DO to one kind of resource, keyed `<cloud>/<kind>`. */
  ops: Record<string, OpsState | undefined>;
  /** The operation running right now, if any - one at a time, on purpose. */
  running: RunningOp | null;
  /** Sign-ins in flight or just finished, per cloud. */
  signIns: Record<string, SignInState | undefined>;

  refresh: () => Promise<void>;
  discover: (id: string) => Promise<void>;
  /** Shows one cloud's tab, reading its accounts the first time. */
  openTab: (id: string) => Promise<void>;
  /** Opens the picker, ticked as the panel stands. */
  openPicker: () => void;
  closePicker: () => void;
  /** Keeps a tab for these clouds only, and remembers it for next time. */
  chooseClouds: (ids: string[]) => void;
  /** Closes one cloud's tab. What was read from it stays cached for its return. */
  hideCloud: (id: string) => void;
  /** Selects an account and loads its resources if they are not in hand. */
  selectAccount: (cloudId: string, accountId: string) => Promise<void>;
  /** Fetches an account's resources again, after a sign-in or a change. */
  reload: (cloudId: string, accountId: string) => Promise<void>;
  setView: (slot: string, view: CloudViewMode) => void;
  setBasis: (slot: string, basis: Basis) => void;
  /** Opens a resource, plans its kind's reads if needed, and runs the safe ones. */
  openDetail: (resource: CloudResource | null) => void;
  /**
   * Starts planning this kind's reads before anything is opened.
   *
   * The plan is what turns a row into a page of configuration, it is made once
   * per kind per machine, and the first resource of a kind used to pay for it
   * with a wait on the very tab a developer opens. Pointing at a row is enough
   * intent to start; a kind already planned or being planned costs nothing.
   */
  warmPlan: (resource: CloudResource) => void;
  /** Runs one planned read against one resource - the only way a secret is read. */
  runRead: (resource: CloudResource, read: PlannedRead) => Promise<void>;
  /** Forgets the plan for a resource's kind and asks the AI again, for this resource first. */
  replan: (resource: CloudResource) => Promise<void>;
  /**
   * Asks the AI what a developer can DO to this kind, and has Aime check it.
   *
   * One call per kind, cached like the read plans. The AI never runs anything:
   * it answers commands written against placeholders, `cloud_check_deploy`
   * proves every one against the CLI on this machine, and what survives is
   * offered as a button.
   */
  planOps: (resource: CloudResource) => Promise<void>;
  /** Runs one checked operation on one resource, with its output kept as it arrives. */
  runOp: (resource: CloudResource, op: ProposedOp, args: string[]) => Promise<void>;
  /** Stops the operation running, if one is. */
  stopOp: () => Promise<void>;
  /** Clears the finished operation's output. */
  clearOp: () => void;
  /** Signs into one account, the way that account's CLI needs. */
  signIn: (cloudId: string, account: CloudAccount) => Promise<void>;
  /** Hands the code the sign-in page showed to the CLI waiting for it. */
  submitSignInCode: (cloudId: string, code: string) => Promise<void>;
  cancelSignIn: (cloudId: string) => Promise<void>;
  /** Re-reads a cloud on its own when its CLI records a sign-in, whoever performed it. */
  watchSignIns: () => Promise<void>;
  /** Makes one account the CLI's own default - only when asked. */
  setDefaultAccount: (cloudId: string, account: CloudAccount) => Promise<void>;
}

/**
 * The clouds with a tab, in the order the probe reports them.
 *
 * The order is the probe's rather than the user's clicks, so a cloud that
 * comes back sits where it always sat instead of at the end of the strip.
 */
export function visibleClouds(clouds: CloudStatus[], shown: string[] | null): CloudStatus[] {
  if (shown === null) return clouds;
  return clouds.filter((cloud) => shown.includes(cloud.id));
}

const FIRST_TAB = "azure";
const initialShown = readShownClouds();

export const useCloud = create<CloudState>((set, get) => ({
  clouds: [],
  ready: false,
  probing: false,
  discovering: null,
  result: null,
  notes: {},
  accounts: {},
  tab: initialShown?.at(0) ?? FIRST_TAB,
  shown: initialShown,
  picking: false,
  selected: {},
  resources: {},
  view: {},
  basis: {},
  detail: null,
  plans: {},
  answers: {},
  ops: {},
  running: null,
  signIns: {},

  openTab: async (id) => {
    set({ tab: id, detail: null });
    if (get().accounts[id] !== undefined) return;
    // A click on a tab and the effect that follows the tab both arrive here
    // before either answer lands; one listing serves both. Measured 2026-09-05:
    // without this, `gcloud projects list` ran twice per tab open.
    const inFlight = listingAccounts.get(id);
    if (inFlight !== undefined) return inFlight;
    const run = (async () => {
      try {
        const accounts = await invoke<CloudAccount[]>("cloud_accounts", { cloudId: id });
        set((state) => ({ accounts: { ...state.accounts, [id]: accounts } }));
        // Land on the account the CLI itself would use, so the first thing shown
        // is the one the user's own terminal is pointing at.
        const start = accounts.find((account) => account.current) ?? accounts.at(0);
        if (start !== undefined && get().selected[id] === undefined) {
          await get().selectAccount(id, start.id);
        }
      } catch (error: unknown) {
        console.warn(`could not list ${id} accounts:`, error);
        set((state) => ({ accounts: { ...state.accounts, [id]: [] } }));
      } finally {
        listingAccounts.delete(id);
      }
    })();
    listingAccounts.set(id, run);
    return run;
  },

  openPicker: () => {
    set({ picking: true });
  },

  closePicker: () => {
    set({ picking: false });
  },

  chooseClouds: (ids) => {
    localStorage.setItem(SHOWN_KEY, JSON.stringify(ids));
    set((state) => {
      // The tab in front has to be one of the tabs that are left; the detail
      // over it belongs to the cloud that was in front, so it goes with it.
      const kept = ids.includes(state.tab);
      return {
        shown: ids,
        picking: false,
        tab: kept ? state.tab : (ids.at(0) ?? state.tab),
        detail: kept ? state.detail : null,
      };
    });
  },

  hideCloud: (id) => {
    const remaining = visibleClouds(get().clouds, get().shown)
      .map((cloud) => cloud.id)
      .filter((candidate) => candidate !== id);
    get().chooseClouds(remaining);
    // Closing the last tab is a question, not an empty panel.
    if (remaining.length === 0) get().openPicker();
  },

  selectAccount: async (cloudId, accountId) => {
    set((state) => ({
      selected: { ...state.selected, [cloudId]: accountId },
      detail: null,
    }));
    // Cached on purpose: every one of these is a call into somebody's cloud,
    // and clicking back to an account already looked at must cost nothing.
    if (get().resources[slotOf(cloudId, accountId)] !== undefined) return;
    await get().reload(cloudId, accountId);
  },

  reload: async (cloudId, accountId) => {
    const slot = slotOf(cloudId, accountId);
    set((state) => ({ resources: { ...state.resources, [slot]: { kind: "loading" } } }));
    try {
      const inventory = await invoke<{ resources: CloudResource[]; truncated: boolean }>("cloud_resources", {
        cloudId,
        account: accountId,
      });
      set((state) => ({
        resources: {
          ...state.resources,
          [slot]: {
            kind: "loaded",
            resources: inventory.resources,
            truncated: inventory.truncated,
            readAt: Date.now(),
          },
        },
      }));
    } catch (error: unknown) {
      // Kept verbatim. Measured on this machine: `az resource list` answers
      // `Status_InteractionRequired` when the cached account's token has
      // expired - "no resources" would send the reader looking for the wrong
      // thing, when what they need is to sign in again.
      set((state) => ({
        resources: { ...state.resources, [slot]: { kind: "failed", reason: String(error) } },
      }));
    }
  },

  setView: (slot, view) => {
    set((state) => ({ view: { ...state.view, [slot]: view } }));
  },

  setBasis: (slot, basis) => {
    set((state) => ({ basis: { ...state.basis, [slot]: basis } }));
  },

  openDetail: (resource) => {
    set({ detail: resource });
    if (resource === null) return;
    void planAndRead(resource, get, set);
  },

  warmPlan: (resource) => {
    void ensurePlan(get().tab, resource, get, set);
  },

  planOps: async (resource) => {
    const cloudId = get().tab;
    const key = slotOf(cloudId, resource.kind);
    const known = get().ops[key];
    if (known !== undefined && known.kind !== "failed") return;
    // Only Google Cloud has a checker for whole commands so far (`deploy.rs`),
    // and offering a button Aime cannot prove is worse than offering none.
    if (cloudId !== OPERABLE) {
      setOps(set, key, { kind: "failed", reason: translate("cloud.opsNoCloud") });
      return;
    }
    setOps(set, key, { kind: "planning" });
    try {
      const cwd = useWorkspace.getState().rootPath ?? ".";
      const reply = await aiOneshot(opsPrompt(resource.kind), cwd, true);
      const proposed = parseOps(reply);
      if (proposed.length === 0) {
        // Two very different things used to read the same on screen: a kind
        // the AI had nothing to offer for, and an answer Aime could not read
        // at all - which is usually the CLI saying something else entirely.
        // Reported 2026-09-10; the second case now shows what came back, the
        // way every other failure in this panel shows the tool's own words.
        const unreadable = [translate("cloud.opsNoAnswer"), reply.trim().slice(0, REPLY_SHOWN)];
        setOps(set, key, {
          kind: "failed",
          reason: sawEmptyList(reply) ? translate("cloud.opsNothingHere") : unreadable.join("\n\n"),
        });
        return;
      }
      // The AI's list goes through the same checker a deployment's steps go
      // through: the words must exist on THIS machine's CLI, nothing may
      // delete, and nothing may replace a running service's settings.
      const checked = await invoke<CheckedOps & { steps: unknown }>("cloud_check_deploy", {
        cloudId,
        existing: true,
        plan: { steps: proposed.map(asStep), keep: [], prove: null },
        // Unlike a deployment, day-to-day work on a resource includes taking
        // it away; the typed-name confirmation is what stands in front of it.
        removal: true,
      });
      setOps(set, key, {
        kind: "ready",
        ops: keptOps(proposed, checked),
        rejected: rejectedOps(checked),
      });
    } catch (error: unknown) {
      setOps(set, key, { kind: "failed", reason: String(error) });
    }
  },

  runOp: async (resource, op, args) => {
    const cloudId = get().tab;
    const accountId = get().selected[cloudId];
    const account = get().accounts[cloudId]?.find((candidate) => candidate.id === accountId);
    if (account === undefined || get().running !== null) return;

    const id = `cloud-op-${String(Date.now())}`;
    const step = { label: op.label, args, changes: op.changes };
    set({
      running: {
        id,
        resourceId: resource.id,
        label: op.label,
        command: opCommandOf(args, account),
        lines: [],
        code: null,
      },
    });
    // Listen before it starts: the first line can arrive before the invoke
    // promise settles, and a listener armed afterwards has already missed it.
    const off = await listen<{ id: string; line: string }>("exec:output", ({ payload }) => {
      if (payload.id !== id) return;
      set((state) =>
        state.running?.id === id
          ? { running: { ...state.running, lines: [...state.running.lines, payload.line] } }
          : {},
      );
    });
    try {
      // Checked again, filled in, right before it runs: what was proved was a
      // command with placeholders, and this is the command with a real name.
      await invoke("cloud_check_deploy", {
        cloudId,
        existing: true,
        plan: { steps: [step], keep: [], prove: null },
        removal: true,
      });
      const outcome = await invoke<{ code: number | null; cancelled: boolean }>("cloud_deploy_step", {
        id,
        request: {
          cloudId,
          account,
          existing: true,
          step,
          removal: true,
          cwd: useWorkspace.getState().rootPath ?? ".",
        },
      });
      set((state) =>
        state.running?.id === id ? { running: { ...state.running, code: outcome.code ?? -1 } } : {},
      );
    } catch (error: unknown) {
      set((state) =>
        state.running?.id === id
          ? { running: { ...state.running, lines: [...state.running.lines, String(error)], code: -1 } }
          : {},
      );
    } finally {
      off();
    }
  },

  stopOp: async () => {
    const running = get().running;
    if (running === null || running.code !== null) return;
    await invoke("exec_cancel", { id: running.id });
  },

  clearOp: () => {
    set({ running: null });
  },

  runRead: async (resource, read) => {
    const cloudId = get().tab;
    const account = get().selected[cloudId];
    if (account === undefined) return;
    const key = answerKey(resource, read);
    set((state) => ({ answers: { ...state.answers, [key]: { kind: "loading" } } }));
    try {
      const json = await invoke<string>("cloud_run_read", { cloudId, account, resource, read });
      set((state) => ({ answers: { ...state.answers, [key]: { kind: "loaded", json } } }));
    } catch (error: unknown) {
      const reason = String(error);
      set((state) => ({ answers: { ...state.answers, [key]: { kind: "failed", reason } } }));
      if (cliRefusal(reason) === "command") await repairAfterClick(resource, read, reason, get, set);
    }
  },

  replan: async (resource) => {
    const cloudId = get().tab;
    // A plan is checked against the CLI's grammar, not against the cloud, so a
    // command the CLI accepts and the service refuses would otherwise be this
    // kind's answer for good. The stored plan goes, this kind's plan state and
    // this resource's answers go with it, and the AI is asked afresh.
    await invoke("cloud_forget_plan", { cloudId, kind: resource.kind });
    set((state) => ({
      plans: { ...state.plans, [slotOf(cloudId, resource.kind)]: undefined },
      answers: Object.fromEntries(
        Object.entries(state.answers).filter(([key]) => !key.startsWith(`${resource.id}#`)),
      ),
    }));
    await planAndRead(resource, get, set);
  },

  signIn: async (cloudId, account) => {
    const progress = (next: SignInState | undefined) => {
      set((state) => ({ signIns: { ...state.signIns, [cloudId]: next } }));
    };
    if (!BROWSER_FREE_SIGN_IN.has(cloudId)) {
      // Keys typed at a prompt belong in a real shell, where Aime never sees
      // them, and the Supabase CLI refuses its browser flow outside a TTY - see
      // `cloud/sign_in.rs` and `cloud/supabase.rs`. The terminal says nothing
      // back, so the panel asks the CLI itself, every few seconds, whether the
      // sign-in has happened.
      runInTerminal(account.signIn, get().clouds.find((cloud) => cloud.id === cloudId)?.label);
      progress({ stage: "terminal" });
      const signedIn = await awaitTerminalSignIn(cloudId);
      progress(undefined);
      if (signedIn) await afterSignIn(cloudId, get, set);
      return;
    }
    progress({ stage: "starting" });
    // Listen BEFORE the CLI starts: an event with no listener yet is dropped,
    // and the code line can arrive within a second of the spawn.
    let unlisten: UnlistenFn | null = null;
    unlisten = await listen<SignInEvent>("cloud:sign-in", ({ payload }) => {
      if (payload.cloudId !== cloudId) return;
      if (payload.stage === "done") {
        progress({ stage: "done", ok: payload.ok, message: payload.message });
        unlisten?.();
        if (payload.ok) void afterSignIn(cloudId, get, set);
        return;
      }
      // Opened from Aime's own process, which is what puts the browser in
      // FRONT of the editor; opened by the CLI it landed behind.
      openUrl(payload.url).catch((error: unknown) => {
        console.warn("could not open the sign-in page:", error);
      });
      if (payload.stage === "code") {
        progress({ stage: "code", url: payload.url, code: payload.code });
        navigator.clipboard.writeText(payload.code).catch((error: unknown) => {
          console.warn("could not copy the device code:", error);
        });
      } else {
        progress({ stage: "page", url: payload.url });
      }
    });
    try {
      await invoke("cloud_sign_in", { cloudId, account });
    } catch (error: unknown) {
      unlisten();
      progress({ stage: "done", ok: false, message: String(error) });
    }
  },

  submitSignInCode: async (cloudId, code) => {
    const waiting = get().signIns[cloudId];
    if (waiting?.stage !== "page") return;
    try {
      await invoke("cloud_sign_in_code", { cloudId, code });
      set((state) => ({ signIns: { ...state.signIns, [cloudId]: { stage: "exchanging" } } }));
    } catch (error: unknown) {
      // The code was refused before it reached the CLI - a stray paste - so the
      // page is still the right place to be; the reason is shown beside it.
      set((state) => ({
        signIns: { ...state.signIns, [cloudId]: { ...waiting, rejected: String(error) } },
      }));
    }
  },

  cancelSignIn: async (cloudId) => {
    await invoke("cloud_sign_in_cancel", { cloudId });
    set((state) => ({ signIns: { ...state.signIns, [cloudId]: undefined } }));
  },

  watchSignIns: () => {
    // One watch for the life of the page: the panel mounts every time it is
    // opened, and a second listener would re-read every account twice.
    signInWatch ??= (async () => {
      // Listen BEFORE the watcher starts: an event with no listener is dropped.
      await listen<CredentialsChanged>("cloud:credentials-changed", ({ payload }) => {
        void onCredentialsChanged(payload.cloudId, get, set);
      });
      await invoke("cloud_watch_credentials");
    })();
    return signInWatch;
  },

  setDefaultAccount: async (cloudId, account) => {
    await invoke("cloud_set_account", { cloudId, account });
    // The CLI's idea of "current" just changed, so the list is dropped and
    // re-read rather than patched: which one is current is the CLI's answer,
    // not Aime's guess about what its own command did.
    set((state) => ({ accounts: { ...state.accounts, [cloudId]: undefined } }));
    await get().openTab(cloudId);
  },

  refresh: async () => {
    set({ probing: true });
    try {
      set({ clouds: await invoke<CloudStatus[]>("cloud_report"), ready: true });
    } catch (error: unknown) {
      // A probe that will not run is not four signed-out clouds. The rows keep
      // whatever they last knew and the panel stays honest about being unsure.
      console.warn("could not read the cloud report:", error);
      set({ ready: true });
    } finally {
      set({ probing: false });
    }
  },

  /**
   * Asks the AI what exists in one cloud, then writes it into the project's
   * memory file.
   *
   * Aime holds the two ends and the AI does the middle: the account comes from
   * a measured probe, the file is written by Aime, and only a reply that parses
   * into services, deployments or stated gaps is written at all. A model that
   * answered with prose leaves the memory exactly as it was - a note nobody can
   * trust is worse in that file than no note.
   */
  discover: async (id) => {
    const cloud = get().clouds.find((candidate) => candidate.id === id);
    const rootPath = useWorkspace.getState().rootPath;
    if (cloud === undefined || rootPath === null || get().discovering !== null) return;

    set({ discovering: id, result: null });
    try {
      const account = cloud.account ?? cloud.label;
      const asking = [
        DISCOVER_PROMPT,
        "",
        `The cloud: ${cloud.label}, through its own CLI (\`${cloud.command}\`) on this machine.`,
        `Signed in as: ${account}`,
      ].join("\n");
      const architecture = parseArchitecture(await aiOneshot(asking, rootPath));
      if (architecture === null) {
        set({ result: { cloud: cloud.label, wrote: false, detail: translate("cloud.noAnswer") } });
        return;
      }

      const notes = {
        ...get().notes,
        [id]: { label: cloud.label, account, architecture, discoveredAt: Date.now() },
      };
      set({ notes });
      const wrote = await writeMemory(rootPath, notes);
      set({
        result: {
          cloud: cloud.label,
          wrote,
          detail: wrote
            ? translate("cloud.wrote", {
                services: architecture.services.length,
                gaps: architecture.gaps.length,
              })
            : translate("cloud.memoryFailed"),
        },
      });
    } catch (error: unknown) {
      set({ result: { cloud: cloud.label, wrote: false, detail: String(error) } });
    } finally {
      set({ discovering: null });
    }
  },
}));

type Get = () => CloudState;
type Set = (partial: Partial<CloudState> | ((state: CloudState) => Partial<CloudState>)) => void;

/**
 * The plan for a resource's kind, then the reads that are safe to run unasked.
 *
 * Planning happens once per kind per machine: the plan is on disk after the
 * first time (`cloud_read_plan`), and in this store after the first time this
 * session. Only the first resource of a kind ever waits for the AI. The
 * `secret` reads are never started here - a person asks for those by name.
 */
async function planAndRead(resource: CloudResource, get: Get, set: Set): Promise<void> {
  const cloudId = get().tab;
  const plan = await ensurePlan(cloudId, resource, get, set);
  if (plan === null || get().detail?.id !== resource.id) return;
  for (const read of plan.reads) {
    if (read.purpose === "secret") continue;
    if (get().answers[answerKey(resource, read)] !== undefined) continue;
    void get().runRead(resource, read);
  }
}

async function ensurePlan(
  cloudId: string,
  resource: CloudResource,
  get: Get,
  set: Set,
): Promise<ReadPlan | null> {
  const key = slotOf(cloudId, resource.kind);
  const known = get().plans[key];
  if (known?.kind === "ready") return { reads: known.reads, facts: known.facts, rejected: known.rejected };
  if (known?.kind === "planning") return null;
  if (!isPlannable(cloudId)) {
    setPlan(set, key, { kind: "failed", reason: translate("cloud.readsNoCloud") });
    return null;
  }
  const account = get().selected[cloudId];
  if (account === undefined) return null;
  setPlan(set, key, { kind: "planning" });
  try {
    const stored = await invoke<StoredPlan | null>("cloud_read_plan", { cloudId, kind: resource.kind });
    const checked = stored === null ? await planWithAi(cloudId, resource) : { ...stored, rejected: [] };
    // A plan that has already answered on a real resource is taken as it is;
    // one off an older build, or one whose trial run hit a wall rather than an
    // answer, is proved now - which costs one CLI call per read and nothing
    // from the AI unless a read actually fails.
    const plan =
      stored?.proved === true ? checked : await proveAndStore(cloudId, resource, account, checked, set);
    setPlan(set, key, { kind: "ready", reads: plan.reads, facts: plan.facts, rejected: plan.rejected });
    return plan;
  } catch (error: unknown) {
    setPlan(set, key, { kind: "failed", reason: String(error) });
    return null;
  }
}

/**
 * Asks the AI for the reads of one kind and has Aime check them.
 *
 * The AI is given the kind, the shape of its identifier with the account and
 * the name taken out, and - for AWS - the CLI's own catalogue of that service's
 * reads. It is never given a real resource. Whatever it answers goes through
 * `cloud_check_reads`, which keeps only what the CLI on this machine can run
 * and says why the rest was refused.
 */
async function planWithAi(cloudId: PlannableCloud, resource: CloudResource): Promise<ReadPlan> {
  const catalog =
    cloudId === "aws"
      ? await invoke<AwsCatalog | null>("cloud_read_catalog", { resourceId: resource.id })
      : null;
  const prompt = buildReadPlanPrompt(cloudId, resource.kind, resource.id, catalog);
  // The plan is about a kind of cloud resource, not about the project, so the
  // repository is only the working directory the CLI has to be given.
  const cwd = useWorkspace.getState().rootPath ?? ".";
  const { reads: proposed, facts } = parseReadPlan(await aiOneshot(prompt, cwd, true));
  return invoke<ReadPlan>("cloud_check_reads", { cloudId, kind: resource.kind, proposed, facts });
}

/** How many times a failing read is handed back to the AI with the CLI's words. */
const REPAIR_ROUNDS = 2;

/**
 * Runs each planned read once against the resource in hand, fixes what fails,
 * and stores what is left.
 *
 * This is the loop a developer does at a terminal - run it, read the error,
 * fix the command, run it again - and it exists because a plan is stored per
 * KIND: before this, a command the CLI HAS but that cannot address the
 * resource became that kind's answer on this machine for good. Measured
 * 2026-09-11 over a real Google account, that was 15 service accounts and 26
 * log buckets answering nothing but an error, from two commands that passed
 * every check Aime had.
 *
 * A refusal that is not the command's fault - an API switched off, no billing,
 * a sign-in that lapsed - is not handed to the AI: the CLI refuses the right
 * command with the same sentence, so there is nothing to fix and a rewrite
 * would cost a turn to arrive back where it started. That read is kept, its
 * answer is the wall itself so the panel can offer the fix, and the plan is
 * written down as unproved so the next open tries again.
 */
async function proveAndStore(
  cloudId: PlannableCloud,
  resource: CloudResource,
  account: string,
  plan: ReadPlan,
  set: Set,
): Promise<ReadPlan> {
  const kept: PlannedRead[] = [];
  const rejected: RejectedRead[] = [...plan.rejected];
  let candidates = plan.reads;
  let facts = plan.facts;
  let proved = true;
  // A command Aime refused after reading the CLI's help is as fixable as one
  // that failed when it ran, and its reason quotes the synopsis that says how:
  // measured, `iam service-accounts keys list <name>` was refused for leaving
  // out `--iam-account`, and dropping it silently cost the kind the one read a
  // developer opens it for.
  let unusable: FailedRead[] = plan.rejected.flatMap((entry) =>
    entry.command === null ? [] : [{ read: entry.command, reason: entry.reason }],
  );
  for (let round = 0; candidates.length > 0 || unusable.length > 0; round++) {
    for (const read of candidates) {
      const refusal = await prove(cloudId, account, resource, read, set);
      if (refusal === null) {
        kept.push(read);
      } else if (cliRefusal(refusal) === "wall") {
        kept.push(read);
        proved = false;
      } else {
        rejected.push({ label: read.label, reason: shortCliError(refusal), command: read });
        unusable.push({ read, reason: withPlaceholders(shortCliError(refusal), resource) });
      }
    }
    if (unusable.length === 0 || round >= REPAIR_ROUNDS) break;
    const repaired = await repairWithAi(cloudId, resource.kind, unusable, rejected);
    candidates = repaired.reads;
    // Facts come from the same answer the broken reads came from, so a kind
    // whose reads had to be rewritten gets the chance to correct them too -
    // measured 2026-09-11 in the app, the plan on this machine still held
    // `<name>@<group>.iam.gserviceaccount.com` for a service account whose
    // `<name>` IS its email. Silence keeps what Aime already has.
    facts = repaired.facts.length > 0 ? repaired.facts : facts;
    unusable = [];
  }
  // What is stored is what comes back, not what went in: a kind left with no
  // overview - because the CLI has no such command, or because the one the AI
  // wrote was thrown out above - gains Aime's own there (`reads.rs:
  // own_overview`), and the panel has to show the plan the file now holds.
  const stored = await invoke<PlannedRead[]>("cloud_store_plan", {
    cloudId,
    kind: resource.kind,
    reads: latestOfEachLabel(kept),
    facts,
    proved,
  });
  return { reads: stored, facts, rejected };
}

/**
 * One read tried for real: null when it answered, the CLI's own words when it
 * did not.
 *
 * The answer is kept, so the panel shows what the trial run already fetched
 * instead of running the same command a second time; a `secret` read is never
 * run here and answers nothing (`cloud_prove_read`).
 */
async function prove(
  cloudId: string,
  account: string,
  resource: CloudResource,
  read: PlannedRead,
  set: Set,
): Promise<string | null> {
  const key = answerKey(resource, read);
  try {
    const json = await invoke<string | null>("cloud_prove_read", { cloudId, account, resource, read });
    if (json !== null) set((state) => ({ answers: { ...state.answers, [key]: { kind: "loaded", json } } }));
    return null;
  } catch (error: unknown) {
    const reason = String(error);
    set((state) => ({ answers: { ...state.answers, [key]: { kind: "failed", reason } } }));
    return reason;
  }
}

/**
 * The kinds a repair is already running for, so a fix that fails does not ask
 * for another one on its way out.
 */
const repairing = new Set<string>();

/**
 * A read that failed when a person asked for it, fixed on the spot and run
 * again.
 *
 * `secret` reads are why this exists. They are never run to prove a plan - a
 * credential is fetched when somebody asks for it and not a moment before - so
 * the first time one ever runs is the click, and a command that cannot address
 * the resource would otherwise stay wrong for every resource of the kind.
 * Measured 2026-09-11 on this machine's stored plan: `iam service-accounts keys
 * list --iam-account <path>` answered 404 for all fifteen service accounts.
 * The click is also the consent, so the repaired command runs straight away -
 * it is the read that was asked for.
 */
async function repairAfterClick(
  resource: CloudResource,
  failed: PlannedRead,
  reason: string,
  get: Get,
  set: Set,
): Promise<void> {
  const cloudId = get().tab;
  const account = get().selected[cloudId];
  const key = slotOf(cloudId, resource.kind);
  const known = get().plans[key];
  if (!isPlannable(cloudId) || account === undefined || known?.kind !== "ready") return;
  if (repairing.has(key)) return;
  repairing.add(key);
  try {
    const rejected: RejectedRead[] = [
      ...known.rejected,
      { label: failed.label, reason: shortCliError(reason), command: failed },
    ];
    const failure = { read: failed, reason: withPlaceholders(shortCliError(reason), resource) };
    const repaired = await repairWithAi(cloudId, resource.kind, [failure], rejected);
    if (repaired.reads.length === 0) {
      setPlan(set, key, { kind: "ready", reads: known.reads, facts: known.facts, rejected });
      return;
    }
    const reads = latestOfEachLabel([
      ...known.reads.filter((read) => read.args.join(" ") !== failed.args.join(" ")),
      ...repaired.reads,
    ]);
    const facts = repaired.facts.length > 0 ? repaired.facts : known.facts;
    // Unproved: what replaced a `secret` read cannot be proved by running it
    // either, and the run that matters is the one about to happen.
    const stored = await invoke<PlannedRead[]>("cloud_store_plan", {
      cloudId,
      kind: resource.kind,
      reads,
      facts,
      proved: false,
    });
    setPlan(set, key, { kind: "ready", reads: stored, facts, rejected });
    for (const read of repaired.reads.filter((candidate) => candidate.purpose === failed.purpose)) {
      await get().runRead(resource, read);
    }
  } finally {
    repairing.delete(key);
  }
}

/**
 * One read per heading, the last one winning.
 *
 * A repaired read replaces the one it was written for, and the pair is told
 * apart by the label, which is the command in the CLI's own words and what the
 * panel shows as the heading. Measured in the app 2026-09-11: without this, a
 * service account's plan came out holding both `keys list --iam-account
 * <path>`, which cannot run, and the `<name>` that replaced it - two rows with
 * one heading, one of them broken.
 */
function latestOfEachLabel(reads: PlannedRead[]): PlannedRead[] {
  const byLabel = new Map<string, PlannedRead>();
  for (const read of reads) byLabel.set(read.label, read);
  return [...byLabel.values()];
}

/** The corrected reads, checked again - the AI sees the errors, never the resource. */
async function repairWithAi(
  cloudId: PlannableCloud,
  kind: string,
  failures: FailedRead[],
  rejected: RejectedRead[],
): Promise<{ reads: PlannedRead[]; facts: ConnectionFact[] }> {
  const cwd = useWorkspace.getState().rootPath ?? ".";
  const reply = await aiOneshot(buildReadRepairPrompt(cloudId, kind, failures), cwd, true);
  const { reads: proposed, facts } = parseReadPlan(reply);
  const tried = new Set(failures.map((failure) => failure.read.args.join(" ")));
  const fresh = proposed.filter((read) => !tried.has(read.args.join(" ")));
  const checked = await invoke<ReadPlan>("cloud_check_reads", { cloudId, kind, proposed: fresh, facts });
  rejected.push(...checked.rejected);
  return { reads: checked.reads, facts: checked.facts };
}

/** How much of an unreadable answer is shown, so the panel says something useful. */
const REPLY_SHOWN = 400;

/** The one cloud whose whole commands Aime can prove today (`cloud/deploy.rs`). */
const OPERABLE = "gcp";

/** An operation in the shape the deploy checker reads. */
function asStep(op: ProposedOp): { label: string; args: string[]; changes: string } {
  return { label: op.label, args: op.args, changes: op.changes };
}

/** The operations the checker kept, matched back to what the AI proposed. */
function keptOps(proposed: ProposedOp[], checked: { steps: unknown }): ProposedOp[] {
  const kept = checked.steps as { label: string }[];
  const labels = new Set(kept.map((step) => step.label));
  return proposed.filter((op) => labels.has(op.label));
}

/** What the checker refused, in its own words - shown, never hidden. */
function rejectedOps(checked: unknown): { label: string; reason: string }[] {
  const { rejected } = checked as { rejected?: { label?: string; reason?: string }[] };
  return (rejected ?? []).map((entry) => ({ label: entry.label ?? "", reason: entry.reason ?? "" }));
}

/** The command line as Aime will run it, for the confirm and for the log. */
function opCommandOf(args: string[], account: CloudAccount): string {
  return ["gcloud", ...args, "--project", account.id, "--account", account.owner].join(" ");
}

function setOps(set: Set, key: string, state: OpsState): void {
  set((current) => ({ ops: { ...current.ops, [key]: state } }));
}

function setPlan(set: Set, key: string, state: PlanState): void {
  set((current) => ({ plans: { ...current.plans, [key]: state } }));
}

/** How often, and for how long, the panel asks a CLI whether a terminal sign-in has happened. */
const TERMINAL_SIGN_IN_POLL_MS = 5_000;
const TERMINAL_SIGN_IN_ATTEMPTS = 36;

/**
 * Waits for a sign-in that runs in a terminal tab, by asking that cloud's CLI.
 *
 * The file watcher (`cloud/credentials.rs`) covers the CLIs that leave a file
 * behind; Supabase keeps its token in the OS keyring and leaves none, so the
 * one signal left is the CLI's own answer. One probe of one cloud every five
 * seconds for three minutes, then the panel stops asking - a person who gave
 * up in the terminal should not leave a probe running all afternoon.
 */
async function awaitTerminalSignIn(cloudId: string): Promise<boolean> {
  for (let attempt = 0; attempt < TERMINAL_SIGN_IN_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_SIGN_IN_POLL_MS));
    const status = await invoke<CloudStatus | null>("cloud_status", { cloudId });
    if (status?.signedIn === true) return true;
  }
  return false;
}

/** The one subscription to the CLIs' sign-in files, made on the first panel open. */
let signInWatch: Promise<void> | null = null;

/** The account listing in flight per cloud, so two opens of a tab make one call. */
const listingAccounts = new Map<string, Promise<void>>();

/**
 * The re-read in flight per cloud. A sign-in is announced twice - by the file
 * the CLI writes and, for Aime's own device-code flow, by the CLI exiting - and
 * both announcements must land on ONE re-read, not two rounds of cloud calls.
 */
const reReading = new Map<string, Promise<void>>();

/**
 * The CLI of one cloud just rewrote what a sign-in writes (cloud/credentials.rs).
 *
 * Only a cloud that was waiting for a sign-in is re-read. The same file is
 * rewritten when a token is silently refreshed in the middle of a listing, and
 * re-reading a healthy account on every one of those is exactly the traffic
 * this store exists to avoid.
 */
async function onCredentialsChanged(cloudId: string, get: Get, set: Set): Promise<void> {
  // A state directory that did not exist a moment ago (the first sign-in on a
  // fresh machine) is now there to be watched itself.
  await invoke("cloud_watch_credentials");
  if (!waitingForSignIn(cloudId, get())) return;
  await afterSignIn(cloudId, get, set);
}

/**
 * Whether anything shown for a cloud is still the signed-out answer: its probe,
 * an empty account list, or a listing the CLI refused.
 */
export function waitingForSignIn(
  cloudId: string,
  state: Pick<CloudState, "clouds" | "accounts" | "resources">,
): boolean {
  const probe = state.clouds.find((cloud) => cloud.id === cloudId);
  return (
    probe?.signedIn !== true ||
    state.accounts[cloudId]?.length === 0 ||
    failedListings(cloudId, state).length > 0
  );
}

/** The accounts of one cloud whose listing the CLI refused. */
function failedListings(cloudId: string, state: Pick<CloudState, "resources">): string[] {
  return Object.entries(state.resources)
    .filter(([slot, listing]) => slot.startsWith(`${cloudId}/`) && listing?.kind === "failed")
    .map(([slot]) => slot.slice(cloudId.length + 1));
}

/**
 * What a fresh token changes: the probe that colours the cloud's tab, the
 * accounts the CLI holds, and every listing that failed for want of one.
 * Listings that succeeded are left alone - a sign-in does not change what is
 * deployed. Coalesced per cloud, see `reReading`.
 */
function afterSignIn(cloudId: string, get: Get, set: Set): Promise<void> {
  const inFlight = reReading.get(cloudId);
  if (inFlight !== undefined) return inFlight;
  const run = (async () => {
    try {
      await get().refresh();
      set((state) => ({ accounts: { ...state.accounts, [cloudId]: undefined } }));
      await get().openTab(cloudId);
      await Promise.all(failedListings(cloudId, get()).map((accountId) => get().reload(cloudId, accountId)));
    } finally {
      reReading.delete(cloudId);
    }
  })();
  reReading.set(cloudId, run);
  return run;
}

/**
 * Rewrites the managed section of the project's memory file.
 *
 * Read, splice, write - rather than append - so a second discovery replaces the
 * first and a person's own notes in that file are never touched. Claude's
 * pointer file is refreshed the same way `MemoryModal` does it, or the note
 * would be invisible to whichever CLI the reader switches to next.
 */
async function writeMemory(rootPath: string, notes: Record<string, CloudNote>): Promise<boolean> {
  try {
    // `project_memory_paths`, not `memory_paths`: the latter resolves a global
    // path through the selected provider's adapter and fails outright for a CLI
    // the user added themselves, which would have made this feature quietly
    // write nothing for exactly those users.
    const paths = await invoke<MemoryPaths>("project_memory_paths", { rootPath });
    if (paths.projectPath === null) return false;
    const existing = await invoke<string>("read_file", { path: paths.projectPath }).catch(() => "");
    const section = renderCloudNote(Object.values(notes));
    await invoke("write_file", {
      path: paths.projectPath,
      content: spliceCloudNote(existing, section),
    });
    await invoke("ensure_memory_bridge", { rootPath });
    return true;
  } catch (error: unknown) {
    console.warn("could not write the cloud note into the project memory:", error);
    return false;
  }
}
