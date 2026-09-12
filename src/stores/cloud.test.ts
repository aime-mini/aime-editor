import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionFact, PlannedRead, RejectedRead } from "../lib/cloudReads";
import type { CloudAccount, CloudStatus } from "./cloud";

/**
 * A sign-in the CLI performed has to reach the panel by itself. Reported
 * 2026-09-04: `az login` and `aws configure` both said they had succeeded, and
 * the panel kept its red dot and its failed listing until "Try again" was
 * clicked by hand. The Rust side now reports the CLI rewriting its own files
 * as `cloud:credentials-changed`; these tests pin what the store does with it.
 */

/** Every Tauri command called, in order, so a test can count cloud calls. */
const commands: string[] = [];
/** What `cloud_report` answers for Azure; tests flip it as the CLI would. */
let azureSignedIn = false;
/** Whether `cloud_resources` for Azure succeeds; false is the expired-token answer. */
let azureListingWorks = false;
/** What `cloud_status` answers for Supabase while a terminal sign-in runs. */
let supabaseSignedIn = false;
/** The `cloud:credentials-changed` listener, captured when the store subscribes. */
let onCredentials: ((event: { payload: unknown }) => void) | null = null;
/** The `cloud:sign-in` listener, captured when a device-code sign-in starts. */
let onSignIn: ((event: { payload: unknown }) => void) | null = null;
/** What `cloud_read_plan` finds on disk for the kind under test. */
let planOnDisk: unknown = null;
/** What each `cloud_check_reads` call keeps, in the order they are made. */
let checked: PlannedRead[][] = [];
/** Whole answers from `cloud_check_reads`, when a test needs the refusals too. */
let checkedPlans: { reads: PlannedRead[]; facts: ConnectionFact[]; rejected: RejectedRead[] }[] = [];
/** What each `cloud_prove_read` call does: a string is the CLI refusing. */
let proofs: (string | null)[] = [];
/** What each `cloud_run_read` call does: a string is the CLI refusing. */
let runs: (string | null)[] = [];
/** Every plan written to disk, so a test can see what survived and whether it was proved. */
const written: { reads: PlannedRead[]; facts: unknown[]; proved: boolean }[] = [];
/** What `cloud_store_plan` answers, for a test where the file differs from what was sent. */
let storedReads: PlannedRead[] | null = null;
/** What the AI answers, one reply per call. */
let replies: string[] = [];
/** How many times the AI was asked anything. */
let asked = 0;

const azure: CloudStatus = {
  id: "azure",
  label: "Azure",
  command: "az",
  installed: true,
  version: "2.90.0",
  path: null,
  signedIn: false,
  account: null,
  signInHint: "az login --use-device-code",
  installHint: "",
  installable: false,
};

const subscription: CloudAccount = {
  id: "sub-1",
  label: "Stub Sub",
  detail: "Stub Tenant",
  current: true,
  owner: "stub@example.com",
  tenant: "tenant-1",
  signIn: "az login --use-device-code --tenant tenant-1",
};

const EXPIRED =
  'Interactive authentication is needed. Please run:\naz login --tenant "tenant-1"\nStatus_InteractionRequired';

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => {
    commands.push(command);
    switch (command) {
      case "cloud_read_plan":
        return Promise.resolve(planOnDisk);
      case "cloud_check_reads":
        return Promise.resolve(
          checkedPlans.shift() ?? { reads: checked.shift() ?? [], facts: [], rejected: [] },
        );
      case "cloud_prove_read": {
        const refusal = proofs.shift() ?? null;
        // Tauri rejects with the string a command returned as its error, not
        // with an Error - what the store reads is the CLI's own sentence, and a
        // mock that wrapped it would be testing a message Aime never sees.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return refusal === null ? Promise.resolve('{"ok":true}') : Promise.reject(refusal);
      }
      case "cloud_run_read": {
        const refusal = runs.shift() ?? null;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return refusal === null ? Promise.resolve('{"keys":[]}') : Promise.reject(refusal);
      }
      case "cloud_store_plan": {
        const plan = args as unknown as { reads: PlannedRead[]; facts: unknown[]; proved: boolean };
        written.push(plan);
        // The real command answers the plan it wrote, which is not always the
        // plan it was given: see `reads.rs: own_overview`.
        return Promise.resolve(storedReads ?? plan.reads);
      }
      case "cloud_report":
        return Promise.resolve([{ ...azure, signedIn: azureSignedIn }]);
      case "cloud_status":
        return Promise.resolve({ ...azure, id: "supabase", signedIn: supabaseSignedIn });
      case "cloud_accounts":
        return Promise.resolve([subscription]);
      case "cloud_resources":
        return azureListingWorks
          ? Promise.resolve({ resources: [], truncated: false })
          : Promise.reject(new Error(EXPIRED));
      default:
        return Promise.resolve(undefined);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    if (event === "cloud:credentials-changed") onCredentials = handler;
    if (event === "cloud:sign-in") onSignIn = handler;
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: () => Promise.resolve("C:\\app-data") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));
vi.mock("../lib/aiOneshot", () => ({
  aiOneshot: () => {
    asked++;
    return Promise.resolve(replies.shift() ?? "");
  },
}));
vi.mock("./terminals", () => ({ runInTerminal: () => undefined }));

const { useCloud, visibleClouds, readShownClouds, waitingForSignIn } = await import("./cloud");

/** Lets every settled promise chain run out before the test looks at state. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Opens the panel on Azure the way a person does: probe, accounts, first listing. */
async function openAzureWithAnExpiredToken(): Promise<void> {
  azureSignedIn = false;
  azureListingWorks = false;
  await useCloud.getState().refresh();
  await useCloud.getState().watchSignIns();
  await useCloud.getState().openTab("azure");
  expect(useCloud.getState().resources["azure/sub-1"]).toEqual({
    kind: "failed",
    reason: `Error: ${EXPIRED}`,
  });
  commands.length = 0;
}

/** The CLI signs in: its probe turns green and its listing starts working. */
function theCliSignsIn(): void {
  azureSignedIn = true;
  azureListingWorks = true;
}

describe("waitingForSignIn", () => {
  it("is the signed-out probe, an empty account list, or a refused listing", () => {
    const healthy = {
      clouds: [{ ...azure, signedIn: true }],
      accounts: { azure: [subscription] },
      resources: { "azure/sub-1": { kind: "loaded" as const, resources: [], truncated: false, readAt: 0 } },
    };
    expect(waitingForSignIn("azure", healthy)).toBe(false);
    expect(waitingForSignIn("azure", { ...healthy, clouds: [azure] })).toBe(true);
    expect(waitingForSignIn("azure", { ...healthy, accounts: { azure: [] } })).toBe(true);
    expect(
      waitingForSignIn("azure", {
        ...healthy,
        resources: { "azure/sub-1": { kind: "failed", reason: EXPIRED } },
      }),
    ).toBe(true);
    // Another cloud's failure is not this cloud's wait.
    expect(
      waitingForSignIn("azure", { ...healthy, resources: { "aws/default": { kind: "failed", reason: "" } } }),
    ).toBe(false);
  });
});

describe("a sign-in the CLI recorded", () => {
  beforeEach(async () => {
    useCloud.setState({ clouds: [], ready: false, accounts: {}, selected: {}, resources: {}, signIns: {} });
    await openAzureWithAnExpiredToken();
  });

  it("re-probes the cloud, re-reads its accounts and retries the refused listing", async () => {
    theCliSignsIn();
    onCredentials?.({ payload: { cloudId: "azure" } });
    await settle();

    const state = useCloud.getState();
    expect(state.clouds[0]?.signedIn).toBe(true);
    expect(state.resources["azure/sub-1"]?.kind).toBe("loaded");
    expect(commands.filter((c) => c === "cloud_report")).toHaveLength(1);
    expect(commands.filter((c) => c === "cloud_accounts")).toHaveLength(1);
    expect(commands.filter((c) => c === "cloud_resources")).toHaveLength(1);
  });

  /**
   * A sign-in that runs in a terminal tab leaves the panel nothing to listen
   * to (Supabase keeps its token in the keyring), so the panel asks the CLI
   * itself until it says yes, then reads the cloud again.
   */
  it("asks after a terminal sign-in until the CLI says yes, then re-reads the cloud", async () => {
    vi.useFakeTimers();
    try {
      const supabase: CloudStatus = { ...azure, id: "supabase", label: "Supabase", command: "supabase" };
      useCloud.setState({ clouds: [supabase], accounts: { supabase: [] }, resources: {}, signIns: {} });
      const project: CloudAccount = {
        ...subscription,
        id: "ref-1",
        owner: "Acme",
        tenant: "",
        signIn: "supabase login",
      };
      commands.length = 0;
      supabaseSignedIn = false;
      const done = useCloud.getState().signIn("supabase", project);
      expect(useCloud.getState().signIns.supabase).toEqual({ stage: "terminal" });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(commands.filter((c) => c === "cloud_status")).toHaveLength(1);
      supabaseSignedIn = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await done;

      expect(useCloud.getState().signIns.supabase).toBeUndefined();
      expect(commands.filter((c) => c === "cloud_status")).toHaveLength(2);
      expect(commands.filter((c) => c === "cloud_report")).toHaveLength(1);
      expect(commands.filter((c) => c === "cloud_accounts")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A plan the CLI accepted and the cloud refused (`gcloud projects describe
   * <path>`, INVALID_ARGUMENT) must not be this kind's answer for good.
   */
  it("forgets a kind's plan and this resource's answers when asked to plan again", async () => {
    const project = {
      id: "//cloudresourcemanager.googleapis.com/projects/p1",
      name: "P1",
      cliName: "p1",
      kind: "cloudresourcemanager.googleapis.com/Project",
      location: "global",
      group: "p1",
      tags: {},
    };
    const read = {
      purpose: "overview" as const,
      label: "gcloud projects describe",
      args: ["projects", "describe"],
    };
    useCloud.setState({
      tab: "gcp",
      selected: { gcp: "p1" },
      plans: {
        "gcp/cloudresourcemanager.googleapis.com/Project": {
          kind: "ready",
          reads: [read],
          facts: [],
          rejected: [],
        },
      },
      answers: {
        [`${project.id}#${read.label}`]: { kind: "failed", reason: "INVALID_ARGUMENT" },
        "other#read": { kind: "loaded", json: "{}" },
      },
    });
    commands.length = 0;
    await useCloud.getState().replan(project);
    await settle();

    expect(commands[0]).toBe("cloud_forget_plan");
    expect(commands).toContain("cloud_read_plan");
    expect(useCloud.getState().answers[`${project.id}#${read.label}`]).toBeUndefined();
    expect(useCloud.getState().answers["other#read"]).toEqual({ kind: "loaded", json: "{}" });
  });

  it("says it is probing for as long as the CLIs are being asked", async () => {
    const running = useCloud.getState().refresh();
    expect(useCloud.getState().probing).toBe(true);
    await running;
    expect(useCloud.getState().probing).toBe(false);
  });

  it("lists a cloud's accounts once when its tab is opened twice at the same time", async () => {
    useCloud.setState({ accounts: {}, selected: {}, resources: {} });
    commands.length = 0;
    // The click and the effect that follows the tab, before either has an answer.
    await Promise.all([useCloud.getState().openTab("azure"), useCloud.getState().openTab("azure")]);
    expect(commands.filter((c) => c === "cloud_accounts")).toHaveLength(1);
    expect(useCloud.getState().accounts.azure).toEqual([subscription]);
  });

  it("leaves a healthy cloud alone when its token is merely refreshed", async () => {
    theCliSignsIn();
    onCredentials?.({ payload: { cloudId: "azure" } });
    await settle();
    commands.length = 0;

    onCredentials?.({ payload: { cloudId: "azure" } });
    await settle();
    // The watcher is re-armed (a directory may have appeared), nothing else runs.
    expect(commands).toEqual(["cloud_watch_credentials"]);
  });

  /**
   * Google's flow runs the other way round from Azure's: the CLI prints its
   * page, the page shows a code after consent, and the code is pasted back to
   * the CLI - so the store has a "page" stage with a box, and the code goes to
   * `cloud_sign_in_code` and nowhere else.
   */
  it("shows a box for Google's verification code and hands it to the CLI", async () => {
    const project: CloudAccount = {
      id: "shop-prod-1234",
      label: "Shop Production",
      detail: "shop-prod-1234",
      current: true,
      owner: "dev@example.com",
      tenant: "",
      signIn: "gcloud auth login dev@example.com --no-launch-browser",
    };
    await useCloud.getState().signIn("gcp", project);
    onSignIn?.({
      payload: { stage: "page", cloudId: "gcp", url: "https://accounts.google.com/o/oauth2/auth?x" },
    });
    await settle();
    expect(useCloud.getState().signIns.gcp).toEqual({
      stage: "page",
      url: "https://accounts.google.com/o/oauth2/auth?x",
    });

    commands.length = 0;
    await useCloud.getState().submitSignInCode("gcp", "4/0AX4XfWh-code");
    expect(commands).toEqual(["cloud_sign_in_code"]);
    expect(useCloud.getState().signIns.gcp).toEqual({ stage: "exchanging" });

    // A code submitted when no page is waiting goes nowhere.
    commands.length = 0;
    await useCloud.getState().submitSignInCode("gcp", "again");
    expect(commands).toEqual([]);
  });

  it("is one round of cloud calls even when Aime's own device-code flow reports it too", async () => {
    await useCloud.getState().signIn("azure", subscription);
    theCliSignsIn();
    // The token cache is written before the CLI exits, so the file is first.
    onCredentials?.({ payload: { cloudId: "azure" } });
    onSignIn?.({ payload: { stage: "done", cloudId: "azure", ok: true, message: "" } });
    await settle();

    expect(useCloud.getState().resources["azure/sub-1"]?.kind).toBe("loaded");
    expect(commands.filter((c) => c === "cloud_report")).toHaveLength(1);
    expect(commands.filter((c) => c === "cloud_resources")).toHaveLength(1);
  });
});

/**
 * Four tabs for a person who uses one cloud is three tabs of somebody else's
 * cloud (asked for 2026-09-09). The choice is the user's, it survives a
 * restart, and closing a tab must not throw away what was read from it.
 */
describe("which clouds get a tab", () => {
  const aws: CloudStatus = { ...azure, id: "aws", label: "AWS", command: "aws" };
  const gcp: CloudStatus = { ...azure, id: "gcp", label: "Google Cloud", command: "gcloud" };
  const all = [azure, aws, gcp];

  beforeEach(() => {
    localStorage.removeItem("aime.cloud.shown");
    useCloud.setState({ clouds: all, shown: null, picking: false, tab: "azure", detail: null });
  });

  it("shows every cloud until the user has answered, and only the chosen ones after", () => {
    expect(visibleClouds(all, null).map((cloud) => cloud.id)).toEqual(["azure", "aws", "gcp"]);
    expect(visibleClouds(all, ["gcp"]).map((cloud) => cloud.id)).toEqual(["gcp"]);
    // The strip keeps the probe's order, not the order they were ticked in.
    expect(visibleClouds(all, ["gcp", "azure"]).map((cloud) => cloud.id)).toEqual(["azure", "gcp"]);
  });

  it("remembers the choice for next time, and moves off a tab that is gone", () => {
    useCloud.getState().chooseClouds(["gcp"]);

    const state = useCloud.getState();
    expect(state.shown).toEqual(["gcp"]);
    expect(state.tab).toBe("gcp");
    expect(state.picking).toBe(false);
    expect(readShownClouds()).toEqual(["gcp"]);
  });

  it("keeps the tab in front when it survives the choice", () => {
    useCloud.setState({ tab: "aws", detail: null });
    useCloud.getState().chooseClouds(["aws", "gcp"]);
    expect(useCloud.getState().tab).toBe("aws");
  });

  it("closes one tab without forgetting what was read from that cloud", () => {
    useCloud.setState({
      resources: { "azure/sub-1": { kind: "loaded", resources: [], truncated: false, readAt: 1 } },
    });
    useCloud.getState().hideCloud("azure");

    const state = useCloud.getState();
    expect(state.shown).toEqual(["aws", "gcp"]);
    expect(state.tab).toBe("aws");
    expect(state.resources["azure/sub-1"]?.kind).toBe("loaded");
    expect(state.picking).toBe(false);
  });

  it("asks again when the last tab is closed", () => {
    useCloud.getState().chooseClouds(["gcp"]);
    useCloud.getState().hideCloud("gcp");

    expect(useCloud.getState().shown).toEqual([]);
    expect(useCloud.getState().picking).toBe(true);
  });

  it("asks again rather than trusting a stored answer nobody gave", () => {
    localStorage.setItem("aime.cloud.shown", "not json");
    expect(readShownClouds()).toBeNull();
    localStorage.setItem("aime.cloud.shown", '"gcp"');
    expect(readShownClouds()).toBeNull();
    localStorage.setItem("aime.cloud.shown", '["gcp", 7]');
    expect(readShownClouds()).toEqual(["gcp"]);
  });
});

/**
 * What a planned read has to survive before it becomes this machine's answer
 * for a whole kind of resource.
 *
 * Measured 2026-09-11 by running every stored plan against every resource in a
 * real Google account: `gcloud iam service-accounts describe <path>` and
 * `gcloud logging buckets describe <path> --location <region>` both exist, both
 * passed every check Aime had, and both failed on all 15 and all 26 of their
 * resources - because a plan was kept on the strength of the CLI HAVING the
 * command, and nothing ever ran it.
 */
describe("proving a read against the resource it was planned for", () => {
  const account = {
    id: "//iam.googleapis.com/projects/p1/serviceAccounts/svc@p1.iam.gserviceaccount.com",
    name: "Default compute service account",
    cliName: "svc@p1.iam.gserviceaccount.com",
    kind: "iam.googleapis.com/ServiceAccount",
    location: "global",
    group: "p1",
    tags: {},
  };
  const key = (read: PlannedRead) => `${account.id}#${read.label}`;

  const byPath: PlannedRead = {
    purpose: "overview",
    label: "gcloud iam service-accounts describe",
    args: ["iam", "service-accounts", "describe", "<path>"],
  };
  const byEmail: PlannedRead = { ...byPath, args: ["iam", "service-accounts", "describe", "<name>"] };

  /** The CLI's own answer to the wrong one, captured 2026-09-11, page and all. */
  const NOT_FOUND = "ERROR: (gcloud.iam.service-accounts.describe) HTTPError 404: <!DOCTYPE html>";
  /** A project with the API switched off refuses the right command the same way. */
  const API_OFF =
    "ERROR: (gcloud.logging.sinks.describe) PERMISSION_DENIED: Cloud Logging API has not been " +
    "used in project p1 before or it is disabled. Enable it by visiting " +
    "https://console.developers.google.com/apis/api/logging.googleapis.com/overview?project=p1 then retry.";

  beforeEach(() => {
    planOnDisk = null;
    storedReads = null;
    checked = [];
    checkedPlans = [];
    proofs = [];
    runs = [];
    replies = [];
    written.length = 0;
    asked = 0;
    commands.length = 0;
    useCloud.setState({ tab: "gcp", selected: { gcp: "p1" }, plans: {}, answers: {}, detail: null });
  });

  it("hands a read the CLI refused back to the AI, and stores only the one that ran", async () => {
    checked = [[byPath], [byEmail]];
    proofs = [NOT_FOUND, null];
    replies = ["{}", "{}"];

    useCloud.getState().openDetail(account);
    await settle();

    expect(asked).toBe(2);
    expect(written).toHaveLength(1);
    expect(written[0].reads).toEqual([byEmail]);
    expect(written[0].proved).toBe(true);
    // The trial run is the answer, so the panel does not run the same command
    // a second time to show it.
    expect(useCloud.getState().answers[key(byEmail)]).toEqual({ kind: "loaded", json: '{"ok":true}' });
    const plan = useCloud.getState().plans["gcp/iam.googleapis.com/ServiceAccount"];
    expect(plan?.kind === "ready" && plan.reads).toEqual([byEmail]);
    expect(plan?.kind === "ready" && plan.rejected[0].reason).toContain("HTTPError 404");
  });

  it("does not ask the AI to fix a command a switched-off API refused, and says the plan is unproved", async () => {
    checked = [[byEmail]];
    proofs = [API_OFF];
    replies = ["{}"];

    useCloud.getState().openDetail(account);
    await settle();

    // One call: the plan itself. A wall is not the command's fault, so there is
    // nothing to repair and no turn to spend finding that out.
    expect(asked).toBe(1);
    expect(written[0].reads).toEqual([byEmail]);
    expect(written[0].proved).toBe(false);
    // The wall is the answer the panel shows, with the button that clears it.
    expect(useCloud.getState().answers[key(byEmail)]).toEqual({ kind: "failed", reason: API_OFF });
  });

  it("takes a plan that has already answered on a real resource as it is", async () => {
    planOnDisk = { reads: [byEmail], facts: [], proved: true };

    useCloud.getState().openDetail(account);
    await settle();

    expect(asked).toBe(0);
    expect(commands).not.toContain("cloud_prove_read");
    expect(written).toHaveLength(0);
  });

  it("proves a plan from an older build again, without asking the AI anything", async () => {
    planOnDisk = { reads: [byEmail], facts: [], proved: false };
    proofs = [null];

    useCloud.getState().openDetail(account);
    await settle();

    expect(asked).toBe(0);
    expect(commands).toContain("cloud_prove_read");
    expect(written[0].proved).toBe(true);
  });

  /**
   * Measured 2026-09-11: the AI answered `iam service-accounts keys list
   * <name>`, Aime refused it for leaving out the `--iam-account` the CLI's own
   * synopsis calls required, and that was the end of it - the one read a
   * developer opens a service account for was silently gone. The refusal says
   * how to fix it, so it goes back with the others.
   */
  it("sends a command Aime refused back to the AI too, not only one that failed when it ran", async () => {
    const keysList: PlannedRead = {
      purpose: "secret",
      label: "gcloud iam service-accounts keys list",
      args: ["iam", "service-accounts", "keys", "list", "<name>"],
    };
    const refused: RejectedRead = {
      label: keysList.label,
      reason: "needs `--iam-account`. Its synopsis: gcloud iam service-accounts keys list --iam-account=…",
      command: keysList,
    };
    checkedPlans = [
      { reads: [], facts: [], rejected: [refused] },
      { reads: [byEmail], facts: [], rejected: [] },
    ];
    proofs = [null];
    replies = ["{}", "{}"];

    useCloud.getState().openDetail(account);
    await settle();

    expect(asked).toBe(2);
    expect(written[0].reads).toEqual([byEmail]);
    expect(written[0].proved).toBe(true);
  });

  /**
   * The one read a trial run can never prove, because proving it would fetch a
   * credential nobody asked for. Its first run is the click, so that is where
   * it is fixed - measured on this machine's own stored plan, `iam
   * service-accounts keys list --iam-account <path>` answered 404 for all
   * fifteen service accounts and nothing would ever have corrected it.
   */
  it("fixes a secret read the moment a person clicks Reveal and it fails, then runs it", async () => {
    const byPath: PlannedRead = {
      purpose: "secret",
      label: "gcloud iam service-accounts keys list",
      args: ["iam", "service-accounts", "keys", "list", "--iam-account", "<path>"],
    };
    const byEmailKeys: PlannedRead = { ...byPath, args: [...byPath.args.slice(0, -1), "<name>"] };
    useCloud.setState({
      plans: {
        "gcp/iam.googleapis.com/ServiceAccount": { kind: "ready", reads: [byPath], facts: [], rejected: [] },
      },
    });
    runs = [NOT_FOUND, null];
    checked = [[byEmailKeys]];
    replies = ["{}"];

    await useCloud.getState().runRead(account, byPath);
    await settle();

    expect(asked).toBe(1);
    expect(written[0].reads).toEqual([byEmailKeys]);
    // Unproved on purpose: what replaced it is a secret read, and the run that
    // matters is the one the click just asked for.
    expect(written[0].proved).toBe(false);
    expect(useCloud.getState().answers[key(byEmailKeys)]).toEqual({ kind: "loaded", json: '{"keys":[]}' });
  });

  it("leaves a wall alone when a read fails on the click, since there is nothing to fix", async () => {
    useCloud.setState({
      plans: {
        "gcp/iam.googleapis.com/ServiceAccount": { kind: "ready", reads: [byEmail], facts: [], rejected: [] },
      },
    });
    runs = [API_OFF];

    await useCloud.getState().runRead(account, byEmail);
    await settle();

    expect(asked).toBe(0);
    expect(written).toHaveLength(0);
    expect(useCloud.getState().answers[key(byEmail)]).toEqual({ kind: "failed", reason: API_OFF });
  });

  /**
   * Measured in the app 2026-09-11, and it is why a label is an identity: the
   * repair round rewrote both of a service account's reads, and without this
   * the plan came out holding the broken `keys list --iam-account <path>` AND
   * the `<name>` that replaced it - two rows under one heading, one of which
   * cannot run. The facts go the same way: they came from the same answer.
   */
  it("lets a repaired read replace the one it was written for, facts included", async () => {
    const keysByPath: PlannedRead = {
      purpose: "secret",
      label: "gcloud iam service-accounts keys list",
      args: ["iam", "service-accounts", "keys", "list", "--iam-account", "<path>"],
    };
    const keysByName: PlannedRead = { ...keysByPath, args: [...keysByPath.args.slice(0, -1), "<name>"] };
    planOnDisk = {
      reads: [byPath, keysByPath],
      facts: [{ label: "Service account email", value: "<name>@<group>.iam.gserviceaccount.com" }],
      proved: false,
    };
    checkedPlans = [
      {
        reads: [byEmail, keysByName],
        facts: [{ label: "Service account email", value: "<name>" }],
        rejected: [],
      },
    ];
    proofs = [NOT_FOUND, null];
    replies = ["{}"];

    useCloud.getState().openDetail(account);
    await settle();

    // The overview is the repaired one, and the secret read - which is never
    // run, so never proved - is the repaired one too, not both of them. Each
    // heading keeps the place it first had, so the pane does not reshuffle.
    expect(written[0].reads).toEqual([keysByName, byEmail]);
    expect(written[0].facts).toEqual([{ label: "Service account email", value: "<name>" }]);
  });

  /**
   * Measured 2026-09-12 over a real Google account: seven of its kinds have no
   * `gcloud` read at all - three of them belong to services `gcloud` has no
   * command group for - so the AI rightly answers no overview, and the panel
   * used to show nothing but facts. Aime's own read is added where the plan is
   * written (`reads.rs: own_overview`), which is why the panel must show the
   * plan that came BACK rather than the one it sent.
   */
  it("shows the overview the stored plan gained, not the one it sent", async () => {
    const secret: PlannedRead = {
      purpose: "secret",
      label: "gcloud iam service-accounts keys list",
      args: ["iam", "service-accounts", "keys", "list", "--iam-account", "<name>"],
    };
    const aimesOwn: PlannedRead = {
      purpose: "overview",
      label: "gcloud asset search-all-resources",
      args: ["asset", "search-all-resources", "--scope", "projects/<group>", "--query", 'name="<id>"'],
    };
    checkedPlans = [{ reads: [secret], facts: [], rejected: [] }];
    storedReads = [secret, aimesOwn];
    replies = ["{}"];

    useCloud.getState().openDetail(account);
    await settle();

    const plan = useCloud.getState().plans["gcp/iam.googleapis.com/ServiceAccount"];
    expect(plan?.kind).toBe("ready");
    expect(plan?.kind === "ready" && plan.reads).toEqual([secret, aimesOwn]);
    // And it is run on sight, the way any overview is - the secret one is not.
    expect(commands.filter((name) => name === "cloud_run_read")).toHaveLength(1);
  });

  it("gives up after two rounds rather than asking the AI forever", async () => {
    checked = [[byPath], [byPath], [byPath]];
    proofs = [NOT_FOUND, NOT_FOUND, NOT_FOUND];
    replies = ["{}", "{}", "{}"];

    useCloud.getState().openDetail(account);
    await settle();

    expect(asked).toBe(3);
    expect(written[0].reads).toEqual([]);
    const plan = useCloud.getState().plans["gcp/iam.googleapis.com/ServiceAccount"];
    expect(plan?.kind === "ready" && plan.reads).toEqual([]);
  });
});
