import { describe, expect, it } from "vitest";
import { carriedFrom, costOfTurn, SESSION_WARM_MS, SessionBook, warmSession } from "./agentSession";

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

describe("SessionBook", () => {
  const turn = (code: number | null, sessionId: string | null, costUsd: number | null = null) => ({
    code,
    sessionId,
    costUsd,
  });

  it("carries on the session of a turn that finished, while it is warm", () => {
    const book = new SessionBook();
    book.carryOn(turn(0, "s-1"), 1_000);
    expect(book.warm(1_000 + SESSION_WARM_MS - 1)).toBe("s-1");
    expect(book.warm(1_000 + SESSION_WARM_MS)).toBeNull();
  });

  it("drops the session of a turn that failed or was stopped", () => {
    const book = new SessionBook();
    book.carryOn(turn(0, "s-1"), 1_000);
    book.carryOn(turn(1, "s-1"), 1_000);
    expect(book.warm(1_000)).toBeNull();
    book.carryOn(turn(0, "s-2"), 1_000);
    book.carryOn(turn(null, "s-2"), 1_000);
    expect(book.warm(1_000)).toBeNull();
  });

  it("charges each turn its own share across the turns it books", () => {
    const book = new SessionBook();
    expect(book.charge(turn(0, "s-1", 0.3))).toBeCloseTo(0.3);
    expect(book.charge(turn(0, null, 0.05))).toBeCloseTo(0.05);
    expect(book.charge(turn(0, "s-1", 0.45))).toBeCloseTo(0.15);
  });
});
