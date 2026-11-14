import { describe, expect, it } from "vitest";
import { carriedFrom, costOfTurn, SESSION_WARM_MS, warmSession } from "./agentSession";

describe("warmSession", () => {
  const session = { sessionId: "s-1", lastTurnAt: 1_000 };

  it("carries a session on while the prompt cache still holds it", () => {
    expect(warmSession(session, 1_000 + SESSION_WARM_MS - 1)).toBe("s-1");
  });

  it("starts fresh once it has gone cold, or when there is none", () => {
    expect(warmSession(session, 1_000 + SESSION_WARM_MS)).toBeNull();
    expect(warmSession(null)).toBeNull();
  });

  it("is left by a turn only when the CLI named its session", () => {
    expect(carriedFrom({ sessionId: "s-2" }, 5)).toEqual({ sessionId: "s-2", lastTurnAt: 5 });
    expect(carriedFrom({ sessionId: null })).toBeNull();
  });
});

describe("costOfTurn", () => {
  it("charges a carried-on turn only what the session's total grew by", () => {
    const totals = new Map<string, number>();
    expect(costOfTurn(totals, { costUsd: 0.3, sessionId: "s-1" })).toBeCloseTo(0.3);
    expect(costOfTurn(totals, { costUsd: 0.45, sessionId: "s-1" })).toBeCloseTo(0.15);
  });

  it("charges a sessionless turn what it reported, and an unreported one nothing", () => {
    const totals = new Map<string, number>();
    expect(costOfTurn(totals, { costUsd: 0.2, sessionId: null })).toBeCloseTo(0.2);
    expect(costOfTurn(totals, { costUsd: null, sessionId: "s-1" })).toBe(0);
  });
});
