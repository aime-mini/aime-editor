import { describe, expect, it } from "vitest";
import { buildReadPlanPrompt, commandLabel, commandOf, parseReadPlan } from "./cloudReads";

describe("planning how a kind of cloud resource is read", () => {
  it("shows the model the shape of an identifier, never the resource", () => {
    const prompt = buildReadPlanPrompt(
      "aws",
      "lambda/function",
      "arn:aws:lambda:ap-southeast-2:123456789012:function:PaymentPlan-Resolver",
      null,
    );
    expect(prompt).toContain("arn:aws:lambda:ap-southeast-2:<account>:function:<name>");
    expect(prompt).not.toContain("123456789012");
    expect(prompt).not.toContain("PaymentPlan-Resolver");

    const azure = buildReadPlanPrompt(
      "azure",
      "Microsoft.Web/sites",
      "/subscriptions/0000-1111/resourceGroups/shop-prod/providers/Microsoft.Web/sites/shop-api",
      null,
    );
    expect(azure).toContain(
      "/subscriptions/<subscription>/resourceGroups/<group>/providers/Microsoft.Web/sites/<name>",
    );
    expect(azure).not.toContain("shop-api");
    // Azure's generic read is seeded by Aime, so the model is told not to repeat it.
    expect(azure).toContain("do NOT repeat it");

    const gcp = buildReadPlanPrompt(
      "gcp",
      "compute.googleapis.com/Instance",
      "//compute.googleapis.com/projects/shop-prod-1234/zones/asia-southeast1-b/instances/web-1",
      null,
    );
    expect(gcp).toContain(
      "//compute.googleapis.com/projects/<project>/zones/asia-southeast1-b/instances/<name>",
    );
    expect(gcp).not.toContain("shop-prod-1234");
    expect(gcp).not.toContain("web-1");
    // The two facts about gcloud that decide whether a planned command runs.
    expect(gcp).toContain("`<path>`");
    expect(gcp).toContain("never `--zone=<region>`");
    // Measured on a real project: the project itself takes the bare id.
    expect(gcp).toContain("`projects describe <group>`");
    expect(gcp).toContain("Aime itself adds `--project` and `--format json`");
  });

  it("hands the model the CLI's own catalogue, required flags marked", () => {
    const prompt = buildReadPlanPrompt(
      "aws",
      "secretsmanager/secret",
      "arn:aws:secretsmanager:r:0:secret:x",
      {
        service: "secretsmanager",
        operations: [
          { command: "describe-secret", flags: ["--secret-id"], required: ["--secret-id"] },
          { command: "get-secret-value", flags: ["--secret-id", "--version-id"], required: ["--secret-id"] },
        ],
      },
    );
    expect(prompt).toContain("describe-secret: --secret-id*");
    expect(prompt).toContain("get-secret-value: --secret-id* --version-id");
  });

  /**
   * The shape a real reply takes: fenced, with an apology before it, and one
   * entry that is not usable. Only the complete entries survive.
   */
  it("keeps the complete reads and drops the rest, without throwing on prose", () => {
    const reply = [
      "Here is the plan:",
      "```json",
      JSON.stringify({
        reads: [
          {
            purpose: "overview",
            label: "aws lambda get-function",
            args: ["lambda", "get-function", "--function-name", "<name>"],
          },
          { purpose: "connection", args: ["lambda", "get-function-url-config", "--function-name", "<name>"] },
          { purpose: "delete", label: "nope", args: ["lambda", "delete-function"] },
          { purpose: "secret", label: "empty", args: [] },
          { purpose: "secret", label: "mixed", args: ["lambda", 42] },
        ],
      }),
      "```",
    ].join("\n");

    expect(parseReadPlan(reply)).toEqual([
      {
        purpose: "overview",
        label: "aws lambda get-function",
        args: ["lambda", "get-function", "--function-name", "<name>"],
      },
      // A missing label is the command itself.
      {
        purpose: "connection",
        label: "lambda get-function-url-config --function-name <name>",
        args: ["lambda", "get-function-url-config", "--function-name", "<name>"],
      },
    ]);
    expect(parseReadPlan("I could not work it out.")).toEqual([]);
    expect(parseReadPlan('{"reads": "none"}')).toEqual([]);
  });

  it("writes the command a person can copy exactly as Aime runs it", () => {
    const resource = {
      id: "arn:aws:sqs:ap-southeast-2:000000000000:orders",
      name: "orders",
      group: "000000000000",
      location: "ap-southeast-2",
    };
    const read = {
      purpose: "overview" as const,
      label: "aws sqs get-queue-attributes",
      args: [
        "sqs",
        "get-queue-attributes",
        "--queue-url",
        "https://sqs.<region>.amazonaws.com/<group>/<name>",
      ],
    };
    expect(commandOf("aws", "prod", resource, read)).toBe(
      "aws sqs get-queue-attributes --queue-url https://sqs.ap-southeast-2.amazonaws.com/000000000000/orders --profile prod --region ap-southeast-2 --output json",
    );
    expect(
      commandOf(
        "azure",
        "sub-1",
        {
          id: "/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/sites/my site",
          name: "my site",
          group: "g",
          location: "",
        },
        { purpose: "overview", label: "az resource show", args: ["resource", "show", "--ids", "<id>"] },
      ),
    ).toBe(
      'az resource show --ids "/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/sites/my site" --subscription sub-1 --output json',
    );
    // `<path>` is the full resource name without its service head - what every
    // `gcloud … describe` takes - and gcloud is scoped by project and `--format`.
    expect(
      commandOf(
        "gcp",
        "shop-prod-1234",
        {
          id: "//compute.googleapis.com/projects/shop-prod-1234/zones/asia-southeast1-b/instances/web-1",
          name: "web-1",
          group: "shop-prod-1234",
          location: "asia-southeast1-b",
        },
        {
          purpose: "overview",
          label: "gcloud compute instances describe",
          args: ["compute", "instances", "describe", "<path>"],
        },
      ),
    ).toBe(
      "gcloud compute instances describe projects/shop-prod-1234/zones/asia-southeast1-b/instances/web-1 --project shop-prod-1234 --format json",
    );
    // Supabase is scoped by project ref and asked for JSON with `-o`.
    expect(
      commandOf(
        "supabase",
        "abcdefghijklmnopqrst",
        {
          id: "supabase://abcdefghijklmnopqrst/database",
          name: "db.x.supabase.co",
          group: "abcdefghijklmnopqrst",
          location: "",
        },
        { purpose: "overview", label: "supabase postgres-config get", args: ["postgres-config", "get"] },
      ),
    ).toBe("supabase postgres-config get --project-ref abcdefghijklmnopqrst -o json");
  });

  /** The terminal gets the quoted path; the button gets the program's name. */
  it("labels a sign-in command by its program, whatever path runs it", () => {
    expect(
      commandLabel(String.raw`& "C:\Users\John Smith\AppData\Roaming\aime\cloud-clis\supabase.exe" login`),
    ).toBe("supabase login");
    expect(commandLabel('"/home/john/.local/share/aime/cloud-clis/supabase" login')).toBe("supabase login");
    expect(commandLabel("gcloud auth login --no-launch-browser")).toBe(
      "gcloud auth login --no-launch-browser",
    );
  });

  it("shows the model a Supabase identifier without the project or the name", () => {
    const prompt = buildReadPlanPrompt(
      "supabase",
      "supabase/function",
      "supabase://abcdefghijklmnopqrst/functions/resize",
      null,
    );
    expect(prompt).toContain("supabase://<project>/functions/<name>");
    expect(prompt).not.toContain("abcdefghijklmnopqrst");
    expect(prompt).not.toContain("resize");
    expect(prompt).toContain("Aime itself adds `--project-ref` and `-o json`");
    expect(prompt).toContain("`projects api-keys` carries keys and is a secret");
  });
});
