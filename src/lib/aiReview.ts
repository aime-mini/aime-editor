/**
 * Reading an AI's review of a diff.
 *
 * A CLI answers with text, not with an API contract: it may wrap JSON in a
 * fence, introduce it with a sentence, or ignore the requested shape entirely.
 * Parsing therefore takes what it can and says so honestly - a review that
 * cannot be read is shown as prose rather than dropped, because the user asked
 * for an opinion and deserves to see it either way.
 */

export type ReviewSeverity = "issue" | "suggestion";

export interface ReviewFinding {
  file: string;
  /** 1-based; 0 when the AI did not name a line. */
  line: number;
  severity: ReviewSeverity;
  message: string;
}

export interface Review {
  findings: ReviewFinding[];
  /** Whatever the AI said that was not a finding; shown when nothing parsed. */
  text: string;
}

/** The instruction sent with the diff. Kept here so the shape and the parser stay together. */
export const REVIEW_PROMPT =
  "Review this diff as a careful senior engineer would before it is committed. " +
  "Answer ONLY with a JSON array, no prose and no code fence. Each element: " +
  '{"file": "path from the diff", "line": number, "severity": "issue" | "suggestion", "message": "one sentence"}. ' +
  'Use "issue" for something that is wrong or risky and "suggestion" for anything else. ' +
  "Report nothing that the diff does not show. An empty array means you found nothing worth raising.\n\n";

/** Pulls the first JSON array out of a reply that may be wrapped in anything. */
function extractArray(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toFinding(value: unknown): ReviewFinding | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) return null;
  return {
    file: typeof raw.file === "string" ? raw.file : "",
    // A line the AI could not place is better shown without one than with a guess.
    line: typeof raw.line === "number" && Number.isFinite(raw.line) ? Math.max(0, Math.trunc(raw.line)) : 0,
    severity: raw.severity === "issue" ? "issue" : "suggestion",
    message,
  };
}

export function parseReview(reply: string): Review {
  const parsed = extractArray(reply);
  const findings = Array.isArray(parsed)
    ? parsed.map(toFinding).filter((f): f is ReviewFinding => f !== null)
    : [];
  return { findings, text: reply.trim() };
}
