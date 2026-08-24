import { describe, expect, it, vi } from "vitest";
import type { CommandOutcome } from "./exec";
import {
  alreadyFailing,
  checkEvidence,
  checkTasksOf,
  isClean,
  newlyFailing,
  runChecks,
  type CheckPass,
} from "./qualityGate";
import type { TaskDef } from "../stores/tasks";

const CHECK: TaskDef = { id: "node.check", label: "npm run check", kind: "check", command: "npm run check" };
const LINT: TaskDef = { id: "node.lint", label: "npm run lint", kind: "check", command: "npm run lint" };
const TEST: TaskDef = { id: "node.test", label: "npm test", kind: "test", command: "npm test" };

function outcome(over: Partial<CommandOutcome>): CommandOutcome {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    durationMs: 10,
    timedOut: false,
    cancelled: false,
    clipped: false,
    ...over,
  };
}

/** The command each call was given, which is what these tests are about. */
function commandsOf(run: { mock: { calls: unknown[][] } }): string[] {
  return run.mock.calls.map((call) => String(call[1]));
}

let ids = 0;
const nextId = () => `check-${String((ids += 1))}`;

/** A pass in which the named checks failed and the rest passed. */
function pass(tasks: TaskDef[], failing: string[]): Promise<CheckPass> {
  return runChecks(tasks, "C:/work", nextId, (_id, command) =>
    Promise.resolve(outcome({ code: failing.includes(command) ? 1 : 0, stdout: `ran ${command}` })),
  );
}

describe("checkTasksOf", () => {
  it("takes the project's own checks and nothing else", () => {
    expect(checkTasksOf([TEST, CHECK, LINT]).map((task) => task.id)).toEqual(["node.check", "node.lint"]);
  });
});

describe("runChecks", () => {
  it("runs every check the project declares, in its own folder", async () => {
    const run = vi.fn().mockResolvedValue(outcome({}));
    await runChecks([{ ...LINT, cwd: "api" }, CHECK], "C:/work", nextId, run);

    expect(commandsOf(run)).toEqual(["npm run lint", "npm run check"]);
    expect(run.mock.calls[0][2]).toBe("C:/work/api");
    expect(run.mock.calls[1][2]).toBe("C:/work");
  });

  it("keeps a check that would not start apart from one that failed", async () => {
    const refused = vi.fn().mockRejectedValue(new Error("eslint is not installed"));
    const result = await runChecks([LINT], "C:/work", nextId, refused);

    expect(result.checks[0].outcome).toBeNull();
    expect(result.checks[0].error).toContain("eslint");
    // Not runnable is not satisfied: a gate with nothing behind it is not clean.
    expect(isClean(result.checks[0])).toBe(false);
  });
});

describe("newlyFailing", () => {
  it("blames the change only for what it actually broke", async () => {
    const before = await pass([CHECK, LINT], ["npm run lint"]);
    const after = await pass([CHECK, LINT], ["npm run check", "npm run lint"]);

    // `check` was clean and is not any more - that is this change's doing.
    expect(newlyFailing(before, after).map((one) => one.id)).toEqual(["node.check"]);
    // `lint` was already failing, so the change does not answer for it.
    expect(alreadyFailing(before, after).map((one) => one.id)).toEqual(["node.lint"]);
  });

  it("says nothing when the change left every check as it found it", async () => {
    const before = await pass([CHECK], []);
    const after = await pass([CHECK], []);
    expect(newlyFailing(before, after)).toEqual([]);
  });

  it("ignores a check that never ran in the baseline", async () => {
    // It established nothing to regress from, and counting it either way would
    // be inventing a fact about a command nobody could run.
    const before = await runChecks([LINT], "C:/work", nextId, vi.fn().mockRejectedValue(new Error("gone")));
    const after = await pass([LINT], ["npm run lint"]);
    expect(newlyFailing(before, after)).toEqual([]);
  });
});

describe("checkEvidence", () => {
  it("quotes the command and the tail of what it said", async () => {
    const noisy = await runChecks([LINT], "C:/work", nextId, () =>
      Promise.resolve(outcome({ code: 1, stdout: `${"progress\n".repeat(2000)}src/a.ts:3 no-explicit-any` })),
    );
    const said = checkEvidence(noisy.checks);

    expect(said).toContain("$ npm run lint");
    // The tail, because every one of these tools prints its summary last.
    expect(said).toContain("src/a.ts:3 no-explicit-any");
    expect(said.length).toBeLessThan(7_000);
  });

  it("quotes the reason instead when the command never ran", async () => {
    const broken = await runChecks(
      [LINT],
      "C:/work",
      nextId,
      vi.fn().mockRejectedValue(new Error("no eslint")),
    );
    expect(checkEvidence(broken.checks)).toContain("no eslint");
  });
});
