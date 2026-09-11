import { describe, expect, it } from "vitest";
import { basesOf, mapOf, nodesOf, regionsOf, shapeOf, UNTAGGED } from "./cloudMap";
import type { CloudResource } from "../stores/cloud";

function resource(name: string, kind: string, tags: Record<string, string> = {}, group = ""): CloudResource {
  return { id: `id-${name}`, name, cliName: name, kind, location: "eastus", group, tags };
}

/** `count` resources of one kind, all carrying the same tags. */
function many(count: number, kind: string, tags: Record<string, string>, prefix = kind): CloudResource[] {
  return Array.from({ length: count }, (_, index) => resource(`${prefix}-${String(index)}`, kind, tags));
}

describe("grouping a cloud account into the applications it holds", () => {
  it("groups by the tag the team actually uses, and says which one", () => {
    const map = mapOf([
      resource("web-a", "Microsoft.Web/sites", { app: "checkout" }),
      resource("db-a", "Microsoft.Sql/servers", { app: "checkout" }),
      resource("web-b", "Microsoft.Web/sites", { app: "billing" }),
      resource("web-c", "Microsoft.Web/sites", { app: "billing" }),
      resource("web-d", "Microsoft.Web/sites", { app: "reports" }),
      resource("web-e", "Microsoft.Web/sites", { app: "reports" }),
    ]);

    expect(map.basis).toEqual({ kind: "tag", key: "app" });
    // Equal sizes fall back to the name, so the order is stable between reads.
    expect(map.apps.map((entry) => [entry.name, entry.resources.length])).toEqual([
      ["billing", 2],
      ["checkout", 2],
      ["reports", 2],
    ]);
  });

  /**
   * The shape of the real account this was measured against (2026-09-03,
   * 6,252 resources): `Env` on most of it with two values, `Purpose` with a
   * value per resource, and the team's application tag - `Area` - on a tenth
   * of it. A fixed list of favourite keys never contained `Area`; a coverage
   * threshold threw it away for covering too little. The data has to choose.
   */
  it("chooses the key that partitions, not the key that covers", () => {
    const resources = [
      ...many(300, "rds/cluster-snapshot", { Env: "dev" }),
      ...many(200, "lambda/function", { Env: "dev", Purpose: "unique" }).map((entry, index) => ({
        ...entry,
        tags: { ...entry.tags, Purpose: `purpose ${String(index)}` },
      })),
      ...many(40, "lambda/function", { Env: "dev", Area: "Payments" }, "pay"),
      ...many(30, "dynamodb/table", { Env: "dev", Area: "Invoices" }, "inv"),
      ...many(20, "sqs", { Env: "prod", Area: "Tasks" }, "task"),
    ];

    const map = mapOf(resources);
    expect(map.basis).toEqual({ kind: "tag", key: "Area" });
    expect(map.apps.slice(0, 3).map((app) => app.name)).toEqual(["Payments", "Invoices", "Tasks"]);
    // What the tag says nothing about is a gap, named as one and put last.
    expect(map.apps.at(-1)?.name).toBe(UNTAGGED);
    expect(map.apps.at(-1)?.resources).toHaveLength(500);

    // Neither a status tag nor a label tag is offered as an application.
    const keys = map.options.filter((option) => option.basis.kind === "tag").map((option) => option.basis);
    expect(keys).toEqual([{ kind: "tag", key: "Area" }]);
  });

  it("offers the stack the cloud recorded, and files the stack with its children", () => {
    const resources = [
      resource("Orders", "cloudformation/stack"),
      resource("orders-fn", "lambda/function", { "aws:cloudformation:stack-name": "Orders" }),
      resource("orders-table", "dynamodb/table", { "aws:cloudformation:stack-name": "Orders" }),
      resource("Billing", "cloudformation/stack"),
      resource("billing-fn", "lambda/function", { "aws:cloudformation:stack-name": "Billing" }),
    ];
    const options = basesOf(resources);
    expect(options).toEqual([{ basis: { kind: "stack" }, covered: 5, apps: 2 }]);

    const map = mapOf(resources, { kind: "stack" });
    expect(map.apps.map((app) => [app.name, app.resources.length])).toEqual([
      ["Orders", 3],
      ["Billing", 2],
    ]);
  });

  it("lets the person pick a basis, and falls back to the best when the pick is gone", () => {
    // `team` is on half the resources, `app` on all of them: `app` wins by coverage.
    const resources = [
      ...many(6, "Microsoft.Web/sites", { app: "checkout", team: "blue" }, "a"),
      ...many(6, "Microsoft.Web/sites", { app: "billing" }, "b"),
      ...many(6, "Microsoft.Web/sites", { app: "reports", team: "red" }, "c"),
      ...many(6, "Microsoft.Web/sites", { app: "search" }, "d"),
      ...many(6, "Microsoft.Web/sites", { app: "mail", team: "green" }, "e"),
    ];
    expect(mapOf(resources).basis).toEqual({ kind: "tag", key: "app" });
    expect(mapOf(resources, { kind: "tag", key: "team" }).apps.map((app) => app.name)).toEqual([
      "blue",
      "green",
      "red",
      UNTAGGED,
    ]);
    // A choice the data no longer supports is not honoured silently.
    expect(mapOf(resources, { kind: "tag", key: "owner" }).basis).toEqual({ kind: "tag", key: "app" });
  });

  it("falls back to the resource group when no tag names an application", () => {
    const map = mapOf([
      resource("web", "Microsoft.Web/sites", {}, "rg-prod"),
      resource("db", "Microsoft.Sql/servers", {}, "rg-prod"),
      resource("fn", "Microsoft.Web/sites", {}, "rg-dev"),
    ]);

    expect(map.basis).toEqual({ kind: "group" });
    expect(map.apps.map((entry) => entry.name)).toEqual(["rg-prod", "rg-dev"]);
  });

  it("does not offer a basis that divides nothing", () => {
    // One account number on every AWS resource is not a grouping.
    const flat = many(5, "lambda/function", {}).map((entry) => ({ ...entry, group: "000000000000" }));
    expect(basesOf(flat)).toEqual([]);
    expect(mapOf(flat).basis).toEqual({ kind: "none" });
    expect(mapOf(flat).apps.map((app) => app.name)).toEqual([UNTAGGED]);
  });

  it("orders an application's tiers the way a request travels", () => {
    const tagged = { app: "checkout" };
    const map = mapOf([
      resource("cache", "Microsoft.Cache/redis", tagged),
      resource("logs", "Microsoft.OperationalInsights/workspaces", tagged),
      resource("web", "Microsoft.Web/sites", tagged),
      resource("fn", "Microsoft.Web/sites", tagged),
      ...many(4, "Microsoft.Web/sites", { app: "billing" }, "b"),
      ...many(4, "Microsoft.Web/sites", { app: "reports" }, "c"),
    ]);

    // Tiers are the honest part of the flow: what faces the world, what runs,
    // what holds state, what watches - and only the tiers present appear.
    expect(map.apps.find((app) => app.name === "checkout")?.tiers.map(([tier]) => tier)).toEqual([
      "edge",
      "data",
      "support",
    ]);
  });

  it("draws a kind as one box, biggest first", () => {
    const nodes = nodesOf([
      ...many(3, "lambda/function", {}),
      ...many(5, "dynamodb/table", {}),
      resource("q", "sqs"),
    ]);
    expect(nodes.map((node) => [node.kind, node.resources.length])).toEqual([
      ["dynamodb/table", 5],
      ["lambda/function", 3],
      ["sqs", 1],
    ]);
  });

  it("says plainly when an account holds no resources at all", () => {
    const map = mapOf([]);
    expect(map.basis).toEqual({ kind: "none" });
    expect(map.options).toEqual([]);
    expect(map.apps).toEqual([]);
  });
});

/** One resource in a named region, for the questions that are about regions. */
function inRegion(name: string, kind: string, location: string): CloudResource {
  return { ...resource(name, kind), location };
}

/**
 * The diagram's shape - three lanes always, so "nothing takes requests" is
 * something a person can see rather than something missing from the page.
 * Reported 2026-09-09: an application of 31 functions was drawn as one wide
 * box, which read as the list it was meant to replace.
 */
describe("shapeOf", () => {
  it("draws every lane of the request path, the empty ones included", () => {
    const app = mapOf([resource("Import-One", "lambda/function"), resource("Import-Two", "lambda/function")])
      .apps[0];
    const shape = shapeOf(app);

    expect(shape.path.map(([tier]) => tier)).toEqual(["edge", "compute", "data"]);
    expect(shape.path.map(([, nodes]) => nodes.length)).toEqual([0, 1, 0]);
    expect(shape.path[1]?.[1][0]?.resources).toHaveLength(2);
    expect(shape.support).toEqual([]);
  });

  it("keeps what surrounds an application off the request path", () => {
    const app = mapOf([resource("fn", "lambda/function"), resource("fn-logs", "logs/log-group")]).apps[0];
    const shape = shapeOf(app);

    expect(shape.path.map(([, nodes]) => nodes.length)).toEqual([0, 1, 0]);
    expect(shape.support.map((node) => node.kind)).toEqual(["logs/log-group"]);
  });

  it("names the regions it sits in, busiest first, and ignores the placeless", () => {
    const app = mapOf([
      inRegion("a", "lambda/function", "ap-southeast-1"),
      inRegion("b", "lambda/function", "ap-southeast-1"),
      inRegion("c", "lambda/function", "us-east-1"),
      inRegion("d", "iam/role", ""),
    ]).apps[0];

    expect(shapeOf(app).regions).toEqual([
      { name: "ap-southeast-1", count: 2 },
      { name: "us-east-1", count: 1 },
    ]);
  });
});

describe("regionsOf", () => {
  it("is empty when nothing says where it is - a global account draws no chips", () => {
    expect(regionsOf([inRegion("a", "iam/role", ""), inRegion("b", "iam/role", "")])).toEqual([]);
  });
});
