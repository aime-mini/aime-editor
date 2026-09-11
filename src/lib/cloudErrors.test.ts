import { describe, expect, it } from "vitest";
import { billingOff, cliRefusal, disabledApi, looksLikeSignIn, shortCliError } from "./cloudErrors";

/**
 * Captured from the real CLI on 2026-09-09, clicking a Google Cloud project in
 * the panel - not written from memory of the format. This exact text is what
 * used to be shown under a "Sign in" button that could not fix it.
 */
const ASSET_API_OFF = `ERROR: (gcloud.asset.search-all-resources) [duylinh191@gmail.com] does not have permission to access projects instance [gen-lang-client-0446647617:searchAllResources] (or it may not exist): Cloud Asset API has not been used in project ai-social-worflow before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudasset.googleapis.com/overview?project=ai-social-worflow then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`;

/** Azure's answer when a cached account's token has gone stale. */
const AZURE_EXPIRED = `Interactive authentication is needed. Please run:\naz login --tenant "tenant-1"\nStatus_InteractionRequired`;

describe("disabledApi", () => {
  it("names the API, the project it is charged to, and the page that enables it", () => {
    expect(disabledApi(ASSET_API_OFF)).toEqual({
      // The sentence carries the display name; the id only exists in the page,
      // which is why the page is where it is read from.
      service: "cloudasset.googleapis.com",
      display: "Cloud Asset",
      // The project listed (gen-lang-client-0446647617) is NOT the project the
      // quota is charged to, which is why the message names both.
      project: "ai-social-worflow",
      url: "https://console.developers.google.com/apis/api/cloudasset.googleapis.com/overview?project=ai-social-worflow",
    });
  });

  it("is null for an error about anything else", () => {
    expect(disabledApi(AZURE_EXPIRED)).toBeNull();
    expect(disabledApi("ERROR: (gcloud.asset.search-all-resources) INVALID_ARGUMENT")).toBeNull();
  });

  it("answers without an id when the CLI gave no page - nothing to enable by id", () => {
    const noUrl = "Cloud Run Admin API has not been used in project shop-prod before or it is disabled.";
    expect(disabledApi(noUrl)).toEqual({
      service: null,
      display: "Cloud Run Admin",
      project: "shop-prod",
      url: null,
    });
  });
});

/**
 * Captured 2026-09-10 from the first real deploy Aime ran end to end: the step
 * `gcloud services enable run.googleapis.com cloudbuild.googleapis.com
 * artifactregistry.googleapis.com` on a project with no billing account. Note
 * that the sentence names the project NUMBER, which is not what the panel or
 * any later command calls the project.
 */
const BILLING_OFF_ON_ENABLE = `ERROR: (gcloud.services.enable) FAILED_PRECONDITION: Billing account for project '130881371924' is not found. Billing must be enabled for activation of service(s) 'artifactregistry.googleapis.com,cloudbuild.googleapis.com,run.googleapis.com,containerregistry.googleapis.com' to proceed.

Help Token: AbluAGsDWZTqJHtiEExWepiHqKyxZWu
- '@type': type.googleapis.com/google.rpc.ErrorInfo
  domain: serviceusage.googleapis.com/billing-enabled
  reason: UREQ_PROJECT_BILLING_NOT_FOUND`;

/**
 * The other shape, captured the same day: a project whose billing account was
 * closed refuses plain READS, naming the project by id this time.
 */
const BILLING_OFF_ON_READ = `ERROR: (gcloud.app.describe) [duylinh191@gmail.com] does not have permission to access apps instance [testfcm-1c2ef] (or it may not exist): Read access to project 'testfcm-1c2ef' was denied: please check billing account associated and retry. This command is authenticated as duylinh191@gmail.com which is the active account specified by the [core/account] property`;

describe("billingOff", () => {
  it("names the project the CLI blamed and the APIs it refused to turn on", () => {
    expect(billingOff(BILLING_OFF_ON_ENABLE)).toEqual({
      // The number, verbatim - the panel shows it beside the id it knows,
      // rather than pretending the CLI said the id.
      project: "130881371924",
      services: [
        "artifactregistry.googleapis.com",
        "cloudbuild.googleapis.com",
        "run.googleapis.com",
        "containerregistry.googleapis.com",
      ],
    });
  });

  it("also reads the refusal a lapsed project gives to an ordinary read", () => {
    expect(billingOff(BILLING_OFF_ON_READ)).toEqual({ project: "testfcm-1c2ef", services: [] });
  });

  it("is null for the refusals that have their own fix", () => {
    expect(billingOff(ASSET_API_OFF)).toBeNull();
    expect(billingOff(AZURE_EXPIRED)).toBeNull();
  });

  it("does not answer for a billing account that is merely mentioned", () => {
    expect(billingOff("Linked billing account billingAccounts/01AFA3-CF2B61-DE899A")).toBeNull();
  });
});

describe("looksLikeSignIn", () => {
  it("is true for the words the CLIs use when the sign-in is the problem", () => {
    expect(looksLikeSignIn(AZURE_EXPIRED)).toBe(true);
    expect(looksLikeSignIn("You do not currently have an active account selected")).toBe(true);
    expect(looksLikeSignIn("Access token not provided. Supply an access token")).toBe(true);
  });

  it("is false for the refusals a sign-in cannot fix", () => {
    expect(looksLikeSignIn(ASSET_API_OFF)).toBe(false);
    expect(looksLikeSignIn(BILLING_OFF_ON_ENABLE)).toBe(false);
  });
});

/**
 * The four refusals a read can come back with, captured 2026-09-11 by running
 * the stored plans against every resource in a real Google account.
 *
 * The first two are the command's own fault and the AI can fix them: `gcloud
 * iam service-accounts describe` wraps whatever it is given into
 * `projects/-/serviceAccounts/<arg>`, so a relative name goes to
 * `/v1/projects/-/serviceAccounts/projects/p/serviceAccounts/…` and Google
 * answers with its 404 PAGE - 1.7 KB of HTML in a panel that has one line. The
 * last two are walls: the same sentence comes back for a right command and a
 * wrong one, so there is nothing for the AI to fix.
 */
const SERVICE_ACCOUNT_404 = `ERROR: (gcloud.iam.service-accounts.describe) HTTPError 404: <!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n  <meta name=viewport content="initial-scale=1, minimum-scale=1, width=device-width">\n  <title>Error 404 (Not Found)!!1</title>\n  <style>\n    *{margin:0;padding:0}html,code{font:15px/22px arial,sans-serif}html{background:#fff;color:#222;padding:15px}body{margin:7% auto 0;max-width:390px;min-height:180px;padding:30px 0 15px}* > body{background:url(//www.google.com/images/errors/robot.png) 100% 5px no-repeat;padding-right:205px}p{margin:11px 0 22px;overflow:hidden}ins{color:#777;text-decoration:none}a img{border:0}@media screen and (max-width:772px){body{background:none;margin-top:0;max-width:none;padding-right:0}}#logo{background:url(//www.google.com/images/branding/googlelogo/1x/googlelogo_color_150x54dp.png) no-repeat;margin-left:-5px}@media only screen and (min-resolution:192dpi){#logo{background:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) no-repeat 0% 0%/100% 100%;-moz-border-image:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) 0}}@media only screen and (-webkit-min-device-pixel-ratio:2){#logo{background:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) no-repeat;-webkit-background-size:100% 100%}}#logo{display:inline-block;height:54px;width:150px}\n  </style>\n  <a href=//www.google.com/><span id=logo aria-label=Google></span></a>\n  <p><b>404.</b> <ins>That\\u2019s an error.</ins>\n  <p>The requested URL <code>/v1/projects/-/serviceAccounts/projects/ai-social-worflow/serviceAccounts/130881371924-compute@developer.gserviceaccount.com?alt=json</code> was not found on this server.  <ins>That\\u2019s all we know.</ins>`;

const LOG_BUCKET_NOT_FOUND = `ERROR: (gcloud.logging.buckets.describe) NOT_FOUND: Bucket \`projects/220977833936/locations/global/buckets/_Default\` in location \`global\` does not exist. This command is authenticated as duylinh191@gmail.com which is the active account specified by the [core/account] property`;

const LOGGING_API_OFF = `ERROR: (gcloud.logging.sinks.describe) PERMISSION_DENIED: Cloud Logging API has not been used in project bpgoblog before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/logging.googleapis.com/overview?project=bpgoblog then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry. This command is authenticated as duylinh191@gmail.com which is the active account specified by the [core/account] property.\nCloud Logging API has not been used in project bpgoblog before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/logging.googleapis.com/overview?project=bpgoblog then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.\nGoogle developers console API activation\nhttps://console.developers.google.com/apis/api/logging.googleapis.com/overview?project=bpgoblog\n- '@type': type.googleapis.com/google.rpc.ErrorInfo\n  domain: googleapis.com\n  metadata:\n    activationUrl: https://console.developers.google.com/apis/api/logging.googleapis.com/overview?project=bpgoblog\n    consumer: projects/bpgoblog\n    containerInfo: bpgoblog\n    service: logging.googleapis.com\n    serviceTitle: Cloud Logging API\n  reason: SERVICE_DISABLED`;

const APP_ENGINE_NO_BILLING = `ERROR: (gcloud.app.describe) [duylinh191@gmail.com] does not have permission to access apps instance [dotnetvn-1084] (or it may not exist): Read access to project 'dotnetvn-1084' was denied: please check billing account associated and retry. This command is authenticated as duylinh191@gmail.com which is the active account specified by the [core/account] property`;

/**
 * Captured 2026-09-11 from `gcloud dataplex entry-groups describe` on a project
 * with no billing: an API that bills per call says so in a third sentence,
 * which none of the patterns written before this run matched.
 */
const BILLING_OFF_PER_CALL = `ERROR: (gcloud.dataplex.entry-groups.describe) PERMISSION_DENIED: This API method requires billing to be enabled. Please enable billing on project #samplebigquery-428108 by visiting https://console.developers.google.com/billing/enable?project=samplebigquery-428108 then retry. If you enabled billing for this project recently, wait a few minutes for the action to propagate to our systems and retry. This command is authenticated as duylinh191@gmail.com which is the active account specified by the [core/account] property.`;

describe("billing that an API refuses a call over", () => {
  it("reads the project out of the sentence an API that bills per call uses", () => {
    expect(billingOff(BILLING_OFF_PER_CALL)).toEqual({
      project: "samplebigquery-428108",
      services: [],
    });
  });

  it("is a wall, so the command that hit it is not rewritten", () => {
    expect(cliRefusal(BILLING_OFF_PER_CALL)).toBe("wall");
  });
});

describe("cliRefusal", () => {
  it("calls a command Aime can rewrite the command's fault", () => {
    expect(cliRefusal(SERVICE_ACCOUNT_404)).toBe("command");
    expect(cliRefusal(LOG_BUCKET_NOT_FOUND)).toBe("command");
    expect(cliRefusal("ERROR: (gcloud.projects.describe) INVALID_ARGUMENT")).toBe("command");
  });

  it("calls a project's own state a wall, because the right command fails the same way", () => {
    expect(cliRefusal(LOGGING_API_OFF)).toBe("wall");
    expect(cliRefusal(APP_ENGINE_NO_BILLING)).toBe("wall");
    expect(cliRefusal(AZURE_EXPIRED)).toBe("wall");
  });
});

describe("shortCliError", () => {
  it("takes the web page out of a CLI answer and leaves the sentence", () => {
    const short = shortCliError(SERVICE_ACCOUNT_404);
    expect(short).toContain("HTTPError 404");
    expect(short).not.toContain("<style>");
    expect(short).not.toContain("padding");
    expect(short.length).toBeLessThanOrEqual(301);
  });

  it("leaves a plain message alone, whitespace closed up", () => {
    expect(shortCliError(LOG_BUCKET_NOT_FOUND)).toBe(LOG_BUCKET_NOT_FOUND.replace(/\s+/g, " ").trim());
  });
});
