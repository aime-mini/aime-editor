import { describe, expect, it } from "vitest";
import { destroys, fillOp, fillable, opCommand, opsPrompt, parseOps, sawEmptyList } from "./cloudOps";

/**
 * Captured on 2026-09-09 by piping `opsPrompt("run.googleapis.com/Service")`
 * into Claude Code on this machine (`claude -p --tools Read,Glob,Grep`, so the
 * model had no shell and could not reach any cloud). Verbatim, because a
 * fixture written from memory of the format is a fixture that hides the bug it
 * was meant to catch.
 */
const RUN_SERVICE_REPLY = String.raw`{"ops":[{"label":"Read recent service logs","changes":"Nothing - reads the last log entries for the service.","writes":false,"args":["run","services","logs","read","<name>","--region","<region>","--limit","100"]},{"label":"Update an environment variable","changes":"Sets one env var on the service and rolls out a new revision; other env vars are kept.","writes":true,"args":["run","services","update","<name>","--region","<region>","--update-env-vars","KEY=VALUE"]},{"label":"Send traffic to latest","changes":"Moves 100% of serving traffic to the newest ready revision.","writes":true,"args":["run","services","update-traffic","<name>","--region","<region>","--to-latest"]},{"label":"Change instance scaling","changes":"Sets min and max instance counts, creating a new revision with the new autoscaling bounds.","writes":true,"args":["run","services","update","<name>","--region","<region>","--min-instances","1","--max-instances","10"]},{"label":"Bump CPU and memory","changes":"Changes the per-instance CPU and memory limits and rolls out a new revision.","writes":true,"args":["run","services","update","<name>","--region","<region>","--cpu","1","--memory","512Mi"]},{"label":"List service revisions","changes":"Nothing - lists the service's revisions and their traffic shares.","writes":false,"args":["run","revisions","list","--service","<name>","--region","<region>"]}]}`;

describe("opsPrompt", () => {
  it("states the rules Aime enforces, so a refused answer is the AI's to avoid", () => {
    const prompt = opsPrompt("run.googleapis.com/Service");
    expect(prompt).toContain("run.googleapis.com/Service");
    expect(prompt).toContain("<name>");
    expect(prompt).toContain("--project");
    // Deleting used to be refused outright; it is day-to-day work, so the
    // brief now asks for it and Aime puts the typed name in front of it.
    expect(prompt).toContain("Deleting IS allowed here");
    expect(prompt).toContain("type the resource's own name");
    // The one thing the AI must never be told to do: name a real resource.
    expect(prompt).toContain("never a real name");
  });
});

describe("parseOps", () => {
  it("reads what a real answer for a Cloud Run service holds", () => {
    const ops = parseOps(RUN_SERVICE_REPLY);
    expect(ops).toHaveLength(6);
    expect(ops[0]).toEqual({
      label: "Read recent service logs",
      changes: "Nothing - reads the last log entries for the service.",
      writes: false,
      args: ["run", "services", "logs", "read", "<name>", "--region", "<region>", "--limit", "100"],
    });
    // The writes flag is what decides whether a click runs it or asks first.
    expect(ops.filter((op) => op.writes).map((op) => op.label)).toEqual([
      "Update an environment variable",
      "Send traffic to latest",
      "Change instance scaling",
      "Bump CPU and memory",
    ]);
  });

  it("drops what it cannot read rather than repairing it", () => {
    expect(parseOps("no json here")).toEqual([]);
    expect(parseOps('{"ops":"restart"}')).toEqual([]);
    expect(parseOps('{"ops":[{"label":"","args":["run"]}]}')).toEqual([]);
    expect(parseOps('{"ops":[{"label":"No args"}]}')).toEqual([]);
    expect(parseOps('{"ops":[{"label":"Odd","args":["run",7]}]}')).toEqual([]);
  });

  it("treats an unstated `writes` as a write, which is the safer reading", () => {
    expect(parseOps('{"ops":[{"label":"Patch it","args":["sql","instances","patch","<name>"]}]}')).toEqual([
      { label: "Patch it", changes: "", writes: true, args: ["sql", "instances", "patch", "<name>"] },
    ]);
  });
});

describe("filling an operation in", () => {
  const service = { name: "shop-web", location: "asia-southeast1" };

  /** The log read, which every Cloud Run answer has led with. */
  const logs = parseOps(RUN_SERVICE_REPLY)[0];

  it("puts this resource where the placeholders were", () => {
    expect(fillOp(logs, service)).toEqual([
      "run",
      "services",
      "logs",
      "read",
      "shop-web",
      "--region",
      "asia-southeast1",
      "--limit",
      "100",
    ]);
  });

  it("shows the command with the project and account Aime pins", () => {
    expect(opCommand(fillOp(logs, service), "shop-prod", "dev@example.com")).toBe(
      "gcloud run services logs read shop-web --region asia-southeast1 --limit 100 " +
        "--project shop-prod --account dev@example.com",
    );
  });

  it("is not offered when the resource has no region to fill in", () => {
    expect(fillable(logs, service)).toBe(true);
    expect(fillable(logs, { name: "global-thing", location: "" })).toBe(false);
  });
});

describe("an operation that takes something away", () => {
  it("is recognised from the command itself, not from what the AI called it", () => {
    expect(destroys(["run", "services", "delete", "web"])).toBe(true);
    expect(destroys(["pubsub", "topics", "delete", "orders"])).toBe(true);
    expect(destroys(["run", "services", "remove-iam-policy-binding", "web"])).toBe(true);
    expect(destroys(["compute", "instances", "purge", "vm"])).toBe(true);

    expect(destroys(["run", "services", "describe", "web"])).toBe(false);
    expect(destroys(["run", "services", "update", "web", "--update-env-vars", "A=1"])).toBe(false);
    // The word has to be a token of its own: a resource called `delete-me` is
    // not a delete.
    expect(destroys(["run", "services", "describe", "delete-me"])).toBe(false);
  });
});

describe("telling an empty answer apart from an unreadable one", () => {
  it("only calls it empty when the AI really answered an empty list", () => {
    expect(sawEmptyList('{"ops":[]}')).toBe(true);
    // A fenced answer with prose around it is still an answer.
    expect(sawEmptyList('Here you go:\n```json\n{"ops": []}\n```')).toBe(true);

    // Reported 2026-09-10: both of these used to read as "Aime could not work
    // out what can be done", which says nothing a person can act on.
    expect(sawEmptyList("I cannot help with that.")).toBe(false);
    expect(sawEmptyList("")).toBe(false);
    expect(sawEmptyList('{"ops": "none"}')).toBe(false);
    expect(sawEmptyList("{ broken json")).toBe(false);
  });
});
