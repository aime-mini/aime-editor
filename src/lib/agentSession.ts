/**
 * Carrying one caller's own CLI session from turn to turn, and charging each
 * turn only its own share of what the session costs.
 *
 * A resumed session sends its whole history again: within the provider's
 * prompt-cache lifetime that is billed at the cache rate, after it at the full
 * rate, which costs more than a fresh turn told what it needs. Five minutes is
 * the default lifetime of Anthropic's prompt cache and the shortest OpenAI
 * keeps (both providers' prompt-caching documentation).
 */

/** How long a session is worth carrying on after its last turn. */
export const SESSION_WARM_MS = 5 * 60 * 1000;

/** A session one caller's own turn opened, and when its last turn ended. */
export interface CarriedSession {
  sessionId: string;
  lastTurnAt: number;
}

/** The session to carry on now, or null when there is none or it has gone cold. */
export function warmSession(session: CarriedSession | null, now = Date.now()): string | null {
  return session !== null && now - session.lastTurnAt < SESSION_WARM_MS ? session.sessionId : null;
}

/** The session a finished turn leaves to carry on; null for a CLI that reports none. */
export function carriedFrom(outcome: { sessionId: string | null }, now = Date.now()): CarriedSession | null {
  return outcome.sessionId === null ? null : { sessionId: outcome.sessionId, lastTurnAt: now };
}

/**
 * What a turn cost on its own. A CLI reports its session's running total, so a
 * turn that carried a session on is charged only what the total grew by;
 * `totals` remembers each session's last total.
 */
export function costOfTurn(
  totals: Map<string, number>,
  outcome: { costUsd: number | null; sessionId: string | null },
): number {
  if (outcome.costUsd === null) return 0;
  if (outcome.sessionId === null) return outcome.costUsd;
  const before = totals.get(outcome.sessionId) ?? 0;
  totals.set(outcome.sessionId, outcome.costUsd);
  return Math.max(0, outcome.costUsd - before);
}

/**
 * One job's AI sessions - a deploy's, a task run's: the session it carries on
 * while warm, and the running total each session has reported, so every turn
 * is charged its own share whether it carried the session on or not.
 */
export class SessionBook {
  #carried: CarriedSession | null = null;
  readonly #totals = new Map<string, number>();

  /** The session to carry on now, or null to start fresh. */
  warm(now = Date.now()): string | null {
    return warmSession(this.#carried, now);
  }

  /** What a finished turn cost on its own (`costOfTurn`). */
  charge(turn: { costUsd: number | null; sessionId: string | null }): number {
    return costOfTurn(this.#totals, turn);
  }

  /**
   * Keeps the session a turn leaves to carry on. Only a turn that finished
   * cleanly leaves one: a failed or stopped turn's session ends mid-thought,
   * and the next turn is better started fresh and told what it needs.
   */
  carryOn(turn: { code: number | null; sessionId: string | null }, now = Date.now()): void {
    this.#carried = turn.code === 0 ? carriedFrom(turn, now) : null;
  }
}
