import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { translate } from "../i18n";
import { aiOneshot } from "../lib/aiOneshot";
import { DISCOVER_PROMPT, parseArchitecture } from "../lib/cloudDiscovery";
import type { Basis } from "../lib/cloudMap";
import { renderCloudNote, spliceCloudNote, type CloudNote } from "../lib/cloudMemory";
import {
  buildReadPlanPrompt,
  parseReadPlan,
  type AwsCatalog,
  type PlannableCloud,
  type PlannedRead,
  type ReadPlan,
  type RejectedRead,
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
  | { kind: "ready"; reads: PlannedRead[]; rejected: RejectedRead[] }
  | { kind: "failed"; reason: string };

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
  /** Sign-ins in flight or just finished, per cloud. */
  signIns: Record<string, SignInState | undefined>;

  refresh: () => Promise<void>;
  discover: (id: string) => Promise<void>;
  /** Shows one cloud's tab, reading its accounts the first time. */
  openTab: (id: string) => Promise<void>;
  /** Selects an account and loads its resources if they are not in hand. */
  selectAccount: (cloudId: string, accountId: string) => Promise<void>;
  /** Fetches an account's resources again, after a sign-in or a change. */
  reload: (cloudId: string, accountId: string) => Promise<void>;
  setView: (slot: string, view: CloudViewMode) => void;
  setBasis: (slot: string, basis: Basis) => void;
  /** Opens a resource, plans its kind's reads if needed, and runs the safe ones. */
  openDetail: (resource: CloudResource | null) => void;
  /** Runs one planned read against one resource - the only way a secret is read. */
  runRead: (resource: CloudResource, read: PlannedRead) => Promise<void>;
  /** Forgets the plan for a resource's kind and asks the AI again, for this resource first. */
  replan: (resource: CloudResource) => Promise<void>;
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

export const useCloud = create<CloudState>((set, get) => ({
  clouds: [],
  ready: false,
  probing: false,
  discovering: null,
  result: null,
  notes: {},
  accounts: {},
  tab: "azure",
  selected: {},
  resources: {},
  view: {},
  basis: {},
  detail: null,
  plans: {},
  answers: {},
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
      set((state) => ({ answers: { ...state.answers, [key]: { kind: "failed", reason: String(error) } } }));
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
  if (known?.kind === "ready") return { reads: known.reads, rejected: known.rejected };
  if (known?.kind === "planning") return null;
  if (!isPlannable(cloudId)) {
    setPlan(set, key, { kind: "failed", reason: translate("cloud.readsNoCloud") });
    return null;
  }
  setPlan(set, key, { kind: "planning" });
  try {
    const stored = await invoke<PlannedRead[] | null>("cloud_read_plan", { cloudId, kind: resource.kind });
    const plan = stored === null ? await planWithAi(cloudId, resource) : { reads: stored, rejected: [] };
    setPlan(set, key, { kind: "ready", reads: plan.reads, rejected: plan.rejected });
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
  const proposed = parseReadPlan(await aiOneshot(prompt, cwd, true));
  return invoke<ReadPlan>("cloud_check_reads", { cloudId, kind: resource.kind, proposed });
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
