import { describe, expect, it } from "vitest";
import { failureOf } from "./agentTurn";

const outcome = (stderr: string, text: string) => ({ code: 1, text, costUsd: null, stderr });

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
