import { describe, expect, it } from "vitest";
import {
  factFor,
  buildReadPlanPrompt,
  buildReadRepairPrompt,
  commandLabel,
  commandOf,
  parseReadPlan,
  withPlaceholders,
} from "./cloudReads";

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
          { purpose: "overview", label: "bq show", args: ["show", "<name>"], program: "bq" },
          { purpose: "overview", label: "odd program", args: ["show", "<name>"], program: 7 },
          { purpose: "delete", label: "nope", args: ["lambda", "delete-function"] },
          { purpose: "secret", label: "empty", args: [] },
          { purpose: "secret", label: "mixed", args: ["lambda", 42] },
        ],
      }),
      "```",
    ].join("\n");

    expect(parseReadPlan(reply)).toEqual({
      reads: [
        {
          purpose: "overview",
          label: "aws lambda get-function",
          args: ["lambda", "get-function", "--function-name", "<name>"],
          program: "",
        },
        // A missing label is the command itself.
        {
          purpose: "connection",
          label: "lambda get-function-url-config --function-name <name>",
          args: ["lambda", "get-function-url-config", "--function-name", "<name>"],
          program: "",
        },
        // A second CLI survives the parse; whether it may be used for this
        // kind is Rust's answer (`reads.rs: program_of`), not this one's.
        { purpose: "overview", label: "bq show", args: ["show", "<name>"], program: "bq" },
        // Anything that is not a name is no name at all.
        { purpose: "overview", label: "odd program", args: ["show", "<name>"], program: "" },
      ],
      facts: [],
    });
    expect(parseReadPlan("I could not work it out.")).toEqual({ reads: [], facts: [] });
    expect(parseReadPlan('{"reads": "none"}')).toEqual({ reads: [], facts: [] });
  });

  /**
   * A fact is what a developer pastes, worked out from the resource itself.
   * Measured 2026-09-10: for Pub/Sub topics, buckets and App Engine apps -
   * a large share of a real account - that IS the connection detail, and Aime
   * already holds every part of it, so no command should run for it.
   */
  it("keeps the connection facts beside the reads, and fills them per resource", () => {
    const reply = JSON.stringify({
      reads: [],
      facts: [
        { label: "Topic path", value: "projects/<group>/topics/<name>" },
        { label: " Bucket URI ", value: " gs://<name> " },
        { label: "", value: "<name>" },
        { label: "No value", value: "" },
        { label: "Not a string", value: 42 },
      ],
    });
    expect(parseReadPlan(reply).facts).toEqual([
      { label: "Topic path", value: "projects/<group>/topics/<name>" },
      { label: "Bucket URI", value: "gs://<name>" },
    ]);

    const topic = {
      id: "//pubsub.googleapis.com/projects/shop-prod/topics/orders",
      name: "orders",
      group: "shop-prod",
      location: "global",
    };
    expect(factFor({ label: "Topic path", value: "projects/<group>/topics/<name>" }, topic)).toBe(
      "projects/shop-prod/topics/orders",
    );

    // Measured 2026-09-10 on a real API key: the panel shows the display name
    // `Server key 1`, and `<name>` used to fill from it - so the value came out
    // as an identifier with a space in it. `<name>` is the name the CLI takes
    // now, and the same fact reads as the key's own path.
    const apiKey = {
      id: "//apikeys.googleapis.com/projects/872598591707/locations/global/keys/0b1c",
      name: "Server key 1",
      cliName: "0b1c",
      group: "shop-prod",
      location: "",
    };
    const keyPath = { label: "Resource name", value: "projects/<group>/locations/global/keys/<name>" };
    expect(factFor(keyPath, apiKey)).toBe("projects/shop-prod/locations/global/keys/0b1c");

    // A cloud is still free to answer a name with a space in it, and nothing
    // takes one, so the guard stays.
    expect(factFor(keyPath, { ...apiKey, cliName: "" })).toBeNull();

    // Measured in the app 2026-09-11 on a plan stored before `<name>` meant
    // the CLI's name: a service account's name IS its address, so composing
    // another one out of it fills out as two addresses stuck together.
    const serviceAccount = {
      id: "//iam.googleapis.com/projects/p/serviceAccounts/svc@developer.gserviceaccount.com",
      name: "Default compute service account",
      cliName: "svc@developer.gserviceaccount.com",
      group: "p",
      location: "global",
    };
    const composed = { label: "Service account email", value: "<name>@<group>.iam.gserviceaccount.com" };
    expect(factFor(composed, serviceAccount)).toBeNull();
    // The address itself is a fact, and it is shown.
    expect(factFor({ label: "Service account email", value: "<name>" }, serviceAccount)).toBe(
      "svc@developer.gserviceaccount.com",
    );
  });

  /**
   * The real answer, captured 2026-09-10 by running `buildReadPlanPrompt` for
   * this kind through `claude -p --tools Read,Glob,Grep` on this machine. It is
   * here because it is the measurement that justified the prompt change: with
   * the old brief - one `overview` read as the only example, no facts asked for
   * - the same kind answered a single describe and the Connect tab had nothing
   * a developer could paste.
   */
  it("reads the answer a real model gives for a Pub/Sub topic", () => {
    const captured =
      '{"reads":[{"purpose":"overview","label":"gcloud pubsub topics describe","args":["pubsub","topics","describe","<path>"]},' +
      '{"purpose":"connection","label":"gcloud pubsub topics list-subscriptions","args":["pubsub","topics","list-subscriptions","<path>"]}],' +
      '"facts":[{"label":"Topic path","value":"projects/<group>/topics/<name>"},{"label":"Topic name","value":"<name>"},' +
      '{"label":"Publish endpoint","value":"https://pubsub.googleapis.com/v1/projects/<group>/topics/<name>:publish"},' +
      '{"label":"Full identifier","value":"<id>"}]}';
    const plan = parseReadPlan(captured);
    expect(plan.reads.map((read) => read.purpose)).toEqual(["overview", "connection"]);
    expect(plan.facts.map((fact) => fact.label)).toEqual([
      "Topic path",
      "Topic name",
      "Publish endpoint",
      "Full identifier",
    ]);

    const topic = {
      id: "//pubsub.googleapis.com/projects/shop-prod/topics/orders",
      name: "orders",
      group: "shop-prod",
      location: "global",
    };
    expect(plan.facts.map((fact) => factFor(fact, topic))).toEqual([
      "projects/shop-prod/topics/orders",
      "orders",
      "https://pubsub.googleapis.com/v1/projects/shop-prod/topics/orders:publish",
      "//pubsub.googleapis.com/projects/shop-prod/topics/orders",
    ]);
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
    // A BigQuery read runs under `bq`, whose scope is spelled differently and
    // whose flags may not stand after the command's arguments: measured
    // 2026-09-11, `bq show cars --project_id p` answers *FATAL Flags
    // positioning error*, so Aime's own flags go in front.
    expect(
      commandOf(
        "gcp",
        "samplebigquery-428108",
        {
          id: "//bigquery.googleapis.com/projects/samplebigquery-428108/datasets/cars",
          name: "cars",
          group: "samplebigquery-428108",
          location: "US",
        },
        { purpose: "overview", label: "bq show", args: ["show", "<name>"], program: "bq" },
      ),
    ).toBe("bq --project_id samplebigquery-428108 --format prettyjson show cars");
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

  /**
   * The rule the 2026-09-11 measurement produced: `gcloud` is not consistent
   * about what a command is given, and the old brief told the model to pass
   * `<path>` for anything inside a project - which is what put
   * `iam service-accounts describe projects/p/serviceAccounts/…` on disk as the
   * answer for every service account on this machine.
   */
  it("tells the model what Google Cloud commands are actually given, and that Aime will run them", () => {
    const prompt = buildReadPlanPrompt(
      "gcp",
      "iam.googleapis.com/ServiceAccount",
      "//iam.googleapis.com/projects/shop-prod/serviceAccounts/svc@shop-prod.iam.gserviceaccount.com",
      null,
    );
    expect(prompt).toContain("Most take the resource's OWN id");
    expect(prompt).toContain("answers HTTP 404");
    expect(prompt).toContain("`<name>` is the identifier, not the label");
    expect(prompt).toContain("Aime RUNS each read once against a real resource before keeping it");
    expect(prompt).not.toContain("shop-prod");
  });

  it("hands what did not work back with the words that say why, and nothing of the resource", () => {
    const prompt = buildReadRepairPrompt("gcp", "logging.googleapis.com/LogBucket", [
      {
        read: {
          purpose: "overview",
          label: "gcloud logging buckets describe",
          args: ["logging", "buckets", "describe", "<path>", "--location", "<region>"],
        },
        reason: "NOT_FOUND: Bucket `<path>` in location `<region>` does not exist.",
      },
      {
        // Aime's own refusal, which quotes the CLI's synopsis - the answer to
        // the question the model has to answer.
        read: {
          purpose: "secret",
          label: "gcloud iam service-accounts keys list",
          args: ["iam", "service-accounts", "keys", "list", "<name>"],
        },
        reason:
          "`gcloud iam service-accounts keys list` needs `--iam-account`, which this command does " +
          "not pass. Its synopsis: gcloud iam service-accounts keys list --iam-account=IAM_ACCOUNT",
      },
    ]);
    expect(prompt).toContain("gcloud logging buckets describe <path> --location <region>");
    expect(prompt).toContain("NOT_FOUND: Bucket `<path>`");
    expect(prompt).toContain("--iam-account=IAM_ACCOUNT");
    // The purpose travels with it: a secret rewritten as an overview is the
    // credential read gone.
    expect(prompt).toContain("(purpose: secret)");
    expect(prompt).toContain("Keep each read's PURPOSE");
    expect(prompt).toContain("Do not answer with the same command again");
    expect(prompt).toContain("an empty list is a true answer");
    // The one place a Google Cloud read is not a `gcloud` command travels with
    // the repair too: a repair is a fresh call that remembers no earlier prompt.
    expect(prompt).toContain('"program":"bq"');
    expect(prompt).toContain("no other CLI - `gsutil`, `firebase` - can be used here");
  });

  /**
   * The promise the first prompt makes - the AI plans a KIND and never sees one
   * of these resources - has to survive the repair round, where the material is
   * an error message about one real resource.
   */
  it("puts the placeholders back into an error before the AI is shown it", () => {
    const account = {
      id: "//iam.googleapis.com/projects/ai-social/serviceAccounts/130881@developer.gserviceaccount.com",
      name: "Default compute service account",
      cliName: "130881@developer.gserviceaccount.com",
      group: "ai-social",
      location: "global",
    };
    const said =
      "The requested URL /v1/projects/-/serviceAccounts/projects/ai-social/serviceAccounts/" +
      "130881@developer.gserviceaccount.com?alt=json was not found on this server.";
    const redacted = withPlaceholders(said, account);

    expect(redacted).toBe(
      "The requested URL /v1/projects/-/serviceAccounts/<path>?alt=json was not found on this server.",
    );
    expect(redacted).not.toContain("ai-social");
    expect(redacted).not.toContain("130881");
  });

  it("swaps the longest part first, so a project id inside a name goes with the name", () => {
    const bucket = {
      id: "//storage.googleapis.com/shop-prod.appspot.com",
      name: "shop-prod.appspot.com",
      cliName: "shop-prod.appspot.com",
      group: "shop-prod",
      location: "australia-southeast1",
    };
    expect(withPlaceholders("gs://shop-prod.appspot.com in australia-southeast1", bucket)).toBe(
      "gs://<path> in <region>",
    );
  });
});
