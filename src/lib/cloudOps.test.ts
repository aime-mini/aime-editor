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

describe("opsPrompt on Azure", () => {
  it("speaks `az`, names its own flags, and refuses its own groups", () => {
    const prompt = opsPrompt("azure", "Microsoft.Web/sites");
    expect(prompt).toContain("Azure resource of type `Microsoft.Web/sites`");
    expect(prompt).toContain("after `az`");
    expect(prompt).toContain("`--subscription` and `--output`");
    expect(prompt).toContain("`rest` or `interactive`");
    // gcloud's flag family does not exist here, so the keep rule is the one
    // about naming what is being changed.
    expect(prompt).toContain("names that setting");
    expect(prompt).not.toContain("--update-*");
    expect(prompt).not.toContain("gcloud");
  });

  /**
   * Measured in the app 2026-09-17: with only `<name>` and `<region>` to write
   * against, the AI invented `<resource-group>` for a Web App - nothing on
   * Azure is addressable without one - and the checker refused all six
   * operations with *holds something a shell could misread*.
   */
  it("offers the group placeholder, because nothing on Azure is addressable without it", () => {
    const prompt = opsPrompt("azure", "Microsoft.Web/sites");
    expect(prompt).toContain("<group>");
    expect(prompt).toContain("its resource group");
    expect(prompt).toContain("never a placeholder of your own");

    const restart = {
      label: "Restart the web app",
      changes: "Restarts it",
      writes: true,
      args: ["webapp", "restart", "--name", "<name>", "--resource-group", "<group>"],
    };
    const site = { name: "web", cliName: "web", location: "southeastasia", group: "rg-web" };
    expect(fillOp(restart, site)).toEqual([
      "webapp",
      "restart",
      "--name",
      "web",
      "--resource-group",
      "rg-web",
    ]);
    expect(fillable(restart, site)).toBe(true);
    // A resource with no group cannot have that operation run against it, and
    // saying so beats sending `--resource-group` with nothing after it.
    expect(fillable(restart, { ...site, group: "" })).toBe(false);
  });

  /** The same slip the read plans were fixed for in session 34. */
  it("addresses a resource by the name its CLI takes, not the label a person reads", () => {
    const op = {
      label: "Read it",
      changes: "nothing",
      writes: false,
      args: ["iam", "service-accounts", "describe", "<name>"],
    };
    expect(
      fillOp(op, {
        name: "Default compute service account",
        cliName: "130881371924-compute@developer.gserviceaccount.com",
        location: "",
        group: "shop-prod",
      }),
    ).toEqual(["iam", "service-accounts", "describe", "130881371924-compute@developer.gserviceaccount.com"]);
  });

  it("pins the subscription on the command a person confirms, and no account flag", () => {
    const restart = {
      label: "Restart the app",
      changes: "Restarts the web app",
      writes: true,
      args: ["webapp", "restart", "--name", "<name>", "--resource-group", "rg-web"],
    };
    expect(
      opCommand(
        "azure",
        fillOp(restart, { name: "web", location: "southeastasia" }),
        "sub-1",
        "me@example.com",
      ),
    ).toBe("az webapp restart --name web --resource-group rg-web --subscription sub-1");
  });
});

/**
 * AWS was measured for the command line only (2026-09-18): the panel works on
 * what is already there, and Aime does not plan a deployment for it.
 */
describe("opsPrompt on AWS", () => {
  it("speaks `aws`, and names the two things only this CLI needs said", () => {
    const prompt = opsPrompt("aws", "ecs/service");
    expect(prompt).toContain("AWS resource of type `ecs/service`");
    expect(prompt).toContain("after `aws`");
    expect(prompt).toContain("`--profile` and `--output`");
    expect(prompt).not.toContain("gcloud");
    expect(prompt).not.toContain("--subscription");

    // Aime pins the profile and NOT the region, so the prompt has to say so:
    // a command without `--region` runs wherever the profile happens to point.
    expect(prompt).toContain("Aime does NOT add this one");
    expect(prompt).toContain("<region>");

    // Every rule the Rust checker enforces has to be one the AI was told:
    // `cloud/dialect.rs` refuses these four by name inside groups it allows.
    expect(prompt).toContain("ssm start-session");
    expect(prompt).toContain("ecs execute-command");
    // Measured in the app 2026-09-18: the AI answered `tail` and
    // `delete-log-group` with no service word, and the CLI has neither.
    expect(prompt).toContain("`<service> <operation>`");
    expect(prompt).toContain("`aws tail` is not a command");
    expect(prompt).toContain("`configure`, `sso`, `iam`, `sts`");
  });

  it("says what `<group>` means here, because AWS has no resource group", () => {
    const prompt = opsPrompt("aws", "ecs/service");
    expect(prompt).toContain("the AWS account number");
    expect(prompt).not.toContain("resource group");
  });
});

describe("opsPrompt", () => {
  it("states the rules Aime enforces, so a refused answer is the AI's to avoid", () => {
    const prompt = opsPrompt("gcp", "run.googleapis.com/Service");
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

  /**
   * Measured in the app 2026-09-21: asked about a Supabase database with no
   * vocabulary in front of it, the AI answered three operations under a
   * `postgres` group that does not exist, and the pane ended up empty. A CLI
   * that lists its own groups now says them in the question.
   */
  it("carries the CLI's own command groups when there are any, and says nothing when there are not", () => {
    const groups = ["branches", "db", "functions", "postgres-config", "secrets"];
    const told = opsPrompt("supabase", "supabase/database", groups);
    expect(told).toContain("`postgres-config`");
    expect(told).toContain("A first word outside that list does not exist");
    expect(told).not.toContain("`postgres`,");

    const untold = opsPrompt("gcp", "run.googleapis.com/Service");
    expect(untold).not.toContain("lists about itself");
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
    expect(opCommand("gcp", fillOp(logs, service), "shop-prod", "dev@example.com")).toBe(
      "gcloud run services logs read shop-web --region asia-southeast1 --limit 100 " +
        "--project shop-prod --account dev@example.com",
    );
  });

  it("is not offered when the resource has no region to fill in", () => {
    expect(fillable(logs, service)).toBe(true);
    expect(fillable(logs, { name: "global-thing", location: "" })).toBe(false);
  });
});

/**
 * Measured in the app 2026-09-18 on an AWS log group: four of six operations
 * were thrown away for `<start>`, `<days>` and `<filter-name>`. The prompt
 * forbade an invented placeholder without saying what to write instead.
 */
describe("a value Aime cannot fill in", () => {
  it("is asked for as a real default on every cloud, not as a placeholder", () => {
    for (const cloud of ["gcp", "azure", "aws"]) {
      const prompt = opsPrompt(cloud, "some/kind");
      expect(prompt).toContain("Those three are the ONLY placeholders");
      expect(prompt).toContain("REAL, sensible default");
      expect(prompt).toContain("`--retention-in-days`, `30`");
    }
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
