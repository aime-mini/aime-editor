import { describe, expect, it } from "vitest";
import type { CloudResource } from "../stores/cloud";
import { linksOf } from "./cloudLinks";

/**
 * Captured 2026-09-25 from a real AWS account - `lambda get-function` and
 * `lambda get-event-source-mapping` - with the account number replaced and the
 * business names swapped for neutral ones, consistently, so every reference
 * still points where it pointed. The shape is the CLI's own.
 */
const ACCOUNT = "111122223333";
const arn = (service: string, rest: string) => `arn:aws:${service}:ap-southeast-2:${ACCOUNT}:${rest}`;

const FUNCTION_ANSWER = JSON.stringify({
  Configuration: {
    FunctionName: "Payment-MatchRemittance",
    FunctionArn: arn("lambda", "function:Payment-MatchRemittance"),
    Role: `arn:aws:iam::${ACCOUNT}:role/Payment-MatchRemittance-Role-119PURTF9FXFQ`,
    Environment: {
      Variables: {
        COMPANY_SERVICE_FUNCTION: "Company-CompanyService",
        AUTO_ALLOCATE_QUEUE_URL: `https://sqs.ap-southeast-2.amazonaws.com/${ACCOUNT}/Payment-AutoAllocate.fifo`,
        COMMENT: "Automatically disregarded remittance advice due to matching payment amount",
        PAGE_SIZE: "100",
        QUEUE_URL: `https://sqs.ap-southeast-2.amazonaws.com/${ACCOUNT}/Payment-MatchRemittance.fifo`,
      },
    },
    VpcConfig: { SubnetIds: [], SecurityGroupIds: [], VpcId: "", Ipv6AllowedForDualStack: false },
    Layers: null,
  },
  Tags: {
    "aws:cloudformation:stack-id": `arn:aws:cloudformation:ap-southeast-2:${ACCOUNT}:stack/Payment-MatchRemittance/ee04`,
    "aws:cloudformation:logical-id": "MatchRemittance",
  },
  Code: {
    RepositoryType: "S3",
    Location: "https://awslambda-ap-se-2-tasks.s3.ap-southeast-2.amazonaws.com/x",
  },
});

const MAPPING_ANSWER = JSON.stringify({
  UUID: "0128402a-7fb1-49e9-b563-d2a7f999da84",
  BatchSize: 10,
  EventSourceArn: arn("sqs", "Payment-MatchRemittance.fifo"),
  FunctionArn: arn("lambda", "function:Payment-MatchRemittance"),
  State: "Enabled",
});

function resource(kind: string, name: string, id: string): CloudResource {
  return { id, name, cliName: name, kind, location: "ap-southeast-2", group: ACCOUNT, tags: {} };
}

const matcher = resource(
  "lambda/function",
  "Payment-MatchRemittance",
  arn("lambda", "function:Payment-MatchRemittance"),
);
const company = resource(
  "lambda/function",
  "Company-CompanyService",
  arn("lambda", "function:Company-CompanyService"),
);
const companyReport = resource(
  "lambda/function",
  "Company-CompanyServiceReport",
  arn("lambda", "function:Company-CompanyServiceReport"),
);
const ownQueue = resource("sqs", "Payment-MatchRemittance.fifo", arn("sqs", "Payment-MatchRemittance.fifo"));
const allocateQueue = resource("sqs", "Payment-AutoAllocate.fifo", arn("sqs", "Payment-AutoAllocate.fifo"));
const mapping = resource(
  "lambda/event-source-mapping",
  "0128402a-7fb1-49e9-b563-d2a7f999da84",
  arn("lambda", "event-source-mapping:0128402a-7fb1-49e9-b563-d2a7f999da84"),
);
const pageSize = resource("ssm/parameter", "100", arn("ssm", "parameter/100"));
const stack = resource(
  "cloudformation/stack",
  "Payment-MatchRemittance-Stack",
  `arn:aws:cloudformation:ap-southeast-2:${ACCOUNT}:stack/Payment-MatchRemittance/ee04`,
);
const ACCOUNT_RESOURCES = [
  matcher,
  company,
  companyReport,
  ownQueue,
  allocateQueue,
  mapping,
  pageSize,
  stack,
];

describe("linksOf", () => {
  it("reads what a function's configuration names: functions by name, queues by URL", () => {
    const links = linksOf([{ resource: matcher, json: FUNCTION_ANSWER }], ACCOUNT_RESOURCES);
    expect(links).toEqual([
      {
        from: matcher.id,
        to: company.id,
        where: "Configuration.Environment.Variables.COMPANY_SERVICE_FUNCTION",
      },
      {
        from: matcher.id,
        to: allocateQueue.id,
        where: "Configuration.Environment.Variables.AUTO_ALLOCATE_QUEUE_URL",
      },
      { from: matcher.id, to: ownQueue.id, where: "Configuration.Environment.Variables.QUEUE_URL" },
    ]);
  });

  it("links a mapping to both the queue it reads and the function it feeds", () => {
    const links = linksOf([{ resource: mapping, json: MAPPING_ANSWER }], ACCOUNT_RESOURCES);
    expect(links.map((link) => [link.to, link.where])).toEqual([
      [ownQueue.id, "EventSourceArn"],
      [matcher.id, "FunctionArn"],
    ]);
  });

  it("does not read who created a resource out of its tags as something it uses", () => {
    const links = linksOf([{ resource: matcher, json: FUNCTION_ANSWER }], ACCOUNT_RESOURCES);
    expect(links.some((link) => link.to === stack.id)).toBe(false);
  });

  it("does not take one function's name for a longer one that starts the same way", () => {
    const links = linksOf([{ resource: matcher, json: FUNCTION_ANSWER }], ACCOUNT_RESOURCES);
    expect(links.some((link) => link.to === companyReport.id)).toBe(false);
  });

  it("does not link a resource to itself, nor to a short plain name that happens to match a value", () => {
    const links = linksOf([{ resource: matcher, json: FUNCTION_ANSWER }], ACCOUNT_RESOURCES);
    expect(links.some((link) => link.to === matcher.id)).toBe(false);
    expect(links.some((link) => link.to === pageSize.id)).toBe(false);
  });

  it("finds a function named by an ARN with a version on the end", () => {
    const json = JSON.stringify({ Target: `${company.id}:$LATEST` });
    expect(linksOf([{ resource: mapping, json }], ACCOUNT_RESOURCES)).toEqual([
      { from: mapping.id, to: company.id, where: "Target" },
    ]);
  });

  it("matches an Azure id whatever case the CLI printed it in, and a child path to its parent", () => {
    const plan = resource(
      "Microsoft.Web/serverFarms",
      "ASP-study",
      "/subscriptions/1b3e/resourceGroups/rg-study/providers/Microsoft.Web/serverFarms/ASP-study",
    );
    const site = resource(
      "Microsoft.Web/sites",
      "study-app",
      "/subscriptions/1b3e/resourceGroups/rg-study/providers/Microsoft.Web/sites/study-app",
    );
    const json = JSON.stringify({
      properties: {
        serverFarmId:
          "/subscriptions/1b3e/resourcegroups/RG-STUDY/providers/Microsoft.Web/serverfarms/ASP-study",
      },
    });
    expect(linksOf([{ resource: site, json }], [plan, site])).toEqual([
      { from: site.id, to: plan.id, where: "properties.serverFarmId" },
    ]);
  });

  it("matches a Google full resource name by the relative name a configuration writes", () => {
    const topic = resource(
      "pubsub.googleapis.com/Topic",
      "orders",
      "//pubsub.googleapis.com/projects/p1/topics/orders",
    );
    const sink = resource(
      "logging.googleapis.com/LogSink",
      "audit",
      "//logging.googleapis.com/projects/p1/sinks/audit",
    );
    const json = JSON.stringify({ destination: "pubsub.googleapis.com/projects/p1/topics/orders" });
    expect(linksOf([{ resource: sink, json }], [topic, sink])).toEqual([
      { from: sink.id, to: topic.id, where: "destination" },
    ]);
  });
});
