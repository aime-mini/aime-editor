import { describe, expect, it } from "vitest";
import type { CommandOutcome } from "./exec";
import {
  addressOf,
  environmentPrompt,
  needsAnything,
  parseEnvironment,
  withServices,
  type Launcher,
  type Service,
} from "./testEnvironment";

describe("parseEnvironment", () => {
  it("reads the setup and the services, defaulting a missing folder to the root", () => {
    const environment = parseEnvironment(
      '{"why":"the e2e suite drives the dev server","setup":[{"command":"npx playwright install chromium"}],' +
        '"services":[{"command":"npm run dev","dir":"web","ready":"http://localhost:5173"}]}',
    );
    expect(environment).toEqual({
      why: "the e2e suite drives the dev server",
      setup: [{ command: "npx playwright install chromium", dir: "." }],
      services: [{ command: "npm run dev", dir: "web", ready: "http://localhost:5173" }],
    });
  });

  it("drops a service whose ready address cannot be knocked on, since nothing could say it came up", () => {
    const environment = parseEnvironment(
      '{"why":"x","setup":[],"services":[{"command":"npm run dev","ready":"when it says ready"},' +
        '{"command":"docker compose up db","ready":"localhost:5432"}]}',
    );
    expect(environment?.services).toEqual([
      { command: "docker compose up db", dir: ".", ready: "localhost:5432" },
    ]);
  });

  it("tells an answer that needs nothing apart from one it could not read", () => {
    const none = parseEnvironment('{"why":"the assertion is wrong","setup":[],"services":[]}');
    expect(none).not.toBeNull();
    expect(none !== null && needsAnything(none)).toBe(false);
    expect(parseEnvironment("I think it needs a server.")).toBeNull();
  });
});

describe("addressOf", () => {
  it.each([
    ["http://localhost:5173", { host: "localhost", port: 5173 }],
    ["http://127.0.0.1:3000/health", { host: "127.0.0.1", port: 3000 }],
    ["https://localhost", { host: "localhost", port: 443 }],
    ["localhost:5432", { host: "localhost", port: 5432 }],
    ["postgres://user@localhost:5433/app", { host: "localhost", port: 5433 }],
    ["http://[::1]:8080", { host: "::1", port: 8080 }],
  ])("finds where %s answers", (ready, address) => {
    expect(addressOf(ready)).toEqual(address);
  });

  it("finds nothing in words", () => {
    expect(addressOf("when it prints ready")).toBeNull();
  });
});

describe("environmentPrompt", () => {
  it("shows each failing suite by its command and the end of what it printed", () => {
    const output = Array.from({ length: 200 }, (_, index) => `line ${String(index)}`).join("\n");
    const prompt = environmentPrompt([{ command: "npm run test:e2e", output }]);
    expect(prompt).toContain("$ npm run test:e2e");
    expect(prompt).toContain("line 199");
    expect(prompt).not.toContain("line 100\n");
  });
});

const dev: Service = { command: "npm run dev", dir: ".", ready: "http://localhost:5173" };

/** A machine to start things on, in memory: what ran, what stopped, and when the port opens. */
function fakeMachine(options: { upAfterPolls?: number; exits?: CommandOutcome } = {}) {
  const started: string[] = [];
  const stopped: string[] = [];
  let polls = 0;
  let next = 0;
  const launcher: Launcher = {
    start: (id, command) => {
      started.push(`${id} ${command}`);
      return options.exits === undefined
        ? new Promise<CommandOutcome>(() => undefined)
        : Promise.resolve(options.exits);
    },
    stop: (id) => {
      stopped.push(id);
      return Promise.resolve();
    },
    reachable: () => {
      polls += 1;
      return Promise.resolve(options.upAfterPolls !== undefined && polls > options.upAfterPolls);
    },
    nextId: () => `svc-${String(++next)}`,
    sleep: () => Promise.resolve(),
  };
  return { launcher, started, stopped };
}

describe("withServices", () => {
  it("runs the work once the service answers, and stops the service afterwards", async () => {
    const machine = fakeMachine({ upAfterPolls: 3 });
    const outcome = await withServices([dev], "/repo", machine.launcher, () => Promise.resolve("suites ran"));
    expect(outcome).toEqual({ result: "suites ran" });
    expect(machine.started).toEqual(["svc-1 npm run dev"]);
    expect(machine.stopped).toEqual(["svc-1"]);
  });

  it("stops the service even when the work throws", async () => {
    const machine = fakeMachine({ upAfterPolls: 0 });
    await expect(
      withServices([dev], "/repo", machine.launcher, () => Promise.reject(new Error("suite crashed"))),
    ).rejects.toThrow("suite crashed");
    expect(machine.stopped).toEqual(["svc-1"]);
  });

  it("gives up on a service that exits before it answers, with what it printed", async () => {
    const exits: CommandOutcome = {
      code: 1,
      stdout: "",
      stderr: "Error: listen EADDRINUSE: address already in use :::5173",
      durationMs: 40,
      timedOut: false,
      cancelled: false,
      clipped: false,
    };
    const machine = fakeMachine({ exits });
    let worked = false;
    const outcome = await withServices([dev], "/repo", machine.launcher, () => {
      worked = true;
      return Promise.resolve();
    });
    expect(worked).toBe(false);
    expect(outcome).toEqual({ failure: { service: dev, output: exits.stderr } });
    expect(machine.stopped).toEqual(["svc-1"]);
  });

  it("gives up on a service that never answers, and still stops it", async () => {
    const machine = fakeMachine();
    const outcome = await withServices([dev], "/repo", machine.launcher, () => Promise.resolve());
    expect(outcome).toEqual({ failure: { service: dev, output: null } });
    expect(machine.stopped).toEqual(["svc-1"]);
  });

  it("stops everything it started when the second service fails, newest first", async () => {
    const api: Service = { command: "npm run api", dir: "api", ready: "http://localhost:4000" };
    const machine = fakeMachine({ upAfterPolls: 0 });
    let reached = 0;
    machine.launcher.reachable = () => Promise.resolve(++reached === 1);
    const outcome = await withServices([dev, api], "/repo", machine.launcher, () => Promise.resolve());
    expect("failure" in outcome && outcome.failure.service).toEqual(api);
    expect(machine.stopped).toEqual(["svc-2", "svc-1"]);
  });
});
