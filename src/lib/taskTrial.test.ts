import { describe, expect, it } from "vitest";
import type { DiscoveredTask } from "./aiTasks";
import type { CommandOutcome } from "./exec";
import { lastLine, tryTask } from "./taskTrial";

const task = (kind: DiscoveredTask["kind"], dir = "."): DiscoveredTask => ({
  kind,
  label: "x",
  command: "make test",
  dir,
  source: "Makefile",
});

const outcome = (patch: Partial<CommandOutcome>): CommandOutcome => ({
  code: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  clipped: false,
  ...patch,
});

describe("tryTask", () => {
  it("runs the command in its own folder of the project", async () => {
    const ran: string[] = [];
    await tryTask(task("test", "api"), "C:/repo", (command, cwd) => {
      ran.push(`${cwd} ${command}`);
      return Promise.resolve(outcome({}));
    });
    expect(ran).toEqual(["C:/repo/api make test"]);
  });

  it("says a command that outlived its time did not finish", async () => {
    const trial = await tryTask(task("build"), "/r", () =>
      Promise.resolve(outcome({ code: null, timedOut: true })),
    );
    expect(trial).toEqual({ kind: "failed", output: "did not finish within 10 minutes" });
  });

  it("says so when a failure printed nothing at all", async () => {
    const trial = await tryTask(task("check"), "/r", () => Promise.resolve(outcome({ code: 2 })));
    expect(trial).toEqual({ kind: "failed", output: "exited with 2 and printed nothing" });
  });

  it("does not try what would serve forever or publish", async () => {
    const never = () => Promise.reject(new Error("must not run"));
    expect(await tryTask(task("run"), "/r", never)).toEqual({ kind: "notTried" });
    expect(await tryTask(task("publish"), "/r", never)).toEqual({ kind: "notTried" });
  });
});

describe("lastLine", () => {
  it("is the last line that says something", () => {
    expect(lastLine("compiling\nerror: no rule to make target 'test'\n\n")).toBe(
      "error: no rule to make target 'test'",
    );
  });
});
