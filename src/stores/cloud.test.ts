import { beforeEach, describe, expect, it, vi } from "vitest";
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
  invoke: (command: string) => {
    commands.push(command);
    switch (command) {
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
vi.mock("../lib/aiOneshot", () => ({ aiOneshot: () => Promise.resolve("") }));
vi.mock("./terminals", () => ({ runInTerminal: () => undefined }));

const { useCloud, waitingForSignIn } = await import("./cloud");

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
      plans: {
        "gcp/cloudresourcemanager.googleapis.com/Project": { kind: "ready", reads: [read], rejected: [] },
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
