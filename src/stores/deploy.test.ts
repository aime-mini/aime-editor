import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccount, CloudResource } from "./cloud";
import type { AgentTurnOptions } from "../lib/agentTurn";
import type { DeployStep } from "../lib/deploy";

/** Mirror of the Rust `StepRequest`, as `cloud_deploy_step` receives it. */
interface StepRequest {
  cloudId: string;
  account: CloudAccount;
  existing: boolean;
  step: DeployStep;
  cwd: string;
}

/**
 * The deploy store drives four steps with two parties it cannot trust blindly -
 * the AI's answers and the CLI's exits - and one it must obey: Stop. These
 * tests script both parties and pin what Aime does between them: which turns
 * run with which tools, what is checked, what runs, and when it stops.
 */

/** Every Tauri command called, in order, with its arguments. */
const calls: { command: string; args: Record<string, unknown> }[] = [];
/** What each AI turn asked for, in order - every turn except the ones that write the plan's files. */
const turns: AgentTurnOptions[] = [];
/** The turns that wrote the plan's files into the staging folder, answered by the mock itself. */
const fileTurns: AgentTurnOptions[] = [];
/**
 * The CLI's own list of its commands, or null for one that publishes none.
 * `cloud_cli_commands` answers its top-level groups, and the commands under
 * the groups it is asked for - the way the Rust side scopes a large tree.
 */
let vocabulary: string[] | null = null;
/** What `cloud_resources` answers when the deploy has to read the list itself; null fails it. */
let listing: CloudResource[] | null = [];
/** Planned files the AI is scripted to leave unwritten. */
let unwritten: string[] = [];
/** Whether the scripted CLI keeps a session and reports what it costs, as Claude Code and Codex do. */
let keepsSession = false;
/** Whether the person agrees to rewritten steps the moment they are asked; a test that pins the asking turns it off. */
let agreesToRewrites = true;
/** The AI's replies, consumed one per turn. */
let replies: string[] = [];
/** Exit codes per step label, consumed in order; a missing entry is a success. */
let exits: Record<string, number[] | undefined> = {};
/** What `cloud_deploy_read` answers per read label; consumed in order, last one repeats. */
let reads: Record<string, string[]> = {};
/** What each successive Rust check refuses; a check past the end of the queue passes everything. */
let refusals: { part: "step"; label: string; reason: string }[][] = [];
/** The step during which the person presses Stop, when they do. */
let stopDuringStep: string | null = null;
/** What the person types while a step runs, keyed by the step they type it during. */
let saysDuringStep: { at: string; say: string }[] = [];
/** What they type while the deployed service is being asked, when they do. */
let saysDuringProbe: string | null = null;
let probeStatus = 200;
/** What the service's own root answers, which the prove step asks separately. */
let rootStatus = 200;

const account: CloudAccount = {
  id: "my-project",
  label: "My Project",
  detail: "my-project",
  current: false,
  owner: "dev@example.com",
  tenant: "",
  signIn: "gcloud auth login dev@example.com",
};

const service: CloudResource = {
  id: "//run.googleapis.com/projects/my-project/locations/asia-southeast1/services/web",
  name: "web",
  cliName: "web",
  kind: "run.googleapis.com/Service",
  location: "asia-southeast1",
  group: "my-project",
  tags: {},
};

const DESCRIBE = ["run", "services", "describe", "web", "--region", "asia-southeast1"];

const SURVEY = JSON.stringify({
  app: { name: "shop", kind: "web", stack: "Node", port: 8080, healthPath: "/healthz", builds: "Dockerfile" },
  existing: [{ resourceId: service.id, role: "the service", evidence: "the name" }],
  inspect: [{ label: "describe web", args: DESCRIBE }],
  missing: [],
});

const PLAN = JSON.stringify({
  summary: "Deploy shop to the existing Cloud Run service web",
  reply: "Moved it to the cheaper tier; the service keeps every setting it has.",
  target: { existing: true, resourceId: service.id, region: "asia-southeast1" },
  proposal: null,
  keep: [
    {
      label: "environment variables",
      read: { label: "describe web", args: DESCRIBE },
      path: "spec.template.spec.containers.0.env",
    },
  ],
  steps: [
    { label: "Enable APIs", args: ["services", "enable", "run.googleapis.com"], changes: "enabled APIs" },
    {
      label: "Deploy from source",
      args: ["run", "deploy", "web", "--source", ".", "--region", "asia-southeast1"],
      changes: "a new revision",
    },
  ],
  files: [{ path: "Dockerfile", why: "the repository has none" }],
  prove: {
    read: { label: "describe web", args: DESCRIBE },
    urlPath: "status.url",
    path: "/healthz",
    expect: 200,
  },
});

const REVISION = JSON.stringify({
  steps: [
    {
      label: "Deploy with more memory",
      args: ["run", "deploy", "web", "--source", ".", "--memory", "1Gi"],
      changes: "a new revision",
    },
  ],
  files: [],
  inspect: [],
  giveUp: null,
});

/** What the AI answers to something said between two steps: words, and the remainder rewritten. */
const STEER = JSON.stringify({
  reply: "Moved what is left to eastasia; the step that has already run stays where it ran.",
  steps: [
    {
      label: "Deploy to eastasia",
      args: ["run", "deploy", "web", "--source", ".", "--region", "eastasia"],
      changes: "a new revision",
    },
  ],
});

const DESCRIBED = JSON.stringify({
  status: { url: "https://web-abc.a.run.app" },
  spec: { template: { spec: { containers: [{ env: [{ name: "A", value: "1" }] }] } } },
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "programs_present":
        return Promise.resolve([]);
      case "cloud_resources":
        return listing === null
          ? Promise.reject(new Error("ERROR: (gcloud.asset.search-all-resources) Reauthentication required."))
          : Promise.resolve({ resources: listing, truncated: false });
      case "read_file":
      case "path_size": {
        const path = String(args.path);
        if (unwritten.some((file) => path.endsWith(`/${file}`)))
          return Promise.reject(new Error("not found"));
        return Promise.resolve(command === "path_size" ? 12 : `staged ${path}`);
      }
      case "cloud_deploy_read": {
        const read = args.read as { label: string };
        const answers = reads[read.label] ?? [];
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        return answer === undefined ? Promise.reject(new Error("NOT_FOUND")) : Promise.resolve(answer);
      }
      case "cloud_check_deploy": {
        const plan = args.plan as { steps: { label: string }[]; keep: unknown[]; prove: unknown };
        const rejected = refusals.shift() ?? [];
        const refusedLabels = new Set(rejected.map((one) => one.label));
        return Promise.resolve({
          steps: plan.steps.filter((step) => !refusedLabels.has(step.label)),
          keep: plan.keep,
          prove: plan.prove,
          rejected,
        });
      }
      case "cloud_deploy_step": {
        const { step } = args.request as StepRequest;
        // The person is at the keyboard while this command runs, and may say
        // more than one thing before it ends.
        const saying = saysDuringStep.filter((one) => one.at === step.label);
        saysDuringStep = saysDuringStep.filter((one) => one.at !== step.label);
        for (const one of saying) useDeploy.getState().steer(SLOT, one.say);
        if (step.label === stopDuringStep) {
          void useDeploy.getState().cancel(SLOT);
          return Promise.resolve({
            code: null,
            stdout: "",
            stderr: "",
            durationMs: 5,
            timedOut: false,
            cancelled: true,
            clipped: false,
          });
        }
        const code = (exits[step.label] ?? []).shift() ?? 0;
        return Promise.resolve({
          code,
          stdout: `ran ${step.label}`,
          stderr: code === 0 ? "" : "ERROR: quota",
          durationMs: 5,
          timedOut: false,
          cancelled: false,
          clipped: false,
        });
      }
      case "cloud_http_probe": {
        if (saysDuringProbe !== null) {
          const said = saysDuringProbe;
          saysDuringProbe = null;
          useDeploy.getState().steer(SLOT, said);
        }
        // Answered per URL: a service can serve `/` and still refuse the
        // health path the plan chose.
        const asked = (args as { url?: string }).url ?? "";
        const status = asked.endsWith("/") ? rootStatus : probeStatus;
        return Promise.resolve({
          status,
          durationMs: 42,
          bodyHead: status === 200 ? "ok" : "Service Unavailable",
        });
      }
      case "cloud_cli_commands": {
        const asked = (args as { groups?: string[] }).groups ?? [];
        const top = (command: string) => !command.includes(" ");
        const under = (command: string) => asked.some((group) => command.startsWith(`${group} `));
        return Promise.resolve(vocabulary?.filter((command) => top(command) || under(command)) ?? null);
      }
      default:
        return Promise.resolve(undefined);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => undefined),
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: () => Promise.resolve("C:\\app-data") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));
vi.mock("../lib/agentTurn", async (importOriginal) => ({
  // The real `haveTurn`: what the deploy does with an answer is part of what is pinned.
  ...(await importOriginal<typeof import("../lib/agentTurn")>()),
  agentTurn: (options: AgentTurnOptions) => {
    // A CLI that keeps sessions reports its session's running total each turn.
    const answered = (text: string) =>
      Promise.resolve({
        code: 0,
        text,
        costUsd: keepsSession ? 0.1 * (turns.length + fileTurns.length) : null,
        stderr: "",
        errors: "",
        sessionId: keepsSession ? "deploy-session" : null,
      });
    if (options.prompt.startsWith("Write these files")) {
      fileTurns.push(options);
      return answered("written");
    }
    turns.push(options);
    options.onStarted?.(`run-${String(turns.length)}`);
    const text = replies.shift();
    if (text === undefined) throw new Error("the test scripted no reply for this turn");
    return answered(text);
  },
  cancelAgentTurn: () => Promise.resolve(),
}));

const { useDeploy } = await import("./deploy");
const { useCloud } = await import("./cloud");
const { useWorkspace } = await import("./workspace");

const SLOT = "gcp/my-project";

function stage() {
  const slot = useDeploy.getState().slots[SLOT];
  if (slot === undefined) throw new Error("no deploy slot");
  return slot.stage;
}

function log(kind?: "problem" | "note" | "output"): string[] {
  const slot = useDeploy.getState().slots[SLOT];
  return (slot?.log ?? [])
    .filter((line) => kind === undefined || line.kind === kind)
    .map((line) => line.text);
}

async function planned(): Promise<void> {
  await useDeploy.getState().start("gcp", account);
  expect(stage().kind).toBe("confirm");
}

/** Stands in for the person at the page that asks about rewritten steps. */
useDeploy.subscribe((state) => {
  if (agreesToRewrites && state.slots[SLOT]?.stage.kind === "reconfirm") state.agree(SLOT);
});

beforeEach(() => {
  agreesToRewrites = true;
  keepsSession = false;
  vocabulary = null;
  stopDuringStep = null;
  listing = [];
  calls.length = 0;
  turns.length = 0;
  fileTurns.length = 0;
  unwritten = [];
  replies = [SURVEY, PLAN];
  exits = {};
  reads = { "describe web": [DESCRIBED] };
  refusals = [];
  saysDuringStep = [];
  saysDuringProbe = null;
  probeStatus = 200;
  rootStatus = 200;
  useDeploy.setState({ slots: {}, open: null });
  useWorkspace.setState({ rootPath: "C:\\proj\\shop" });
  useCloud.setState({
    tab: "gcp",
    resources: { [SLOT]: { kind: "loaded", resources: [service], truncated: false, readAt: 0 } },
  });
});

describe("planning", () => {
  it("writes the plan's files into the staging folder before the confirm page, for the person to read", async () => {
    await planned();
    expect(fileTurns).toHaveLength(1);
    expect(fileTurns[0].permission).toBe("edits");
    expect(fileTurns[0].tools).toBe("filesOnly");
    expect(fileTurns[0].prompt).toContain("- Dockerfile: the repository has none");
    expect(stage()).toMatchObject({
      kind: "confirm",
      files: [{ path: "Dockerfile", content: "staged C:\\proj\\shop/.aime/deploy/staged/Dockerfile" }],
    });
  });

  /**
   * A large CLI's whole tree does not fit a prompt: the survey sees the
   * top-level groups and names the ones it will use, and the plan sees every
   * command under those - and under the groups its reads already used.
   */
  it("shows the survey the CLI's groups, and the plan every command under the ones it needs", async () => {
    vocabulary = ["compute", "run", "run deploy", "run services describe", "compute instances create"];
    replies = [JSON.stringify({ ...JSON.parse(SURVEY), groups: ["run"] }), PLAN];
    await planned();

    expect(calls.filter((call) => call.command === "cloud_cli_commands")).toEqual([
      { command: "cloud_cli_commands", args: { cloudId: "gcp", groups: [] } },
      { command: "cloud_cli_commands", args: { cloudId: "gcp", groups: ["run"] } },
    ]);
    expect(turns[0].prompt).toContain("`compute`, `run`. A command that starts otherwise");
    expect(turns[0].prompt).toContain("`groups`: the top-level command groups of `gcloud`");
    expect(turns[1].prompt).toContain("`run deploy`, `run services describe`");
    expect(turns[1].prompt).not.toContain("compute instances create");
  });

  it("surveys with files-only read-only turns, runs the reads it asked for, checks the plan, and waits", async () => {
    await planned();

    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.tools).toBe("filesOnly");
      expect(turn.permission).toBe("readOnly");
      expect(turn.cwd).toBe("C:\\proj\\shop");
    }
    expect(turns[0].prompt).toContain("run/Service  web  asia-southeast1");
    expect(turns[1].prompt).toContain("### describe web");

    const commands = calls.map((call) => call.command);
    // Then the staging folder is emptied, and the one file written read back for the page.
    expect(commands).toEqual([
      "programs_present",
      "cloud_cli_commands",
      "cloud_deploy_read",
      "cloud_cli_commands",
      "cloud_check_deploy",
      "path_size",
      "delete_path",
      "read_file",
    ]);
    const check = calls.find((call) => call.command === "cloud_check_deploy")?.args ?? {};
    expect(check.cloudId).toBe("gcp");
    expect(check.existing).toBe(true);
    expect(useDeploy.getState().open).toBe(SLOT);
    // Nothing ran: no step, no file, no probe.
    expect(commands).not.toContain("cloud_deploy_step");
  });

  /**
   * The confirm page is where a person first sees what would run, so it is
   * where they get to say "not like that". A revision is the PLAN step again
   * and nothing else: surveying the repository and re-reading the resources
   * would cost the same calls to learn the same things.
   */
  it("plans again from the person's own words, without surveying twice", async () => {
    replies = [SURVEY, PLAN, PLAN];
    await planned();
    const before = calls.length;

    await useDeploy.getState().revise(SLOT, "  use the cheaper tier  ");

    expect(stage().kind).toBe("confirm");
    // One more turn - the plan - and not a second survey or another read.
    expect(turns).toHaveLength(3);
    expect(turns[2].prompt).toContain("use the cheaper tier");
    expect(turns[2].prompt).toContain("What the person asked for");
    // The revised plan's files are written afresh: the revision may have changed them.
    expect(calls.slice(before).map((call) => call.command)).toEqual([
      "cloud_check_deploy",
      "path_size",
      "delete_path",
      "read_file",
    ]);
    expect(fileTurns).toHaveLength(2);
    // The note is kept, trimmed, shown in the log in the person's words - and
    // the plan's answer is filed against it, so the page is an exchange and
    // not a plan that quietly changed.
    expect(useDeploy.getState().slots[SLOT]?.notes).toEqual([
      {
        asked: "use the cheaper tier",
        answered: "Moved it to the cheaper tier; the service keeps every setting it has.",
      },
    ]);
    expect(log("note")).toContain("You asked: use the cheaper tier");
  });

  it("carries every earlier note into the next plan", async () => {
    replies = [SURVEY, PLAN, PLAN, PLAN];
    await planned();
    await useDeploy.getState().revise(SLOT, "use the cheaper tier");
    await useDeploy.getState().revise(SLOT, "and put it in eastasia");

    expect(useDeploy.getState().slots[SLOT]?.notes.map((note) => note.asked)).toEqual([
      "use the cheaper tier",
      "and put it in eastasia",
    ]);
    // Every one of them answered, oldest first.
    expect(useDeploy.getState().slots[SLOT]?.notes.every((note) => note.answered !== "")).toBe(true);
    expect(turns[3].prompt).toContain("use the cheaper tier");
    expect(turns[3].prompt).toContain("and put it in eastasia");
  });

  it("ignores an empty note, and one sent when there is no plan to change", async () => {
    replies = [SURVEY, PLAN];
    await planned();
    await useDeploy.getState().revise(SLOT, "   ");
    expect(turns).toHaveLength(2);

    await useDeploy.getState().revise("no-such-slot", "change it");
    expect(turns).toHaveLength(2);
  });

  it("asks once more with the refusal when the check refuses a step", async () => {
    refusals = [[{ part: "step", label: "Enable APIs", reason: "`projects` manages the account" }]];
    replies = [SURVEY, PLAN, PLAN];
    await planned();
    expect(turns).toHaveLength(3);
    expect(turns[2].prompt).toContain("do not repeat any of these");
    expect(turns[2].prompt).toContain("`projects` manages the account");
    expect(log("problem")).toEqual(["Refused step `Enable APIs`: `projects` manages the account"]);
  });

  it("does not run a plan the check keeps refusing", async () => {
    refusals = [
      [{ part: "step", label: "Enable APIs", reason: "no" }],
      [{ part: "step", label: "Enable APIs", reason: "still no" }],
    ];
    replies = [SURVEY, PLAN, PLAN];
    await useDeploy.getState().start("gcp", account);
    expect(stage()).toMatchObject({
      kind: "blocked",
      reason: "The plan still had parts Aime refused after being asked again.",
    });
    expect(calls.filter((call) => call.command === "cloud_check_deploy")).toHaveLength(2);
    expect(calls.filter((call) => call.command === "cloud_deploy_step")).toHaveLength(0);
  });

  it("reads the account's resources first when they were never read, and plans against them", async () => {
    useCloud.setState({ resources: {} });
    listing = [service];
    await planned();
    expect(calls[0]).toMatchObject({
      command: "cloud_resources",
      args: { cloudId: "gcp", account: account.id },
    });
    expect(turns[0].prompt).toContain("run/Service  web  asia-southeast1");
  });

  it("plans nothing when the account's resources cannot be read", async () => {
    useCloud.setState({ resources: {} });
    listing = null;
    await useDeploy.getState().start("gcp", account);
    expect(stage()).toMatchObject({ kind: "blocked" });
    expect(JSON.stringify(stage())).toContain("Reauthentication required");
    expect(turns).toHaveLength(0);
  });

  it("holds a plan the AI called new to the keep rule when a step names a running service", async () => {
    replies = [
      SURVEY,
      JSON.stringify({
        ...JSON.parse(PLAN),
        target: { existing: false, resourceId: null, region: "asia-southeast1" },
      }),
    ];
    await planned();
    const check = calls.find((call) => call.command === "cloud_check_deploy");
    expect(check?.args.existing).toBe(true);
    expect(stage()).toMatchObject({ plan: { target: { existing: true } } });
  });

  it("carries the AI's session from the survey on, and counts what the turns cost", async () => {
    keepsSession = true;
    await planned();
    expect(turns[0].sessionId).toBeNull();
    expect(turns[1].sessionId).toBe("deploy-session");
    expect(fileTurns[0].sessionId).toBe("deploy-session");
    // Running totals 0.1, 0.2, 0.3: the deploy is charged 0.3, not 0.6.
    expect(useDeploy.getState().slots[SLOT]?.spentUsd).toBeCloseTo(0.3);
  });

  it("stops before the confirm page when the plan cannot be proved", async () => {
    replies = [SURVEY, JSON.stringify({ ...JSON.parse(PLAN), prove: null })];
    await useDeploy.getState().start("gcp", account);
    expect(stage()).toMatchObject({ kind: "blocked" });
    expect(log("problem").length + log("note").length).toBeGreaterThan(0);
  });
});

describe("deploying", () => {
  it("writes the files, reads the kept settings, runs every step, proves the URL, and is done", async () => {
    await planned();
    replies = [];
    await useDeploy.getState().confirm(SLOT);

    const result = stage();
    expect(result).toMatchObject({ kind: "done", url: "https://web-abc.a.run.app", kept: 1 });

    // The files were written before the confirm page; Deploy only puts them in place.
    expect(fileTurns).toHaveLength(1);
    const placed = calls.filter((call) => call.command === "move_into_place").map((call) => call.args);
    expect(placed).toEqual([
      { from: "C:\\proj\\shop/.aime/deploy/staged/Dockerfile", to: "C:\\proj\\shop/Dockerfile" },
    ]);
    const firstStep = calls.findIndex((call) => call.command === "cloud_deploy_step");
    expect(calls.findIndex((call) => call.command === "move_into_place")).toBeLessThan(firstStep);

    const commands = calls.map((call) => call.command);
    const requests = calls
      .filter((call) => call.command === "cloud_deploy_step")
      .map((call) => call.args.request as StepRequest);
    expect(requests.map((request) => request.step.label)).toEqual(["Enable APIs", "Deploy from source"]);
    expect(requests[0].account).toEqual(account);
    expect(requests[0].existing).toBe(true);
    expect(requests[0].cwd).toBe("C:\\proj\\shop");
    // keep before, keep after, prove: three reads of the same describe.
    expect(commands.filter((one) => one === "cloud_deploy_read")).toHaveLength(4);
    const probe = calls.find((call) => call.command === "cloud_http_probe");
    expect(probe?.args.url).toBe("https://web-abc.a.run.app/healthz");
    expect(log("output")).toContain("GET https://web-abc.a.run.app/healthz → 200 in 42 ms");
  });

  it("hands a failed step to the AI with its output and runs the rewritten remainder", async () => {
    await planned();
    exits = { "Deploy from source": [1] };
    replies = [REVISION];
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "done" });
    const fixTurn = turns[2];
    expect(fixTurn.permission).toBe("edits");
    expect(fixTurn.tools).toBe("filesOnly");
    expect(fixTurn.prompt).toContain("Failed: Deploy from source");
    expect(fixTurn.prompt).toContain("ERROR: quota");
    expect(fixTurn.prompt).toContain("Every step had run");
    const steps = calls
      .filter((call) => call.command === "cloud_deploy_step")
      .map((call) => (call.args.request as StepRequest).step.label);
    expect(steps).toEqual(["Enable APIs", "Deploy from source", "Deploy with more memory"]);
    // The revision was checked before it ran.
    expect(calls.filter((call) => call.command === "cloud_check_deploy")).toHaveLength(2);
  });

  it("starts no further step once Stop is pressed between two steps", async () => {
    await planned();
    replies = [];
    // Pressed the moment the first step is shown as passed.
    const stop = useDeploy.subscribe((state) => {
      const current = state.slots[SLOT]?.stage;
      if (current?.kind === "deploying" && current.steps[0]?.state === "passed") {
        stop();
        void state.cancel(SLOT);
      }
    });
    await useDeploy.getState().confirm(SLOT);

    const steps = calls
      .filter((call) => call.command === "cloud_deploy_step")
      .map((call) => (call.args.request as StepRequest).step.label);
    expect(steps).toEqual(["Enable APIs"]);
    expect(stage()).toMatchObject({ kind: "blocked", reason: "Stopped." });
  });

  it("keeps the steps on the page when a deploy is stopped mid-step, the one in flight marked stopped", async () => {
    await planned();
    stopDuringStep = "Deploy from source";
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({
      kind: "blocked",
      steps: [
        { step: { label: "Enable APIs" }, state: "passed" },
        { step: { label: "Deploy from source" }, state: "stopped" },
      ],
    });
  });

  it("does not call a setting kept when its path answered nothing to begin with", async () => {
    await planned();
    reads = { "describe web": [JSON.stringify({ status: { url: "https://web-abc.a.run.app" } })] };
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "done", kept: 0 });
    expect(log("problem").join("\n")).toContain("Not checked: environment variables");
  });

  /** A fix that keeps the agreed command and changes a file instead. */
  const FILE_FIX = JSON.stringify({
    steps: [
      {
        label: "Deploy from source",
        args: ["run", "deploy", "web", "--source", ".", "--region", "asia-southeast1"],
        changes: "a new revision",
      },
    ],
    files: [{ path: "Dockerfile", why: "listen on the port Cloud Run gives" }],
    inspect: [],
    giveUp: null,
  });

  it("puts a file a fix changed in place only once the person has read it and agreed", async () => {
    await planned();
    exits = { "Deploy from source": [1] };
    replies = [FILE_FIX];
    const asked: unknown[] = [];
    const watch = useDeploy.subscribe((state) => {
      const current = state.slots[SLOT]?.stage;
      // Once per page shown: the log grows under a page that stays.
      if (current?.kind === "reconfirm" && asked.at(-1) !== current.files) asked.push(current.files);
    });
    await useDeploy.getState().confirm(SLOT);
    watch();

    expect(stage()).toMatchObject({ kind: "done" });
    // Asked even though the command is the agreed one: the file is new.
    expect(asked).toEqual([
      [
        {
          path: "Dockerfile",
          why: "listen on the port Cloud Run gives",
          content: "staged C:\\proj\\shop/.aime/deploy/staged/Dockerfile",
        },
      ],
    ]);
    const order = calls
      .map((call) => call.command)
      .filter((command) => command === "move_into_place" || command === "cloud_deploy_step");
    // Placed once from the confirm page, once from the fix - and the second
    // time before the failed step is tried again.
    expect(order).toEqual([
      "move_into_place",
      "cloud_deploy_step",
      "cloud_deploy_step",
      "move_into_place",
      "cloud_deploy_step",
    ]);
  });

  it("throws a fix's files away when the person stops at the page that asks", async () => {
    agreesToRewrites = false;
    await planned();
    exits = { "Deploy from source": [1] };
    replies = [FILE_FIX];
    const deploying = useDeploy.getState().confirm(SLOT);
    await vi.waitFor(() => {
      expect(stage().kind).toBe("reconfirm");
    });
    const placedBefore = calls.filter((call) => call.command === "move_into_place").length;
    await useDeploy.getState().cancel(SLOT);
    await deploying;

    expect(calls.filter((call) => call.command === "move_into_place")).toHaveLength(placedBefore);
    expect(calls.at(-1)).toEqual({
      command: "delete_path",
      args: { path: "C:\\proj\\shop/.aime/deploy/staged" },
    });
  });

  it("runs no rewritten step the person has not agreed to", async () => {
    agreesToRewrites = false;
    await planned();
    exits = { "Deploy from source": [1] };
    replies = [REVISION];
    const deploying = useDeploy.getState().confirm(SLOT);
    await vi.waitFor(() => {
      expect(stage().kind).toBe("reconfirm");
    });
    expect(stage()).toMatchObject({
      revised: [{ label: "Deploy with more memory" }],
      changed: [true],
    });
    await useDeploy.getState().cancel(SLOT);
    await deploying;

    expect(stage()).toMatchObject({ kind: "blocked" });
    const steps = calls
      .filter((call) => call.command === "cloud_deploy_step")
      .map((call) => (call.args.request as StepRequest).step.label);
    expect(steps).toEqual(["Enable APIs", "Deploy from source"]);
  });

  it("stops rather than loop when the same step fails the same way twice", async () => {
    await planned();
    exits = { "Deploy from source": [1], "Deploy with more memory": [1, 1] };
    const sameAgain = JSON.stringify({ ...JSON.parse(REVISION) });
    replies = [REVISION, sameAgain, sameAgain];
    await useDeploy.getState().confirm(SLOT);

    const result = stage();
    expect(result).toMatchObject({
      reason: "The same step failed the same way twice; stopped rather than looping.",
    });
  });

  it("stops when two fixes undo each other in turn, not after every round", async () => {
    await planned();
    exits = { "Deploy from source": [1, 1], "Deploy with more memory": [1] };
    const back = JSON.stringify({
      ...JSON.parse(REVISION),
      steps: [
        {
          label: "Deploy from source",
          args: ["run", "deploy", "web", "--source", ".", "--region", "asia-southeast1"],
          changes: "a new revision",
        },
      ],
    });
    replies = [REVISION, back];
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({
      reason: "The same step failed the same way twice; stopped rather than looping.",
    });
    // Two fix turns, then the third failure is one already seen.
    expect(turns).toHaveLength(4);
  });

  it("reports a setting it promised to keep when the deployment changed it", async () => {
    await planned();
    const changed = JSON.stringify({
      status: { url: "https://web-abc.a.run.app" },
      spec: { template: { spec: { containers: [{ env: [{ name: "A", value: "2" }] }] } } },
    });
    // before: original; prove: changed; after: changed.
    reads = { "describe web": [DESCRIBED, changed, changed] };
    replies = [];
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({
      kind: "blocked",
      reason: "Settings the plan promised to keep have changed: environment variables",
    });
  });

  it("treats a service that does not answer as a failure for the AI to fix, then proves again", async () => {
    await planned();
    // Down everywhere, root included: that is a service that never started,
    // and it is the AI's to fix. Both come back once the first prove is over -
    // a prove that fails asks the path and then the root, so two calls.
    probeStatus = 503;
    rootStatus = 503;
    replies = [REVISION];
    const unsubscribe = useDeploy.subscribe(() => {
      if (calls.filter((call) => call.command === "cloud_http_probe").length >= 2) {
        probeStatus = 200;
        rootStatus = 200;
      }
    });
    await useDeploy.getState().confirm(SLOT);
    unsubscribe();

    expect(stage()).toMatchObject({ kind: "done" });
    expect(turns[2].prompt).toContain("The service answered 503, not 200.");
    expect(turns[2].prompt).toContain("Service Unavailable");
    // Three, not two: a probe that comes back wrong asks the service's root
    // before any verdict, because a working service with a health path Cloud
    // Run answers itself looks exactly like a service that never started
    // (measured: `/healthz` got Google's own 404 while `/` served).
    const probeCalls = calls.filter((call) => call.command === "cloud_http_probe");
    expect(probeCalls).toHaveLength(3);
    expect(probeCalls[1].args).toMatchObject({ url: "https://web-abc.a.run.app/" });
  });

  it("says the service is serving when only the health path the plan chose is wrong", async () => {
    // Measured on a deploy that really worked: Cloud Run answered
    // `/healthz` itself with Google's 404 page and never reached the
    // container, while `/` served. Reported as a plain failure, that sends
    // somebody hunting a service that is already up.
    await planned();
    probeStatus = 404;
    rootStatus = 200;
    replies = [REVISION, REVISION];
    await useDeploy.getState().confirm(SLOT);

    // No fix round at all: deploying again cannot change which paths Cloud Run
    // answers for itself, and every round is another Cloud Build on the bill.
    expect(stage()).toMatchObject({ kind: "blocked" });
    expect(turns).toHaveLength(2);
    const told = log("problem").join("\n");
    expect(told).toContain("The service answered 404, not 200.");
    expect(told).toContain("https://web-abc.a.run.app - so it is deployed and serving");
    expect(told).toContain("`/healthz` that is wrong");
  });

  it("does not claim a service is serving when its root is down too", async () => {
    await planned();
    probeStatus = 503;
    rootStatus = 503;
    replies = [REVISION, REVISION];
    await useDeploy.getState().confirm(SLOT);

    const told = log("problem").join("\n");
    expect(told).toContain("The service answered 503, not 200.");
    expect(told).not.toContain("deployed and serving");
  });

  it("does not go ahead from the confirm page when the person says not now", async () => {
    await planned();
    await useDeploy.getState().cancel(SLOT);
    expect(stage()).toMatchObject({ kind: "blocked", reason: "Stopped." });
    expect(calls.filter((call) => call.command === "cloud_deploy_step")).toHaveLength(0);
    // The files waiting for a yes are thrown away, and none was put in place.
    expect(calls.filter((call) => call.command === "move_into_place")).toHaveLength(0);
    expect(calls.at(-1)).toEqual({
      command: "delete_path",
      args: { path: "C:\\proj\\shop/.aime/deploy/staged" },
    });
  });

  it("runs nothing when a file the person agreed to was never written", async () => {
    unwritten = ["Dockerfile"];
    await planned();
    expect(stage()).toMatchObject({ files: [{ path: "Dockerfile", content: null }] });
    await useDeploy.getState().confirm(SLOT);
    expect(stage()).toMatchObject({ kind: "blocked" });
    expect(calls.filter((call) => call.command === "cloud_deploy_step")).toHaveLength(0);
    expect(calls.filter((call) => call.command === "move_into_place")).toHaveLength(0);
  });
});

/**
 * A deploy that goes wrong used to leave one button, Stop. The box is open
 * while the commands run now, and these pin the promise made with it: what is
 * typed never touches the command in flight, it reaches the AI at the first
 * moment nothing is running, and nothing it writes runs unchecked.
 */
describe("speaking while it runs", () => {
  it("takes the words at the end of the step in flight and runs the remainder it rewrote", async () => {
    await planned();
    replies = [STEER];
    saysDuringStep = [{ at: "Enable APIs", say: "  put it in eastasia  " }];
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "done" });
    const steerTurn = turns[2];
    expect(steerTurn.permission).toBe("edits");
    expect(steerTurn.tools).toBe("filesOnly");
    expect(steerTurn.prompt).toContain("> put it in eastasia");
    expect(steerTurn.prompt).toContain("Already run");
    expect(steerTurn.prompt).toContain("- Enable APIs");

    // The step being run when they typed finished; the one that had not
    // started was replaced by what came back - after it was checked.
    const steps = calls
      .filter((call) => call.command === "cloud_deploy_step")
      .map((call) => (call.args.request as StepRequest).step.label);
    expect(steps).toEqual(["Enable APIs", "Deploy to eastasia"]);
    expect(calls.filter((call) => call.command === "cloud_check_deploy")).toHaveLength(2);
    expect(useDeploy.getState().slots[SLOT]?.notes).toEqual([
      {
        asked: "put it in eastasia",
        answered: "Moved what is left to eastasia; the step that has already run stays where it ran.",
      },
    ]);
    expect(log("note")).toContain("You asked: put it in eastasia");
  });

  it("hands what was said in with the failure rather than spending a turn of its own", async () => {
    await planned();
    exits = { "Deploy from source": [1] };
    const answered = JSON.stringify({
      ...(JSON.parse(REVISION) as object),
      reply: "The quota is on the other project, so the deploy goes there.",
    });
    replies = [answered];
    saysDuringStep = [{ at: "Deploy from source", say: "the quota is on another project" }];
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "done" });
    const fixTurn = turns[2];
    expect(fixTurn.prompt).toContain("Failed: Deploy from source");
    expect(fixTurn.prompt).toContain("> the quota is on another project");
    // One turn, not two: the failure and the person's words are one question.
    expect(turns).toHaveLength(3);
    expect(useDeploy.getState().slots[SLOT]?.notes.at(-1)?.answered).toBe(
      "The quota is on the other project, so the deploy goes there.",
    );
  });

  it("goes on with the plan that was confirmed when Aime refuses what came back", async () => {
    await planned();
    replies = [STEER];
    saysDuringStep = [{ at: "Enable APIs", say: "put it in eastasia" }];
    refusals = [[{ part: "step", label: "Deploy to eastasia", reason: "the target may not move" }]];
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "done" });
    const steps = calls
      .filter((call) => call.command === "cloud_deploy_step")
      .map((call) => (call.args.request as StepRequest).step.label);
    expect(steps).toEqual(["Enable APIs", "Deploy from source"]);
    expect(log("problem")).toContain("Refused step `Deploy to eastasia`: the target may not move");
    // Answered with both halves: what the AI said, and what Aime did about it.
    const answered = useDeploy.getState().slots[SLOT]?.notes.at(-1)?.answered ?? "";
    expect(answered).toContain("Moved what is left to eastasia");
    expect(answered).toContain("goes on exactly as you confirmed it");
  });

  it("says so when the words arrive with nothing left to steer", async () => {
    await planned();
    replies = [];
    saysDuringProbe = "make it cheaper";
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "done" });
    // No turn was spent on a deployment that had already finished.
    expect(turns).toHaveLength(2);
    expect(useDeploy.getState().slots[SLOT]?.notes).toEqual([
      {
        asked: "make it cheaper",
        answered: "This arrived after the deployment had finished; nothing was changed.",
      },
    ]);
  });

  it("answers in the AI's own words when it gives up on what was asked", async () => {
    await planned();
    saysDuringProbe = "use the other region";
    // The service never answers, so the AI is asked how to go on - with the
    // words the person typed while it was being asked - and it gives up.
    probeStatus = 503;
    rootStatus = 503;
    replies = [JSON.stringify({ steps: [], files: [], inspect: [], giveUp: "the quota needs a person" })];
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "blocked" });
    expect(turns[2].prompt).toContain("> use the other region");
    expect(useDeploy.getState().slots[SLOT]?.notes.at(-1)?.answered).toBe("the quota needs a person");
  });

  it("answers what never reached the AI at all when the deployment stops", async () => {
    await planned();
    replies = [];
    saysDuringProbe = "use the other region";
    // Serving on its root but not on the path the plan chose: Aime stops
    // without asking the AI anything, so the question needs an answer of its own.
    probeStatus = 404;
    rootStatus = 200;
    await useDeploy.getState().confirm(SLOT);

    expect(stage()).toMatchObject({ kind: "blocked" });
    expect(turns).toHaveLength(2);
    expect(useDeploy.getState().slots[SLOT]?.notes.at(-1)?.answered).toBe(
      "The deployment stopped before anything could be done about this.",
    );
  });

  it("keeps two things said during one step as one question with one answer", async () => {
    await planned();
    replies = [STEER];
    saysDuringStep = [
      { at: "Enable APIs", say: "that region is wrong" },
      { at: "Enable APIs", say: "use eastasia" },
    ];
    await useDeploy.getState().confirm(SLOT);

    // Both reach the AI, in the order they were typed...
    expect(turns[2].prompt).toContain(["> that region is wrong", "use eastasia"].join("\n"));
    // ...as one question, so neither is left waiting for an answer of its own.
    expect(useDeploy.getState().slots[SLOT]?.notes).toEqual([
      {
        asked: ["that region is wrong", "use eastasia"].join("\n"),
        answered: "Moved what is left to eastasia; the step that has already run stays where it ran.",
      },
    ]);
  });

  it("ignores an empty note, and one sent when no step is running", async () => {
    await planned();
    useDeploy.getState().steer(SLOT, "   ");
    // At the confirm page the plan box takes it, and replans; this one does not.
    useDeploy.getState().steer(SLOT, "another region");
    useDeploy.getState().steer("no-such-slot", "another region");

    expect(useDeploy.getState().slots[SLOT]?.notes).toEqual([]);
    expect(turns).toHaveLength(2);
  });
});
