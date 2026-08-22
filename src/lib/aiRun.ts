/**
 * What a Task Run asks the model, and how the answers are read back.
 *
 * Same shape as `aiReview.ts`, for the same reason: the prompt, the result type
 * and the parser belong in one file, so a change to what is asked cannot drift
 * from what is expected. Every phase that runs a model asks for JSON and
 * parses it tolerantly — a model that answers with prose has failed its phase,
 * and the raw reply is kept so a person can see what it said instead.
 */

/** One thing the ticket asks for, numbered so a test can be mapped to it. */
export interface Criterion {
  id: string;
  text: string;
}

/** What the run understood the ticket to be asking. */
export interface Brief {
  /** One sentence: what this change is, in the run's own words. */
  goal: string;
  criteria: Criterion[];
  /**
   * Things the ticket does not settle. A blocking question stops the run: an
   * hour of confident work in the wrong direction is worse than one question.
   */
  questions: { text: string; blocking: boolean }[];
  /** The model's raw reply, kept for when the parse is disappointing. */
  raw: string;
}

export const UNDERSTAND_PROMPT = `You are about to implement a work item in this repository.
Read the item below and say what it actually asks for. Do not write code yet.

Answer ONLY with JSON, no prose and no code fence:
{"goal": "one sentence", "criteria": [{"id": "AC1", "text": "..."}],
 "questions": [{"text": "...", "blocking": true}]}

Rules:
- Every acceptance criterion must be checkable by a test. Split anything vague into checkable parts.
- A question is "blocking" only when you cannot pick a reasonable default and being wrong would
  waste the whole change. Prefer a sensible default over a question.
- If the item is clear, return an empty questions array.

The work item:
`;

/** One step of the plan, and the tests that will prove it. */
export interface PlanStep {
  what: string;
  files: string[];
  /** The ids of the criteria this step satisfies. */
  criteria: string[];
}

export interface Plan {
  steps: PlanStep[];
  /** One planned test per criterion, named so red-then-green can be checked. */
  tests: { name: string; file: string; criterion: string }[];
  raw: string;
}

export const PLAN_PROMPT = `Plan the change. Do not write code yet.

Answer ONLY with JSON, no prose and no code fence:
{"steps": [{"what": "...", "files": ["src/x.ts"], "criteria": ["AC1"]}],
 "tests": [{"name": "what the test proves", "file": "src/x.test.ts", "criterion": "AC1"}]}

Rules:
- Every acceptance criterion must appear in at least one test's "criterion".
- Tests go in the file the project's own convention puts them in - look at a neighbour.
- Name a test by the behaviour it proves, not by the function it calls.
`;

/** One thing a reviewer found, with the evidence that makes it checkable. */
export interface Finding {
  file: string;
  line: number;
  severity: "issue" | "suggestion";
  message: string;
  /** How this would be proved - a test to run, an input that breaks it. */
  check: string;
}

export interface Review {
  /** The risks this reviewer derived for *this* change, before looking. */
  risks: string[];
  findings: Finding[];
  raw: string;
}

export const REVIEW_PROMPT = `Review this change as a senior engineer would before it is merged.

First derive the risks: given this diff, this stack and these dependent modules, list the ways THIS
change could be wrong. Do not work from a generic checklist - correctness, performance, security and
house style are the floor, not the ceiling.

Then look for each risk you named.

Answer ONLY with JSON, no prose and no code fence:
{"risks": ["..."],
 "findings": [{"file": "src/x.ts", "line": 12, "severity": "issue",
               "message": "one sentence", "check": "how to prove it"}]}

Rules:
- A finding with no file and line is not a finding. Drop it.
- "check" must say how someone could prove you right: an input, a query count, a test to write.
  If you cannot say, the severity is "suggestion", not "issue".
- Say nothing about formatting; a formatter already ran.
`;

/**
 * Pulls the first JSON object out of a reply.
 *
 * Models fence their JSON, apologise before it, and explain after it. This
 * takes the outermost braces and tries them, which is what survives all three.
 */
function extractObject(reply: string): unknown {
  const withoutFence = reply.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The brief, or null when the reply was not one. */
export function parseBrief(reply: string): Brief | null {
  const object = asRecord(extractObject(reply));
  const goal = asString(object.goal);
  const criteria = asArray(object.criteria)
    .map((entry, index) => {
      const row = asRecord(entry);
      const text = asString(row.text);
      // An unnumbered criterion still needs a handle, or no test can cite it.
      return { id: asString(row.id) || `AC${String(index + 1)}`, text };
    })
    .filter((criterion) => criterion.text !== "");
  if (goal === "" || criteria.length === 0) return null;

  return {
    goal,
    criteria,
    questions: asArray(object.questions)
      .map((entry) => {
        const row = asRecord(entry);
        return { text: asString(row.text), blocking: row.blocking === true };
      })
      .filter((question) => question.text !== ""),
    raw: reply,
  };
}

/** The plan, or null when the reply was not one. */
export function parsePlan(reply: string): Plan | null {
  const object = asRecord(extractObject(reply));
  const steps = asArray(object.steps)
    .map((entry) => {
      const row = asRecord(entry);
      return {
        what: asString(row.what),
        files: asArray(row.files).map(asString).filter(Boolean),
        criteria: asArray(row.criteria).map(asString).filter(Boolean),
      };
    })
    .filter((step) => step.what !== "");
  const tests = asArray(object.tests)
    .map((entry) => {
      const row = asRecord(entry);
      return { name: asString(row.name), file: asString(row.file), criterion: asString(row.criterion) };
    })
    .filter((test) => test.name !== "");
  if (steps.length === 0) return null;
  return { steps, tests, raw: reply };
}

/** The review. Unlike the two above, an empty review is a real answer. */
export function parseReview(reply: string): Review {
  const object = asRecord(extractObject(reply));
  return {
    risks: asArray(object.risks).map(asString).filter(Boolean),
    findings: asArray(object.findings)
      .map((entry) => {
        const row = asRecord(entry);
        const line = Number(row.line);
        const check = asString(row.check);
        return {
          file: asString(row.file),
          line: Number.isFinite(line) ? line : 0,
          // Only a finding that says how to prove it may call itself an issue.
          severity: row.severity === "issue" && check !== "" ? ("issue" as const) : ("suggestion" as const),
          message: asString(row.message),
          check,
        };
      })
      // A finding with nowhere to look is not a finding.
      .filter((finding) => finding.message !== "" && finding.file !== ""),
    raw: reply,
  };
}

/**
 * The gate on a plan: every criterion must be covered by a test.
 *
 * This is the mechanical half of "the tests cover the requirement". It cannot
 * know whether the criteria themselves are complete — that is what the
 * blocking questions in phase one are for — but it can refuse a plan that
 * quietly drops one.
 */
export function uncoveredCriteria(brief: Brief, plan: Plan): Criterion[] {
  const covered = new Set(plan.tests.map((test) => test.criterion));
  return brief.criteria.filter((criterion) => !covered.has(criterion.id));
}
