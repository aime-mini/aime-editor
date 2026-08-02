/**
 * Small fuzzy matcher for the command palette: case-insensitive subsequence
 * scoring with word-start and consecutive-run bonuses. Pure and unit-tested.
 */

/** Consecutive runs must beat scattered word-start hits (compact > gappy). */
const CONSECUTIVE_BONUS = 8;
const WORD_START_BONUS = 6;
const BASE_SCORE = 1;
/** Mild penalty per skipped character keeps compact matches on top. */
const GAP_PENALTY = 0.02;

function isSeparator(char: string): boolean {
  return char === "/" || char === "\\" || char === "-" || char === "_" || char === "." || char === " ";
}

/** Word starts: position 0, after a separator, or a camelCase hump. */
function isWordStart(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target[index - 1];
  if (isSeparator(previous)) return true;
  const current = target[index];
  return current >= "A" && current <= "Z" && previous >= "a" && previous <= "z";
}

/** Returns a relevance score, or null when `query` is not a subsequence of `target`. */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let previousMatch = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const char = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === char) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found === -1) return null;

    if (found === previousMatch + 1) score += CONSECUTIVE_BONUS;
    else if (isWordStart(target, found)) score += WORD_START_BONUS;
    else score += BASE_SCORE;
    score -= (found - previousMatch - 1) * GAP_PENALTY;

    previousMatch = found;
    ti = found + 1;
  }

  // Prefer shorter targets when everything else ties.
  return score - target.length * 0.001;
}

export interface FuzzyResult<T> {
  item: T;
  score: number;
}

/** Filters and ranks `items` by fuzzy relevance of `keyOf(item)` to `query`. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  keyOf: (item: T) => string,
  limit: number,
): FuzzyResult<T>[] {
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, keyOf(item));
    if (score !== null) results.push({ item, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
