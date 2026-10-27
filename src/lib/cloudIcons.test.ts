import { describe, expect, it } from "vitest";
import { familyOfKind, shortKind, tierOfKind } from "./cloudIcons";

describe("what a kind of cloud resource is, from the name its own CLI gives it", () => {
  it("reads a Google Cloud asset type whole before falling back to its service", () => {
    // `compute` spans five families, so its types are named one by one.
    expect(familyOfKind("compute.googleapis.com/Instance")).toBe("compute");
    expect(familyOfKind("compute.googleapis.com/Firewall")).toBe("security");
    expect(familyOfKind("compute.googleapis.com/ForwardingRule")).toBe("loadBalancer");
    expect(familyOfKind("compute.googleapis.com/Disk")).toBe("disk");
    expect(familyOfKind("compute.googleapis.com/Subnetwork")).toBe("network");
    // Every other service decides for all of its types.
    expect(familyOfKind("run.googleapis.com/Service")).toBe("container");
    expect(familyOfKind("sqladmin.googleapis.com/Instance")).toBe("database");
    expect(familyOfKind("storage.googleapis.com/Bucket")).toBe("storage");
    expect(familyOfKind("pubsub.googleapis.com/Topic")).toBe("queue");
    expect(familyOfKind("secretmanager.googleapis.com/Secret")).toBe("identity");
    // A service this map has never seen is a block, not a wrong icon.
    expect(familyOfKind("unknown.googleapis.com/Thing")).toBe("other");
  });

  it("places Google Cloud kinds in the same tiers as their Azure and AWS cousins", () => {
    expect(tierOfKind("compute.googleapis.com/ForwardingRule")).toBe("edge");
    expect(tierOfKind("run.googleapis.com/Service")).toBe("compute");
    expect(tierOfKind("sqladmin.googleapis.com/Instance")).toBe("data");
    expect(tierOfKind("logging.googleapis.com/LogSink")).toBe("support");
  });

  it("names the three parts of a Supabase project", () => {
    expect(familyOfKind("supabase/database")).toBe("database");
    expect(familyOfKind("supabase/function")).toBe("function");
    expect(familyOfKind("supabase/branch")).toBe("group");
    expect(tierOfKind("supabase/database")).toBe("data");
  });

  it("shortens a kind by the part that is the same on every row", () => {
    expect(shortKind("Microsoft.Web/sites")).toBe("sites");
    expect(shortKind("supabase/function")).toBe("function");
    expect(shortKind("compute.googleapis.com/Instance")).toBe("compute/Instance");
    expect(shortKind("k8s.io/Service")).toBe("k8s.io/Service");
    expect(shortKind("lambda/function")).toBe("lambda/function");
    expect(shortKind("sqs")).toBe("sqs");
  });
});
