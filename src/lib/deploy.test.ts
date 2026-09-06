import { describe, expect, it } from "vitest";
import type { CloudAccount, CloudResource } from "../stores/cloud";
import {
  commandLine,
  overwritten,
  parsePlan,
  parseRevision,
  parseSurvey,
  planPrompt,
  readLine,
  surveyPrompt,
  urlIn,
  valueAt,
  type KeepRead,
  type Survey,
} from "./deploy";

/**
 * The deploy library is the contract between three parties that never meet:
 * the prompt the AI reads, the JSON it answers, and the Rust checker that gets
 * the parsed result. These tests pin the two ends Aime owns.
 */

const account: CloudAccount = {
  id: "my-project",
  label: "My Project",
  detail: "my-project",
  current: false,
  owner: "dev@example.com",
  tenant: "",
  signIn: "gcloud auth login dev@example.com",
};

const service: CloudResource = {
  id: "//run.googleapis.com/projects/my-project/locations/asia-southeast1/services/web",
  name: "web",
  kind: "run.googleapis.com/Service",
  location: "asia-southeast1",
  group: "my-project",
  tags: { app: "shop" },
};

const survey: Survey = {
  app: {
    name: "shop",
    kind: "web",
    stack: "Node 20 / Express",
    port: 8080,
    healthPath: "/healthz",
    builds: "Dockerfile",
  },
  existing: [{ resourceId: service.id, role: "the service", evidence: "cloudbuild.yaml deploys to web" }],
  inspect: [],
  missing: [],
};

describe("the survey prompt", () => {
  it("carries the inventory as the panel shows it, the tooling, and the CLI's grammar", () => {
    const prompt = surveyPrompt({ inventory: [service], tooling: [] });
    expect(prompt).toContain("run/Service  web  asia-southeast1  app=shop");
    expect(prompt).toContain(service.id);
    expect(prompt).toContain("docker is NOT installed");
    expect(prompt).toContain("A flag and its value are two tokens");
    expect(prompt).toContain("never include them");
    expect(prompt).toContain('"inspect":[');
  });

  it("says so when the project holds nothing", () => {
    expect(surveyPrompt({ inventory: [], tooling: ["docker"] })).toContain(
      "the project holds no resources yet",
    );
  });
});

describe("the plan prompt", () => {
  it("names the keep rule, the read answers and what was refused last time", () => {
    const prompt = planPrompt({
      survey,
      answers: [{ label: "gcloud run services describe", json: '{"spec":{}}', ok: true }],
      tooling: [],
      rejected: [
        {
          part: "step",
          label: "Set variables",
          reason: "`--set-env-vars` replaces what the running service already has",
        },
      ],
    });
    expect(prompt).toContain("Already in the project:");
    expect(prompt).toContain("### gcloud run services describe");
    expect(prompt).toContain("`--set-*`, `--clear-*` and `--remove-*` replace or wipe");
    expect(prompt).toContain("do not repeat any of these");
    expect(prompt).toContain("step `Set variables`");
  });
});

describe("reading the answers", () => {
  it("reads a survey out of a reply with prose around the JSON", () => {
    const reply = `Here is my analysis:\n{"app":{"name":"shop","kind":"web","stack":"Node","port":8080,"healthPath":"healthz","builds":"Dockerfile"},"existing":[{"resourceId":"${service.id}","role":"the service","evidence":"name"}],"inspect":[{"label":"describe","args":["run","services","describe","web","--region","asia-southeast1"]}],"missing":["the region"]}\nHope that helps.`;
    const parsed = parseSurvey(reply);
    expect(parsed?.app.port).toBe(8080);
    expect(parsed?.existing).toHaveLength(1);
    expect(parsed?.inspect[0]).toEqual({
      purpose: "overview",
      label: "describe",
      args: ["run", "services", "describe", "web", "--region", "asia-southeast1"],
    });
    expect(parsed?.missing).toEqual(["the region"]);
  });

  it("answers null for a reply that says nothing about the app", () => {
    expect(parseSurvey("I could not read the repository.")).toBeNull();
    expect(parseSurvey('{"existing":[]}')).toBeNull();
  });

  it("reads a plan, defaulting the proof to a 200 on a leading-slash path", () => {
    const plan = parsePlan(
      JSON.stringify({
        summary: "Deploy shop to Cloud Run",
        target: { existing: true, resourceId: service.id, region: "asia-southeast1" },
        proposal: null,
        keep: [
          {
            label: "environment variables",
            read: {
              label: "describe",
              args: ["run", "services", "describe", "web", "--region", "asia-southeast1"],
            },
            path: "spec.template.spec.containers.0.env",
          },
        ],
        steps: [
          { label: "Deploy", args: ["run", "deploy", "web", "--source", "."], changes: "a new revision" },
        ],
        files: [{ path: "Dockerfile", why: "none exists" }],
        prove: {
          read: { label: "describe", args: ["run", "services", "describe", "web"] },
          urlPath: "status.url",
          path: "healthz",
        },
      }),
    );
    expect(plan?.target.existing).toBe(true);
    expect(plan?.keep[0].path).toBe("spec.template.spec.containers.0.env");
    expect(plan?.prove).toMatchObject({ urlPath: "status.url", path: "/healthz", expect: 200 });
    expect(plan?.files).toEqual([{ path: "Dockerfile", why: "none exists" }]);
  });

  it("refuses a plan with no steps, and a keep with no path", () => {
    expect(parsePlan('{"summary":"nothing","steps":[]}')).toBeNull();
    const plan = parsePlan(
      '{"steps":[{"args":["run","deploy","web"]}],"keep":[{"label":"x","read":{"args":["run","services","describe","web"]}}]}',
    );
    expect(plan?.keep).toEqual([]);
    expect(plan?.steps[0].label).toBe("run deploy web");
  });

  it("reads a revision that only gives up, and none at all from an empty one", () => {
    expect(parseRevision('{"steps":[],"giveUp":"billing is not enabled"}')?.giveUp).toBe(
      "billing is not enabled",
    );
    expect(parseRevision('{"steps":[],"files":[],"inspect":[],"giveUp":null}')).toBeNull();
  });
});

describe("paths into an answer", () => {
  const document = {
    status: { url: "https://web-abc.a.run.app" },
    spec: { containers: [{ env: [{ name: "A", value: "1" }] }] },
  };

  it("walks keys and array indexes", () => {
    expect(valueAt(document, "spec.containers.0.env.0.name")).toBe("A");
    expect(valueAt(document, "spec.containers.9")).toBeUndefined();
    expect(valueAt(document, "status.url.deeper")).toBeUndefined();
  });

  it("takes a URL only when the value is one", () => {
    expect(urlIn(JSON.stringify(document), "status.url")).toBe("https://web-abc.a.run.app");
    expect(urlIn(JSON.stringify(document), "spec")).toBeNull();
    expect(urlIn("not json", "status.url")).toBeNull();
  });
});

describe("the settings promised to stay", () => {
  const keep: KeepRead = {
    label: "environment variables",
    read: { purpose: "overview", label: "describe", args: ["run", "services", "describe", "web"] },
    path: "spec.template.spec.containers.0.env",
  };
  const before = {
    spec: { template: { spec: { containers: [{ env: [{ name: "A", value: "1" }], image: "old" }] } } },
  };

  it("is not fooled by key order or by fields outside the path", () => {
    const after = {
      spec: { template: { spec: { containers: [{ image: "new", env: [{ value: "1", name: "A" }] }] } } },
    };
    const lost = overwritten(
      [keep],
      [{ label: "describe", json: JSON.stringify(before), ok: true }],
      [{ label: "describe", json: JSON.stringify(after), ok: true }],
    );
    expect(lost).toEqual([]);
  });

  it("names a setting whose value changed", () => {
    const after = { spec: { template: { spec: { containers: [{ env: [{ name: "A", value: "2" }] }] } } } };
    const lost = overwritten(
      [keep],
      [{ label: "describe", json: JSON.stringify(before), ok: true }],
      [{ label: "describe", json: JSON.stringify(after), ok: true }],
    );
    expect(lost.map((one) => one.label)).toEqual(["environment variables"]);
  });

  it("counts a read that failed on either side as a promise not kept", () => {
    const lost = overwritten(
      [keep],
      [{ label: "describe", json: JSON.stringify(before), ok: true }],
      [{ label: "describe", json: "PERMISSION_DENIED", ok: false }],
    );
    expect(lost).toHaveLength(1);
  });
});

describe("the lines a person reads", () => {
  it("pins the project and the account after the plan's own arguments", () => {
    expect(
      commandLine({ label: "Deploy", args: ["run", "deploy", "web", "--source", "."], changes: "" }, account),
    ).toBe("gcloud run deploy web --source . --project my-project --account dev@example.com");
  });

  it("adds the JSON format to a read, and quotes what needs it", () => {
    expect(
      readLine({ purpose: "overview", label: "d", args: ["run", "services", "describe", "my web"] }, account),
    ).toBe(
      'gcloud run services describe "my web" --project my-project --account dev@example.com --format json',
    );
  });
});
