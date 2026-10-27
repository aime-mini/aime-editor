import { DEFAULT_SETTINGS, FLOW_VERSION, type Flow, type Step, type Wire } from "./model";

/**
 * The five flows of the design (screen 11), as starting points: drawn on
 * nothing but the abilities every flow has, which is the proof that the
 * model is wide enough. "Use template" copies one into the project, where
 * it is an ordinary flow from then on.
 */

export interface Template {
  key: string;
  flow: Flow;
}

const step = (
  id: string,
  name: string,
  does: string,
  config: Step["config"],
  extra: Partial<Step> = {},
): Step => ({
  id,
  name,
  does,
  config,
  onError: "stop",
  retries: config.ability === "ai" || config.ability === "http" ? 1 : 0,
  ...extra,
});
const input = (): Step => step("input", "Input", "", { ability: "input" });
const wire = (from: string, to: string, port = "out", maxRounds?: number): Wire => ({
  from,
  port,
  to,
  maxRounds,
});
const flow = (
  name: string,
  description: string,
  hints: Flow["input"]["hints"],
  steps: Step[],
  wires: Wire[],
): Flow => ({
  version: FLOW_VERSION,
  name,
  description,
  input: { hints },
  steps: [input(), ...steps],
  wires,
  settings: { ...DEFAULT_SETTINGS },
});

export const TEMPLATES: Template[] = [
  {
    key: "review-pr",
    flow: flow(
      "Review a PR against the checklist",
      "The PR's diff, the repository's review checklist, one AI read per item, one review posted as a comment.",
      [{ name: "PR or branch", kind: "pr" }],
      [
        step("diff", "Diff of the PR", "", { ability: "git", action: "diff" }),
        step("checklist", "Review checklist", "", {
          ability: "files",
          globs: ["docs/REVIEW.md", "REVIEW.md", "CONTRIBUTING.md"],
        }),
        step(
          "review",
          "Review each item",
          'Review the diff below against the checklist. Answer with JSON: {"findings": [{"item": "...", "severity": "high|medium|low", "where": "file:line", "note": "..."}]}. Only real problems; an item that passes is not listed.',
          { ability: "ai", permission: "readOnly", tools: "filesOnly", json: true },
        ),
        step("merge", "Merge into one review", "", {
          ability: "transform",
          program:
            '"## Review\\n\\n" + ([.review.value.findings[] | "- **" + .severity + "** " + .where + ": " + .note] | join("\\n"))',
        }),
        step("comment", "Comment on the PR", "", {
          ability: "git",
          action: "pr",
          title: "Review",
          body: "{{merge.value}}",
        }),
      ],
      [
        wire("input", "diff"),
        wire("input", "checklist"),
        wire("diff", "review"),
        wire("checklist", "review"),
        wire("review", "merge"),
        wire("merge", "comment"),
      ],
    ),
  },
  {
    key: "release-notes",
    flow: flow(
      "Release notes",
      "The commits since a tag, written up by the AI, approved by you, written into CHANGELOG.md, committed.",
      [{ name: "from", note: "the tag or commit to start from", default: "latest tag" }],
      [
        step("log", "Commits since the tag", "", { ability: "git", action: "log", count: 100 }),
        step(
          "write",
          "Write the notes",
          "Write release notes from the commits below, grouped as Added / Changed / Fixed, in plain language for users of the product. Start from {{input.params.from}}.",
          { ability: "ai", permission: "readOnly", tools: "filesOnly" },
        ),
        step("approve", "Approve the notes", "Are these release notes right? Edit them if not.", {
          ability: "human",
          mode: "edit",
        }),
        step(
          "changelog",
          "Write CHANGELOG.md",
          "Put this at the top of CHANGELOG.md under a new version heading, keeping what is there below it:\n\n{{approve.value}}",
          { ability: "ai", permission: "edits", tools: "filesOnly" },
        ),
        step("commit", "Commit", "", { ability: "git", action: "commit", message: "docs: release notes" }),
      ],
      [
        wire("input", "log"),
        wire("log", "write"),
        wire("write", "approve"),
        wire("approve", "changelog"),
        wire("changelog", "commit"),
      ],
    ),
  },
  {
    key: "triage",
    flow: flow(
      "Triage new tickets",
      "The board's open tickets, each classified by a light model; the urgent ones commented at once, the rest reported.",
      [],
      [
        step("tickets", "Open tickets", "", { ability: "service", door: "tracker", action: "list" }),
        step(
          "classify",
          "Classify each ticket",
          'Classify this ticket. Answer with JSON: {"id": "...", "priority": "P1|P2|P3", "area": "...", "reason": "one sentence"}.',
          { ability: "ai", permission: "readOnly", tools: "filesOnly", json: true },
          { forEach: true, onError: "skipItems" },
        ),
        step("urgent", "Any P1?", "", {
          ability: "gate",
          branches: [
            { label: "urgent", program: '[.classify.value[] | select(.priority == "P1")] | length > 0' },
            { label: "calm", program: "true" },
          ],
        }),
        step(
          "report",
          "Report",
          "Write a short triage report from the classifications: counts per priority, the P1s with their reasons, and what to do first.",
          {
            ability: "ai",
            permission: "readOnly",
            tools: "filesOnly",
          },
        ),
      ],
      [
        wire("input", "tickets"),
        wire("tickets", "classify"),
        wire("classify", "urgent"),
        wire("urgent", "report", "urgent"),
        wire("urgent", "report", "calm"),
      ],
    ),
  },
  {
    key: "dependency-update",
    flow: flow(
      "Update a dependency",
      "Update, run the tests, let the AI fix what broke (three rounds at most), open a PR, wait for CI, ask before merging.",
      [{ name: "package", note: "the package to update, or 'all minor'" }],
      [
        step(
          "update",
          "Update the package",
          "Update {{input.params.package}} with the project's package manager (npm, dotnet, pip - whichever this project uses). Change only lockfile and manifest.",
          {
            ability: "ai",
            permission: "edits",
          },
        ),
        step(
          "test",
          "Run the tests",
          "Run the project's tests",
          { ability: "command", command: { all: [] } },
          { onError: "errorWire" },
        ),
        step(
          "fix",
          "Fix what broke",
          "The tests failed with the output below. Fix the code or the tests so they pass; do not revert the update.\n\n{{test.value.stderr}}\n{{test.value.stdout}}",
          {
            ability: "ai",
            permission: "edits",
          },
        ),
        step("commit", "Commit", "", {
          ability: "git",
          action: "commit",
          message: "chore: update {{input.params.package}}",
        }),
        step("pr", "Open a PR", "", {
          ability: "git",
          action: "pr",
          title: "Update {{input.params.package}}",
          body: "Automated update; tests pass.",
          base: "main",
        }),
        step("ci", "Wait for CI", "", { ability: "wait", seconds: 60 }),
        step("merge", "Merge?", "CI has had a minute. Merge this PR?", { ability: "human", mode: "approve" }),
      ],
      [
        wire("input", "update"),
        wire("update", "test"),
        wire("test", "fix", "error"),
        wire("fix", "test", "out", 3),
        wire("test", "commit"),
        wire("commit", "pr"),
        wire("pr", "ci"),
        wire("ci", "merge"),
      ],
    ),
  },
  {
    key: "api-docs",
    flow: flow(
      "Generate API docs",
      "The endpoints of the code, one page each written by a light model, filed under docs/api, mailed to the team.",
      [{ name: "folder", note: "where the API code lives", default: "src" }],
      [
        step(
          "endpoints",
          "List the endpoints",
          'List every HTTP endpoint defined under {{input.params.folder}}. Answer with JSON: {"endpoints": [{"method": "GET", "path": "/x", "file": "...", "summary": "..."}]}.',
          { ability: "ai", permission: "readOnly", tools: "filesOnly", json: true },
        ),
        step("each", "One list", "", { ability: "transform", program: ".endpoints.value.endpoints" }),
        step(
          "pages",
          "Write a page per endpoint",
          "Write a Markdown page for this endpoint - what it does, parameters, responses, an example - into docs/api/<method>-<path-as-slug>.md:\n\n{{item.value}}",
          { ability: "ai", permission: "edits", tools: "filesOnly" },
          { forEach: true, onError: "skipItems" },
        ),
        step("mail", "Mail the team", "", {
          ability: "mail",
          connection: "",
          to: [],
          subject: "API docs regenerated",
          body: "The API docs were regenerated: {{pages.summary}}.",
        }),
      ],
      [wire("input", "endpoints"), wire("endpoints", "each"), wire("each", "pages"), wire("pages", "mail")],
    ),
  },
];
