import { invoke } from "@tauri-apps/api/core";
import type { Brief, Plan, Review, Solution, TestCases } from "./aiRun";
import type { GateVerdict } from "./regressionGate";
import type { Run } from "./runPlan";
import type { CaseGap, CaseVerdict } from "./testCaseFile";

/**
 * The record a run leaves behind: the case table, and the evidence.
 *
 * Written as Markdown into the project's own `.aime/runs/`, beside the journal
 * the run is resumed from, because the question "what was actually proved here?"
 * outlives both the panel and the session. The table is the part a tester would
 * sign; the evidence is the part nobody can argue with.
 *
 * Aime never stages a photograph of its own work. What it collects is what the
 * project's own tools left on disk while the suites ran - a Playwright trace, a
 * wdio screenshot, a coverage report - and it only counts a file whose
 * modification time falls inside the run, because a screenshot from last Tuesday
 * proves nothing about today.
 */

/**
 * Folders test runners write their artifacts into.
 *
 * Named rather than guessed: these are the defaults of the runners themselves -
 * `test-results/` and `playwright-report/` (Playwright), `cypress/screenshots`
 * and `cypress/videos` (Cypress), `TestResults/` (VSTest, `--logger trx`), and
 * the two an Aime-configured wdio run writes. Anything else is somebody's own
 * arrangement, and inventing a path for it would list files that are not
 * evidence of anything.
 */
const EVIDENCE_DIRS = [
  "test-results",
  "playwright-report",
  "cypress/screenshots",
  "cypress/videos",
  "TestResults",
  "e2e/screenshots",
  "screenshots",
  // And the artifacts the deliver phase was told to make itself: one per test
  // case, plus the proof that the deployed software answered.
  ".aime/evidence",
];

/** How deep inside one of those folders a file is still found. */
const EVIDENCE_DEPTH = 3;

/** What counts as something a person can look at, or a machine can re-read. */
const EVIDENCE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".webm",
  ".zip",
  ".html",
  ".trx",
  ".xml",
  ".json",
  // Captured command output - the deliver phase saves a test run's own words
  // as <case>.txt, and captured text is as much an artifact as a screenshot.
  ".txt",
];

/** Whether this file name is the kind of thing worth pointing a reader at. */
export function isEvidence(name: string): boolean {
  const lower = name.toLowerCase();
  return EVIDENCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Mirror of the Rust `DirEntry`. */
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified_ms: number | null;
}

/**
 * Files the suites left behind during this run.
 *
 * `since` is the run's own start, so a stale artifact from a previous afternoon
 * is not presented as this change's evidence. A file whose modification time the
 * filesystem would not give up is left out for the same reason: unknown is not
 * "recent enough".
 */
export async function collectEvidence(root: string, since: number): Promise<string[]> {
  const found: string[] = [];
  const base = root.replace(/[\\/]+$/, "");
  for (const dir of EVIDENCE_DIRS) {
    await walk(`${base}/${dir}`, since, EVIDENCE_DEPTH, found);
  }
  return found.sort();
}

async function walk(path: string, since: number, depth: number, found: string[]): Promise<void> {
  if (depth === 0) return;
  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("list_dir", { path });
  } catch {
    // Not there, which is the normal case: most projects have most of these
    // folders missing, and that is not a condition worth reporting.
    return;
  }
  for (const entry of entries) {
    if (entry.is_dir) {
      await walk(entry.path, since, depth - 1, found);
    } else if (isEvidence(entry.name) && entry.modified_ms !== null && entry.modified_ms >= since) {
      found.push(entry.path);
    }
  }
}

/** Everything the report is rendered from. */
export interface ReportInput {
  run: Run | null;
  brief: Brief | null;
  solution: Solution | null;
  cases: TestCases | null;
  plan: Plan | null;
  review: Review | null;
  verdict: GateVerdict | null;
  outcomes: ReadonlyMap<string, CaseVerdict>;
  evidence: string[];
  /**
   * Whether this change had to be deployed to be believed. It changes what PASS
   * means, so the footnote states the conditions this run actually applied
   * rather than the longest set it could have.
   */
  evidenceRequired: boolean;
}

/**
 * How each unmet condition is spelled in the table. Each one names the first
 * missing thing, because "unproven" alone leaves the reader to guess which of
 * five conditions failed.
 */
const GAPS: Record<CaseGap, string> = {
  noTestPlanned: "no test cites it",
  testMissing: "its test never appeared in the tree",
  suitesNotGreen: "a suite is red",
  noEvidence: "no artifact from the running software names it",
};

/**
 * What PASS meant in this run, spelled under the table.
 *
 * Two versions because the conditions genuinely differ, and printing the longer
 * one for a change that was never deployed would be the report claiming a
 * check that nobody made.
 */
const PASS_MEANS = {
  deployed: [
    "_PASS is earned three times over: a test naming the case exists in the tree, every suite that_",
    "_answered is green, and an artifact made against the running software names the case. Anything_",
    "_less says what is missing — this table never guesses in the reader's favour._",
  ],
  suitesOnly: [
    "_PASS is earned twice over: a test naming the case exists in the tree, and every suite that_",
    "_answered is green. This run agreed the change needed no deployment to be believed, so no_",
    "_artifact from running software was asked of it. Anything less says what is missing._",
  ],
} as const;

/** One outcome as the table spells it, with the reason where there is one. */
function mark(verdict: CaseVerdict | undefined): string {
  if (verdict === undefined) return "unproven";
  if (verdict.outcome === "passed") return "PASS";
  if (verdict.outcome === "failed") return "FAIL";
  return verdict.gap === null ? "unproven" : `unproven — ${GAPS[verdict.gap]}`;
}

/**
 * The whole report, as Markdown.
 *
 * Pure on purpose: the hardest thing to get right here is what the table is
 * allowed to claim, and that is exactly the kind of thing worth having tests
 * for.
 */
export function renderReport(input: ReportInput): string {
  const { run, brief, solution, cases, plan, review, verdict, outcomes, evidence } = input;
  const { evidenceRequired } = input;
  const lines: string[] = [
    `# Task run — ${run?.itemTitle ?? ""}`,
    "",
    `Item: ${run?.itemId ?? "—"} · Branch: \`${run?.branch ?? "—"}\``,
  ];
  if (brief !== null) {
    lines.push("", `## What was asked`, "", brief.goal, "");
    for (const criterion of brief.criteria) lines.push(`- **${criterion.id}** ${criterion.text}`);
    const assumed = brief.questions.filter((question) => question.blocking);
    if (assumed.length > 0) {
      lines.push("", "Decided by the run rather than by the ticket:");
      for (const question of assumed) lines.push(`- ${question.text}`);
    }
  }
  if (solution !== null) {
    lines.push("", "## How", "", solution.how, "", `_Why this way:_ ${solution.why}`);
    if (solution.decisions.length > 0) {
      lines.push("", "What it locks in:");
      for (const decision of solution.decisions) lines.push(`- ${decision}`);
    }
  }
  if (cases !== null) {
    lines.push(
      "",
      "## Test cases",
      "",
      "| Case | Criterion | Then | Proved by | Test | Result |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const one of cases.cases) {
      const test = (plan?.tests ?? []).find((candidate) => candidate.case === one.id);
      lines.push(
        `| ${one.id} | ${one.criterion} | ${cell(one.then)} | ${cell(one.prove)} | ${cell(test?.file ?? "—")} | ${mark(
          outcomes.get(one.id),
        )} |`,
      );
    }
    lines.push("", ...(evidenceRequired ? PASS_MEANS.deployed : PASS_MEANS.suitesOnly));
  }
  if (verdict !== null) {
    lines.push(
      "",
      "## Suites",
      "",
      "| Suite | Newly broken | Already red | Repaired |",
      "| --- | --- | --- | --- |",
    );
    for (const suite of verdict.suites) {
      const counts = [
        suite.comparison.broken.length,
        suite.comparison.alreadyBroken.length,
        suite.comparison.repaired.length,
      ].map(String);
      lines.push(`| ${cell(suite.label)} | ${counts.join(" | ")} |`);
    }
    for (const quiet of verdict.silent) lines.push(`| ${cell(quiet.label)} | — | — | stopped answering |`);
  }
  if (review !== null && (review.risks.length > 0 || review.findings.length > 0)) {
    lines.push("", "## Review");
    if (review.risks.length > 0) {
      lines.push("", "Risks it looked for:");
      for (const risk of review.risks) lines.push(`- ${risk}`);
    }
    if (review.findings.length > 0) {
      lines.push("", "Findings:");
      for (const finding of review.findings) {
        lines.push(
          `- \`${finding.file}:${String(finding.line)}\` **${finding.severity} · ${finding.kind}** — ${finding.message}`,
        );
      }
    }
  }
  if (evidence.length > 0) {
    lines.push("", "## Evidence the suites left behind", "");
    for (const file of evidence) lines.push(`- \`${file}\``);
  }
  return `${lines.join("\n")}\n`;
}

/** One table cell: a pipe inside it would silently split the row in two. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
