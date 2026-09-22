import { describe, expect, it } from "vitest";
import type { CloudAccount, CloudResource } from "../stores/cloud";
import {
  commandLine,
  fixPrompt,
  overwritten,
  parsePlan,
  parseRevision,
  parseSteer,
  parseSurvey,
  planPrompt,
  readLine,
  steerPrompt,
  surveyPrompt,
  urlIn,
  valueAt,
  type DeployPlan,
  type DeployStep,
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
  cliName: "web",
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
    const prompt = surveyPrompt({ cloudId: "gcp", inventory: [service], tooling: [] });
    expect(prompt).toContain("run/Service  web  asia-southeast1  app=shop");
    expect(prompt).toContain(service.id);
    expect(prompt).toContain("docker is NOT installed");
    expect(prompt).toContain("A flag and its value are two tokens");
    expect(prompt).toContain("never include them");
    expect(prompt).toContain('"inspect":[');
  });

  it("says so when the project holds nothing", () => {
    expect(surveyPrompt({ cloudId: "gcp", inventory: [], tooling: ["docker"] })).toContain(
      "the project holds no resources yet",
    );
  });

  /**
   * A step is run by `cloud/deploy.rs: cloud_deploy_step` under the cloud's own
   * CLI and no other, so a Kubernetes plan could create a cluster - billed by
   * the hour - and only then reach a `kubectl` step Aime will not run. The
   * limit is the AI's to plan around, so it has to be told.
   */
  it("names the two programs a step may run, and nothing else, in both prompts", () => {
    for (const prompt of [
      surveyPrompt({ cloudId: "gcp", inventory: [], tooling: [] }),
      planPrompt({ cloudId: "gcp", survey, answers: [], tooling: [], rejected: [], notes: [] }),
    ]) {
      expect(prompt).toContain("A step runs as `gcloud` unless it sets `program` to `kubectl`");
      // The ones a model reaches for when it has a shape neither can deploy.
      for (const refused of ["helm", "terraform", "docker", "a shell"]) {
        expect(prompt).toContain(refused);
      }
      expect(prompt).toContain("what you substituted");
      // And the two things about `kubectl` that a plan gets wrong otherwise.
      expect(prompt).toContain("get-credentials");
      expect(prompt).toContain("gke-gcloud-auth-plugin");
    }
  });
});

describe("the Azure prompts", () => {
  it("speak `az`, and name the walls a subscription has that a project does not", () => {
    const prompt = planPrompt({
      cloudId: "azure",
      survey,
      answers: [],
      tooling: [],
      rejected: [],
      notes: [],
    });
    expect(prompt).toContain("to Azure, to the subscription Aime targets");
    expect(prompt).toContain("A step runs as `az` and nothing else");
    // The two things that stop an Azure deploy before it starts.
    expect(prompt).toContain("RESOURCE GROUP");
    expect(prompt).toContain("provider register");
    // And the flags Aime adds itself, which the checker refuses in a plan.
    expect(prompt).toContain("`--subscription`");
    expect(prompt).toContain("`--output json`");
    // The example answer has to be in this cloud's own commands, or the model
    // copies Google Cloud's.
    expect(prompt).toContain('"args":["group","create"');
    expect(prompt).toContain("defaultHostName");
    expect(prompt).not.toContain("gcloud");
  });

  it("does not offer kubectl, which Aime will not run for this cloud", () => {
    const prompt = surveyPrompt({ cloudId: "azure", inventory: [], tooling: [] });
    expect(prompt).toContain("Never `kubectl`");
    expect(prompt).toContain("the subscription holds no resources yet");
  });

  it("is refused for a cloud with no measured dialect", () => {
    expect(() => surveyPrompt({ cloudId: "aws", inventory: [], tooling: [] })).toThrow("aws");
  });
});

describe("the plan prompt", () => {
  it("names the keep rule, the read answers and what was refused last time", () => {
    const prompt = planPrompt({
      cloudId: "gcp",
      notes: [],
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
      // Named by the read when it is not the cloud's own CLI; empty here.
      program: "",
    });
    expect(parsed?.missing).toEqual(["the region"]);
  });

  it("carries the program a read names, so a cluster can be looked at", () => {
    // Measured 2026-09-12: without this the AI's six diagnostic reads after a
    // failed `kubectl apply` were all run as `gcloud get …` and refused.
    const reply =
      '{"app":{"name":"s","kind":"web","stack":"Node","port":8080,"healthPath":"/","builds":"Dockerfile"},' +
      '"existing":[],"inspect":[{"label":"pods","program":"kubectl","args":["get","pods"]}],"missing":[]}';
    expect(parseSurvey(reply)?.inspect[0]?.program).toBe("kubectl");
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

  /**
   * Captured from `gcloud app describe` on a real App Engine deploy,
   * 2026-09-12. The deploy had worked and the app was serving; Aime called it
   * unproved because this field is a HOST where Cloud Run answers a whole URL.
   */
  const APP_ENGINE = {
    codeBucket: "staging.my-project.appspot.com",
    defaultHostname: "my-project.as.r.appspot.com",
    id: "my-project",
    locationId: "asia-southeast1",
    name: "apps/my-project",
    servingStatus: "SERVING",
  };

  it("reads a bare hostname as the https URL it is", () => {
    expect(urlIn(JSON.stringify(APP_ENGINE), "defaultHostname")).toBe("https://my-project.as.r.appspot.com");
    // A bucket is a hostname's shape and not a front end, but Aime only looks
    // where the plan points; what must not happen is a value that is plainly
    // not addressable being requested.
    expect(urlIn(JSON.stringify(APP_ENGINE), "servingStatus")).toBeNull();
    expect(urlIn(JSON.stringify(APP_ENGINE), "name")).toBeNull();
    expect(urlIn(JSON.stringify(APP_ENGINE), "locationId")).toBeNull();
  });

  it("asks an L4 LoadBalancer address over the scheme it actually serves", () => {
    // What a Kubernetes `type: LoadBalancer` Service answers, and all it
    // answers: an IP with no certificate on it. Asked over https it proves
    // nothing about a workload that is serving perfectly well.
    const service = { status: { loadBalancer: { ingress: [{ ip: "34.124.196.7" }] } } };
    const at = "status.loadBalancer.ingress.0.ip";
    expect(urlIn(JSON.stringify(service), at, "http")).toBe("http://34.124.196.7");
    // https stays the default, which is right for every managed front end.
    expect(urlIn(JSON.stringify(service), at)).toBe("https://34.124.196.7");
  });

  it("refuses anything that is neither a URL nor a hostname", () => {
    const odd = {
      port: 8080,
      sentence: "the service is up",
      withPath: "example.com/health",
      withPort: "example.com:8080",
      single: "localhost",
      leading: "-bad.example.com",
      empty: "",
    };
    for (const key of Object.keys(odd)) {
      expect(urlIn(JSON.stringify(odd), key)).toBeNull();
    }
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

/**
 * The confirm page is where someone first sees what would actually run, so it
 * is where "not like that" belongs. The words go into the next plan; they
 * never go onto a command line, and they never widen what Aime will run.
 */
describe("what the person asked for", () => {
  it("carries every note into the plan, oldest first", () => {
    const prompt = planPrompt({
      cloudId: "azure",
      survey,
      answers: [],
      tooling: [],
      rejected: [],
      notes: [
        { asked: "use B1 instead of F1", answered: "Moved the plan to B1; it is about 13 USD a month." },
        { asked: "put it in eastasia", answered: "" },
      ],
    });
    expect(prompt).toContain("What the person asked for after reading your last plan");
    expect(prompt.indexOf("use B1 instead of F1")).toBeLessThan(prompt.indexOf("put it in eastasia"));
    // Its own last answer goes back with the question, or the second revision
    // argues with itself about what it already agreed to.
    expect(prompt).toContain("you answered: Moved the plan to B1");
    expect(prompt).toContain("`reply`");
  });

  it("says a note cannot loosen a rule, so a refused command is not the answer to one", () => {
    const prompt = planPrompt({
      cloudId: "gcp",
      survey,
      answers: [],
      tooling: [],
      rejected: [],
      notes: [{ asked: "just delete the old service first", answered: "" }],
    });
    expect(prompt).toContain("a request, not a permission");
    expect(prompt).toContain("the nearest plan that is allowed");
  });

  it("says nothing about notes when there are none", () => {
    const prompt = planPrompt({
      cloudId: "gcp",
      survey,
      answers: [],
      tooling: [],
      rejected: [],
      notes: [],
    });
    expect(prompt).not.toContain("What the person asked for");
  });
});

describe("the lines a person reads", () => {
  it("pins the project and the account after the plan's own arguments", () => {
    expect(
      commandLine(
        "gcp",
        { label: "Deploy", args: ["run", "deploy", "web", "--source", "."], changes: "" },
        account,
      ),
    ).toBe("gcloud run deploy web --source . --project my-project --account dev@example.com");
  });

  it("shows a kubectl step under its own program, with no scope flags", () => {
    // `kubectl` is pointed at a cluster by the kubeconfig an earlier
    // `get-credentials` step wrote; `--project` and `--account` are `gcloud`'s
    // way of being told, and `kubectl` refuses them.
    expect(
      commandLine(
        "gcp",
        {
          label: "Apply the manifests",
          args: ["apply", "--filename", "k8s/"],
          changes: "the cluster's workloads",
          program: "kubectl",
        },
        account,
      ),
    ).toBe("kubectl apply --filename k8s/");
    // An empty program is the cloud's own, which is how every plan written
    // before this field existed reads.
    expect(
      commandLine("gcp", { label: "d", args: ["run", "deploy"], changes: "", program: "" }, account),
    ).toBe("gcloud run deploy --project my-project --account dev@example.com");
  });

  /**
   * Azure's own scope and JSON flags: `az` takes `--subscription` and has no
   * account flag at all, and asks for JSON with `--output`. Getting this wrong
   * is not a cosmetic slip - the line here is the line Aime runs.
   */
  it("pins an Azure step to the subscription, and to nothing else", () => {
    const azureAccount = { ...account, id: "1b3e09f3-1a77-441b-aeca-3488d1efac95" };
    expect(
      commandLine(
        "azure",
        { label: "Deploy", args: ["webapp", "up", "--name", "web", "--sku", "F1"], changes: "" },
        azureAccount,
      ),
    ).toBe("az webapp up --name web --sku F1 --subscription 1b3e09f3-1a77-441b-aeca-3488d1efac95");
    expect(
      readLine(
        "azure",
        { purpose: "overview", label: "show", args: ["webapp", "show", "--name", "web"] },
        azureAccount,
      ),
    ).toBe("az webapp show --name web --subscription 1b3e09f3-1a77-441b-aeca-3488d1efac95 --output json");
  });

  it("adds the JSON format to a read, and quotes what needs it", () => {
    expect(
      readLine(
        "gcp",
        { purpose: "overview", label: "d", args: ["run", "services", "describe", "my web"] },
        account,
      ),
    ).toBe(
      'gcloud run services describe "my web" --project my-project --account dev@example.com --format json',
    );
  });
});

describe("a plan for a cloud whose reads answer no address", () => {
  /**
   * The bug this catches cost a whole deploy run: the plan was good, its
   * `urlPath` was empty because Aime builds the address on that cloud, and the
   * parser threw the plan away - so the page said nothing could prove the
   * deployment and refused to run it.
   */
  it("keeps a prove with no path into the answer, where Aime builds the address", () => {
    const answered = JSON.stringify({
      summary: "deploy the function",
      steps: [{ label: "deploy", args: ["functions", "deploy", "hello"], changes: "the function" }],
      keep: [],
      files: [],
      prove: {
        read: { purpose: "overview", label: "supabase functions list", args: ["functions", "list"] },
        urlPath: "",
        path: "/hello",
        expect: 200,
      },
    });
    expect(parsePlan(answered, false)?.prove?.path).toBe("/hello");
    // And on a cloud whose read DOES answer the address, an empty path into
    // that answer is still a plan Aime cannot prove.
    expect(parsePlan(answered)?.prove).toBeNull();
  });

  /**
   * The first real Supabase deploy stopped here, 2026-09-21: asked for a read
   * that answers the URL, the AI wrote `prove: null` - which was the honest
   * answer, since no Supabase read answers one - and Aime refuses to run what
   * it cannot prove. The address of an Edge Function follows from the project
   * ref, so the prompt now asks for the part the AI knows and says Aime builds
   * the rest.
   */
  it("asks for a proof it can actually write", () => {
    const supabase = planPrompt({
      cloudId: "supabase",
      survey,
      answers: [],
      tooling: [],
      rejected: [],
      notes: [],
    });
    expect(supabase).toContain("No read on this cloud answers an address");
    expect(supabase).toContain("https://<account>.supabase.co/functions/v1");
    expect(supabase).toContain("`prove` is never null");

    // The clouds whose reads DO answer one keep the instruction they had.
    const gcp = planPrompt({
      cloudId: "gcp",
      survey,
      answers: [],
      tooling: [],
      rejected: [],
      notes: [],
    });
    expect(gcp).toContain("the read that answers the deployed URL");
    expect(gcp).not.toContain("Aime builds one itself");
  });
});

/**
 * A person watching a deploy can see things the CLI's output cannot say. What
 * they type is put to the AI at the first moment nothing is in flight - with
 * the failure when it failed - and these pin what the AI is told and what Aime
 * accepts back.
 */
describe("speaking while it runs", () => {
  const plan: DeployPlan = {
    summary: "Deploy shop to the existing Cloud Run service web",
    reply: "",
    target: { existing: true, resourceId: service.id, region: "asia-southeast1" },
    proposal: null,
    keep: [],
    steps: [],
    files: [],
    prove: null,
  };
  const remaining: DeployStep[] = [
    {
      label: "Deploy from source",
      args: ["run", "deploy", "web", "--source", "."],
      changes: "a new revision",
    },
    {
      label: "Roll the workload",
      args: ["rollout", "restart", "deployment/web"],
      changes: "restarted pods",
      program: "kubectl",
    },
  ];
  const failed = {
    label: "Deploy from source",
    command: "gcloud run deploy web --source .",
    output: "ERROR: Quota exceeded",
  };

  it("tells the AI what was said, what cannot be undone, and what is still to run", () => {
    const prompt = steerPrompt({
      cloudId: "gcp",
      plan,
      asked: "that is the wrong region",
      ran: ["Enable APIs"],
      remaining,
    });

    expect(prompt).toContain("> that is the wrong region");
    expect(prompt).toContain("Already run - this cannot be undone");
    expect(prompt).toContain("- Enable APIs");
    expect(prompt).toContain("- Deploy from source: gcloud run deploy web --source .");
    // A step that names its own CLI is shown under that one, not the cloud's.
    expect(prompt).toContain("- Roll the workload: kubectl rollout restart deployment/web");
    // Nothing has failed, so leaving the plan alone has to be sayable.
    expect(prompt).toContain("An empty list means the deployment goes on exactly as confirmed");
    expect(prompt).toContain("a request, not a permission");
  });

  it("reads an answer that is words alone, and refuses one that is neither", () => {
    expect(parseSteer('{"reply":"It is already in that region.","steps":[]}')).toEqual({
      reply: "It is already in that region.",
      steps: [],
    });
    expect(
      parseSteer('{"reply":"","steps":[{"label":"Redeploy","args":["run","deploy"],"changes":"x"}]}'),
    ).toMatchObject({ steps: [{ label: "Redeploy" }] });
    expect(parseSteer('{"reply":"","steps":[]}')).toBeNull();
    expect(parseSteer("I could not do that")).toBeNull();
  });

  it("puts what was said in with the failure, and asks the AI to answer the person too", () => {
    const prompt = fixPrompt({
      cloudId: "gcp",
      plan,
      failed,
      remaining: [],
      answers: [],
      rejected: [],
      asked: "the quota is on another project",
    });

    expect(prompt).toContain("> the quota is on another project");
    expect(prompt).toContain("`reply`: your answer to what the person just said");
    expect(prompt).toContain("a request, not a permission");
  });

  it("asks for no reply when nobody said anything", () => {
    const prompt = fixPrompt({
      cloudId: "gcp",
      plan,
      failed,
      remaining: [],
      answers: [],
      rejected: [],
      asked: "",
    });

    expect(prompt).not.toContain("The person watching this run said");
    expect(prompt).toContain("`reply`: empty string - nobody asked you anything.");
  });

  it("reads the reply out of a revision, and still calls words alone no fix", () => {
    const revision = parseRevision(
      '{"steps":[{"label":"Deploy to the other project","args":["run","deploy","web"],"changes":"a revision"}],' +
        '"files":[],"inspect":[],"giveUp":null,"reply":"Moved it to the project that has the quota."}',
    );
    expect(revision?.reply).toBe("Moved it to the project that has the quota.");
    // A failed step is not restarted by words: an answer with nothing to run is no answer.
    expect(parseRevision('{"steps":[],"files":[],"inspect":[],"giveUp":null,"reply":"I see."}')).toBeNull();
  });
});
