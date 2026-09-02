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

export const UNDERSTAND_PROMPT = `You are about to implement a work item in this repository. Read the
item, then read the code it lands in, and answer both questions at once: what is being asked, and
what ground it stands on. Do not write code yet.

Look at the code: search it, open the candidates, follow what calls what. Read two or three
neighbours of every file you name. Do not answer from the wording of the ticket, and do not answer
from what projects like this usually do - only from what THIS repository does.

Answer ONLY with JSON, no prose and no code fence:
{"goal": "one sentence", "criteria": [{"id": "AC1", "text": "..."}],
 "questions": [{"text": "...", "blocking": true}],
 "files": ["src/x.ts"],
 "patterns": ["what the rule is, and the file you saw it in"],
 "testsLiveIn": "where a test for this code goes, and which runner runs it",
 "suites": [{"command": "gradle test", "dir": "."}]}

Rules:
- Every acceptance criterion must be checkable by a test. Split anything vague into checkable parts.
- A question is "blocking" only when you cannot pick a reasonable default and being wrong would
  waste the whole change. Prefer a sensible default over a question.
- If the item is clear, return an empty questions array.
- "files" holds repository-relative paths and nothing else.
- Every pattern must name the file it was observed in. A pattern with no evidence is a guess.
- Say the layering, the error handling and the naming you found - those are what a reviewer will
  measure the change against.
- "suites" is for a project whose manifest declares no test script at all: the commands that really
  run its tests, read from its CI configuration, Makefile, build files or docs - never invented.
  Each entry names the command and the directory it runs in, relative to the repository root.
  A project whose package manifest already has test scripts answers an empty array here.

The work item:
`;

/**
 * What reading the code said about the ground this change stands on.
 *
 * The files are the part a run cannot do without. The patterns are the part
 * that makes a change look like it belongs: they are read out of the
 * repository - "state lives in a zustand store, components never call invoke" -
 * rather than recalled, and they are carried into every later phase so the code
 * that gets written follows this project instead of the model's habits.
 */
export interface Survey {
  files: string[];
  /** Each one a rule this repository already follows, citing where it was seen. */
  patterns: string[];
  /** Where tests go here, and with which runner, taken from a neighbour. */
  testsLiveIn: string;
  /**
   * How this project's tests are really run, for a project whose manifest
   * declares no test script Aime could detect — read out of CI configuration,
   * Makefiles or docs. Claims, not facts, until Aime has run every one of them:
   * a command that does not start is dropped, never trusted.
   */
  suites: SuiteCommand[];
  raw: string;
}

/** One test command the model found declared somewhere other than a manifest. */
export interface SuiteCommand {
  command: string;
  /** Where it runs, relative to the repository root; "." is the root itself. */
  dir: string;
}

/**
 * The solution: the way it will be done, and what taking it locks in.
 *
 * A plan answers "what will I do"; this answers "why this way", which is the
 * part a reader needs in order to disagree with a change before it is written
 * rather than after. **One** approach, not a menu: choosing between three
 * write-ups is the work that was delegated in the first place, and a reader who
 * does not like the one on screen can say so and start the run again.
 */
export interface Solution {
  /** The way it will be done, in a sentence or two. */
  how: string;
  /** Why this way, and what it was preferred over. */
  why: string;
  /** What this locks in: data shape, error handling, security, cost. */
  decisions: string[];
  /**
   * Whether proving these cases needs the software built, deployed and driven.
   *
   * The one thing that scales a run to the size of its task. "Done means
   * deployed" is right for a change a person will use and absurd for a renamed
   * constant: demanding an artifact from running software for an internal
   * refactor either blocks honest work or gets satisfied by a token file, and
   * the second is worse. The model decides it, because it read the project and
   * it wrote these cases - Aime guessing from a file extension is the rigid
   * rule already rejected once (see `casesWithoutProof`).
   */
  needsDeploy: boolean;
  raw: string;
}

export const DESIGN_PROMPT = `Decide how this gets done, what proof it needs, and in what order.
This is the page a person will read and agree to before anything is written, so all three belong in
one answer. Do not write code yet.

Answer ONLY with JSON, no prose and no code fence:
{"how": "the way you will do it, one or two sentences",
 "why": "why this way, and what you rejected to get here",
 "decisions": ["what this locks in - a data shape, an error path, a permission, a query"],
 "needsDeploy": true,
 "cases": [{"id": "TC1", "criterion": "AC1", "prove": "how this case gets checked",
            "given": "the starting state", "when": "the action", "then": "what must be true after"}],
 "steps": [{"what": "...", "files": ["src/x.ts"], "criteria": ["AC1"]}],
 "tests": [{"name": "what the test proves", "file": "src/x.test.ts", "case": "TC1"}]}

The approach:
- ONE approach: the best one for THIS repository. Do not offer alternatives to choose between - the
  choice was handed to you, and a reader who disagrees will say so on the page this appears on.
- "why" must name what you rejected. An approach with nothing weighed against it was not decided.
- Every decision must be one this change actually makes. Do not list principles.
- Weigh it against the conventions of this repository, the dependent files listed below and the cost
  of getting it wrong - not against general good practice.
- "needsDeploy" is true when believing these cases requires the software built, deployed and driven -
  a screen, an endpoint, a command a person runs. It is false when the project's own suites are what
  would convince a tester: a pure function, an internal refactor, a string a locale file holds. Answer
  it for THIS change, not for the project: getting it wrong upwards makes a one-line change deploy an
  application, and getting it wrong downwards lets a broken screen call itself proved.

The test cases - write them as a tester would, before any code exists:
- Every acceptance criterion needs at least one case. A criterion with a boundary, an empty value or
  an error path needs one case for each - the happy path alone is not coverage.
- "prove" is the check that would make a tester believe this case: a unit test of the logic, a
  request and the response it must return, driving the running app and looking at what is on screen.
  Decide it from what THIS project is - a screen is not proved by a unit test of the function behind
  it, and a pure function does not need a browser.
- "then" must be observable: a value, a status, a message on screen, a row in a table. Not "it works".
- Keep each case to one behaviour. Two behaviours in one case is a case that cannot fail cleanly.

The plan:
- Every case above must appear in at least one test's "case".
- Tests go where this repository puts them, in the runner it already uses - not where you would
  put them.
- Name a test by the behaviour it proves, not by the function it calls.
- Steps in the order they can be done. A step that cannot be finished without the next one is one
  step, not two.
`;

/**
 * One test case, written the way a tester writes one: a starting state, an
 * action, and the result that must follow.
 *
 * This exists as its own artifact because "there is a test" and "the
 * requirement is covered" are different claims. A criterion turns into numbered
 * cases the reader can check, disagree with and keep; the tests are then written
 * from the cases rather than from the model's reading of the ticket.
 */
export interface TestCase {
  id: string;
  /** The acceptance criterion this case proves. */
  criterion: string;
  /**
   * How this case gets checked so that passing it counts as proof.
   *
   * A sentence the model writes out of what this project actually is, not a
   * value from a list Aime keeps: the honest answer for a screen, an endpoint
   * and a pure function are three different checks, and nothing about a file
   * path can tell them apart.
   */
  prove: string;
  given: string;
  when: string;
  then: string;
}

export interface TestCases {
  cases: TestCase[];
  raw: string;
}

/** One step of the plan, and the tests that will prove it. */
export interface PlanStep {
  what: string;
  files: string[];
  /** The ids of the criteria this step satisfies. */
  criteria: string[];
}

export interface Plan {
  steps: PlanStep[];
  /** One planned test per test case, so the mapping can be checked mechanically. */
  tests: { name: string; file: string; case: string }[];
  raw: string;
}

/**
 * What a finding is about, which is what decides whether it can stop a run.
 *
 * Two of these are not opinions. A change in the wrong layer does not belong in
 * the repository however well it is written, and a hole in access control is not
 * a matter of taste - so an unfixed finding of either kind ends the run rather
 * than going into the report for someone to notice later. The rest are a
 * reviewer's judgement, and a reviewer can be wrong, so they are reported.
 */
export type FindingKind = "architecture" | "security" | "correctness" | "performance" | "style";

/** One thing a reviewer found, with the evidence that makes it checkable. */
export interface Finding {
  file: string;
  line: number;
  severity: "issue" | "suggestion";
  kind: FindingKind;
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

Then look for each risk you named, and for these four in every case:
- It follows this project's architecture and conventions, or it does not belong here however well it
  is written.
- Security: check it against the OWASP Top Ten that can apply to this code - injection, broken
  access control, authentication, cryptographic failures, insecure design, SSRF, deserialisation,
  logging a secret. Name the item you matched.
- Performance: a query inside a loop, one request turned into N, a whole collection read to answer
  something about one row.
- If it changed a user interface, it looks like the rest of this app: the components, tokens, theme
  and spacing already in the repository, not a look of its own.

Answer ONLY with JSON, no prose and no code fence:
{"risks": ["..."],
 "findings": [{"file": "src/x.ts", "line": 12, "severity": "issue", "kind": "architecture",
               "message": "one sentence", "check": "how to prove it"}]}

Rules:
- A finding with no file and line is not a finding. Drop it.
- "check" must say how someone could prove you right: an input, a query count, a test to write.
  If you cannot say, the severity is "suggestion", not "issue".
- "kind" is one of: architecture, security, correctness, performance, style. Use "architecture" for
  code that works but sits in the wrong place for this project - the wrong layer, a component
  reaching past the boundary its neighbours respect, a rule this repository wrote down and this
  change ignores. Use "security" only for something an attacker could use. These two end the run when
  they cannot be fixed, so do not reach for them to add weight to a preference.
- A test that asserts nothing is a finding, and it is "correctness": the tests here are written
  beside the code, so a test that would pass with the feature deleted is the one thing no gate
  after you can catch.
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

const KINDS: FindingKind[] = ["architecture", "security", "correctness", "performance", "style"];

/**
 * One of the five kinds, defaulting to the one that cannot end a run.
 *
 * The opposite choice from `needsDeploy`, and for the opposite reason: a field
 * the model forgot must not invent a reason to stop the work, and nothing is
 * lost by the default - the finding is still reported and still handed to the
 * phase that fixes it.
 */
function asKind(value: unknown): FindingKind {
  return KINDS.find((kind) => kind === value) ?? "correctness";
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

/** The survey, or null when the reply named no file to work in. */
export function parseSurvey(reply: string): Survey | null {
  const object = asRecord(extractObject(reply));
  const files = asArray(object.files)
    .map(asString)
    // A path, not a sentence about a path: a line with a space in it is prose,
    // and a line with no dot is a folder or a heading.
    .filter((file) => file !== "" && !file.includes(" ") && file.includes("."));
  if (files.length === 0) return null;
  return {
    files: [...new Set(files)],
    patterns: asArray(object.patterns).map(asString).filter(Boolean),
    testsLiveIn: asString(object.testsLiveIn),
    suites: asArray(object.suites)
      .map((entry) => {
        const row = asRecord(entry);
        return { command: asString(row.command), dir: asString(row.dir) || "." };
      })
      .filter((suite) => suite.command !== ""),
    raw: reply,
  };
}

/** The solution, or null when the reply was not a decision. */
export function parseSolution(reply: string): Solution | null {
  const object = asRecord(extractObject(reply));
  const how = asString(object.how);
  const why = asString(object.why);
  // A way with no reason is an instinct, and a reason with no way is an
  // opinion. The decision is both.
  if (how === "" || why === "") return null;
  return {
    how,
    why,
    decisions: asArray(object.decisions).map(asString).filter(Boolean),
    // Absent reads as "yes, deploy it". A field the model forgot must not be
    // the way a change quietly skips being proved where it runs.
    needsDeploy: object.needsDeploy !== false,
    raw: reply,
  };
}

/** The test cases, or null when the reply held no complete case. */
export function parseTestCases(reply: string): TestCases | null {
  const object = asRecord(extractObject(reply));
  const cases = asArray(object.cases)
    .map((entry, index) => {
      const row = asRecord(entry);
      return {
        // An unnumbered case still needs a handle, or no test can cite it.
        id: asString(row.id) || `TC${String(index + 1)}`,
        criterion: asString(row.criterion),
        prove: asString(row.prove),
        given: asString(row.given),
        when: asString(row.when),
        then: asString(row.then),
      };
    })
    // A case missing its action or its expected result is not a case: nothing
    // could be written from it, and nothing could fail it.
    .filter((one) => one.when !== "" && one.then !== "" && one.criterion !== "");
  if (cases.length === 0) return null;
  return { cases, raw: reply };
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
      return { name: asString(row.name), file: asString(row.file), case: asString(row.case) };
    })
    .filter((test) => test.name !== "" && test.file !== "");
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
          kind: asKind(row.kind),
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
 * The gate on the test cases: every criterion must have at least one.
 *
 * This is the mechanical half of "the tests cover the requirement". It cannot
 * know whether the criteria themselves are complete — that is what the
 * questions in phase one are for — but it can refuse a set of cases that
 * quietly drops one.
 */
export function uncoveredCriteria(brief: Brief, cases: TestCases): Criterion[] {
  const covered = new Set(cases.cases.map((one) => one.criterion));
  return brief.criteria.filter((criterion) => !covered.has(criterion.id));
}

/**
 * The gate on a plan: every test case must be somebody's job.
 *
 * The cases are the agreed statement of what proof looks like, so a plan is
 * allowed to disagree about *where* a case is proved and never about *whether*
 * it is.
 */
export function uncoveredCases(cases: TestCases, plan: Plan): TestCase[] {
  const planned = new Set(plan.tests.map((test) => test.case));
  return cases.cases.filter((one) => !planned.has(one.id));
}

/**
 * The cases that never said how they would be proved.
 *
 * The gate that replaced guessing at the layer from a file path: rather than
 * Aime deciding a `.tsx` file needs a UI test, the case has to say what check
 * would make it believable, and one that says nothing is handed back to be
 * answered. What the answer *is* remains the model's call — it read the project
 * and Aime did not.
 */
export function casesWithoutProof(cases: TestCases): TestCase[] {
  return cases.cases.filter((one) => one.prove === "");
}

/**
 * The findings a run may not be finished with.
 *
 * The half of the senior bar that was missing: the prompts said "follow this
 * project's architecture - that is a rule, not advice", and then a reviewer who
 * found the rule broken wrote it into a report and the run reported success
 * anyway. Which made it advice. These are the findings that end a run instead,
 * and they are deliberately few - an issue, said to be about architecture or
 * security, with a way to check it. Everything else a reviewer thinks is
 * reported, because a reviewer can be wrong and a change made to please a
 * mistaken one is worse than the finding.
 */
export function blockingFindings(review: Review): Finding[] {
  return review.findings.filter(
    (finding) =>
      finding.severity === "issue" && (finding.kind === "architecture" || finding.kind === "security"),
  );
}

/** The findings worth handing to a fixer: an issue with a way to check it. */
export function fixableFindings(review: Review): Finding[] {
  return review.findings.filter((finding) => finding.severity === "issue");
}
