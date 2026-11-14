import { describe, expect, it } from "vitest";
import { failureOf, haveTurn, UNREACHABLE_WAITS_MS, type AgentTurnOutcome } from "./agentTurn";

const outcome = (stderr: string, text: string) => ({
  code: 1,
  text,
  costUsd: null,
  stderr,
  errors: "",
  sessionId: null,
});

describe("failureOf", () => {
  it("says why in the CLI's own last error line", () => {
    expect(failureOf(outcome("warming up\nsigned out: run the login command\n", "partial answer"))).toBe(
      "the AI CLI exited with 1: signed out: run the login command",
    );
  });

  it("falls back to the last thing the CLI said, then to the exit code alone", () => {
    expect(failureOf(outcome("", "Working on it.\nThe usage limit was reached."))).toBe(
      "the AI CLI exited with 1: The usage limit was reached.",
    );
    expect(failureOf(outcome("", ""))).toBe("the AI CLI exited with 1");
  });
});

describe("haveTurn", () => {
  const turn = (code: number | null, text: string): AgentTurnOutcome => ({
    code,
    text,
    costUsd: null,
    stderr: "",
    errors: "",
    sessionId: null,
  });
  // Claude Code 2.1.286's words for a closed port, and its words when signed out.
  const DOWN = turn(
    1,
    "API Error: Connection refused - a firewall or proxy may be blocking it (ECONNREFUSED)",
  );
  const SIGNED_OUT = turn(1, "Not logged in · Please run /login");

  /** Answers each try in turn, and records every wait instead of having it. */
  function scripted(answers: AgentTurnOutcome[], stopAfterWaits = Infinity) {
    const waits: number[] = [];
    let tries = 0;
    const result = haveTurn(() => Promise.resolve(answers[Math.min(tries++, answers.length - 1)]), {
      waitOrStop: (ms) => {
        waits.push(ms);
        return Promise.resolve(waits.length <= stopAfterWaits);
      },
      retrying: () => undefined,
    });
    return { result, waits, tries: () => tries };
  }

  it("tries again while the service cannot be reached, and hands back the answer once it comes", async () => {
    const run = scripted([DOWN, DOWN, turn(0, "done")]);
    expect(await run.result).toEqual({ kind: "answered", outcome: turn(0, "done") });
    expect(run.waits).toEqual(UNREACHABLE_WAITS_MS.slice(0, 2));
  });

  it("gives up after the last wait, and never reads the failure as an answer", async () => {
    const run = scripted([DOWN]);
    const result = await run.result;
    expect(result.kind).toBe("unavailable");
    expect(run.tries()).toBe(UNREACHABLE_WAITS_MS.length + 1);
  });

  it("does not wait on a sign-in that ran out: a person has to act", async () => {
    const run = scripted([SIGNED_OUT]);
    expect(await run.result).toEqual({
      kind: "unavailable",
      trouble: "signIn",
      reason: "the AI CLI exited with 1: Not logged in · Please run /login",
    });
    expect(run.waits).toEqual([]);
  });

  it("stops when the job is stopped while it waits", async () => {
    const run = scripted([DOWN], 0);
    expect((await run.result).kind).toBe("stopped");
  });

  it("hands back a failure that is the work's own, for its caller to read", async () => {
    const failing = turn(2, "TypeError: Cannot read properties of undefined");
    expect(await scripted([failing]).result).toEqual({ kind: "answered", outcome: failing });
  });
});
