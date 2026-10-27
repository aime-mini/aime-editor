import { describe, expect, it } from "vitest";
import { parseArchitecture } from "./cloudDiscovery";
import { renderCloudNote, spliceCloudNote, type CloudNote } from "./cloudMemory";

/**
 * This writes into a file the user owns and every AI CLI reads. Two failures
 * here are silent and expensive: eating somebody's own notes, and stacking a
 * second discovery under the first so the AI reads a stale map as current.
 */

const ARCHITECTURE = {
  deploys: ["GitHub Actions pushes the container to the web app on merge to main"],
  services: [
    {
      name: "aime-web",
      kind: "web app",
      where: "southeastasia / rg-aime",
      notes: "public | staging slot in front",
    },
  ],
  gaps: ["no permission to list key vaults"],
  raw: "{}",
};

const NOTE: CloudNote = {
  label: "Azure",
  account: "Example Subscription",
  architecture: ARCHITECTURE,
  discoveredAt: Date.parse("2026-09-02T10:00:00Z"),
};

describe("renderCloudNote", () => {
  it("writes the names exactly, so a later command can use them", () => {
    const section = renderCloudNote([NOTE]);

    expect(section).toContain("### Azure — Example Subscription");
    expect(section).toContain("aime-web");
    expect(section).toContain("southeastasia / rg-aime");
    expect(section).toContain("_Discovered 2026-09-02._");
  });

  it("states what it could not see", () => {
    // A map that does not say where it ends gets read as complete, and the
    // next answer taken from it is wrong.
    expect(renderCloudNote([NOTE])).toContain("no permission to list key vaults");
  });

  it("escapes a pipe, which would otherwise split the row it sits in", () => {
    expect(renderCloudNote([NOTE])).toContain("public \\| staging slot in front");
  });

  it("says nothing at all when no cloud has been discovered", () => {
    expect(renderCloudNote([])).toBe("");
  });
});

describe("spliceCloudNote", () => {
  const section = renderCloudNote([NOTE]);

  it("appends to a file that has no managed section yet, keeping what is there", () => {
    const spliced = spliceCloudNote("# Notes\n\nWe use zustand for state.\n", section);

    expect(spliced).toContain("We use zustand for state.");
    expect(spliced).toContain("### Azure — Example Subscription");
  });

  it("replaces the section rather than stacking a second one", () => {
    const again = renderCloudNote([{ ...NOTE, account: "OtherSubscription" }]);
    const spliced = spliceCloudNote(spliceCloudNote("# Notes\n", section), again);

    expect(spliced).toContain("OtherSubscription");
    expect(spliced).not.toContain("Example Subscription");
    // One marker pair, not two: a stale map left above a fresh one is the worst
    // of the three possible outcomes here.
    expect(spliced.match(/aime:cloud/g)).toHaveLength(2);
  });

  it("never touches a person's own notes", () => {
    const mine = "# Notes\n\nDo not rename the store keys.\n";
    const spliced = spliceCloudNote(spliceCloudNote(mine, section), renderCloudNote([NOTE]));

    expect(spliced).toContain("Do not rename the store keys.");
  });

  it("keeps notes written after the section, in their place", () => {
    const withTail = `${spliceCloudNote("# Notes\n", section)}\n## My own heading\n\nkeep me\n`;
    const spliced = spliceCloudNote(withTail, renderCloudNote([NOTE]));

    expect(spliced).toContain("## My own heading");
    expect(spliced).toContain("keep me");
  });

  it("removes the section when there is nothing to say, rather than leaving an empty pair", () => {
    // An empty marker pair tells a reader a discovery happened and found
    // nothing, which is not the same as no discovery having happened.
    const spliced = spliceCloudNote(spliceCloudNote("# Notes\n", section), "");

    expect(spliced).not.toContain("aime:cloud");
    expect(spliced).toContain("# Notes");
  });

  it("leaves a file alone when there is nothing to write and no section to remove", () => {
    expect(spliceCloudNote("# Notes\n", "")).toBe("# Notes\n");
  });
});

describe("parseArchitecture", () => {
  it("reads services, deployments and the gaps together", () => {
    const found = parseArchitecture(
      `{"deploys": ["a script pushes to the bucket"],
        "services": [{"name": "assets", "kind": "bucket", "where": "us-east-1", "notes": "public read"}],
        "gaps": ["did not check other regions"]}`,
    );

    expect(found?.services[0].name).toBe("assets");
    expect(found?.deploys).toEqual(["a script pushes to the bucket"]);
    expect(found?.gaps).toEqual(["did not check other regions"]);
  });

  it("survives a model that fences its JSON and explains afterwards", () => {
    const found = parseArchitecture(
      '```json\n{"services": [{"name": "db", "kind": "database", "where": "eu", "notes": ""}]}\n```\nHope that helps!',
    );

    expect(found?.services).toHaveLength(1);
  });

  it("drops a service with no name, which nothing could be looked up from", () => {
    const found = parseArchitecture(
      '{"services": [{"kind": "queue", "where": "eu", "notes": "x"}], "gaps": ["saw one queue"]}',
    );

    expect(found?.services).toEqual([]);
  });

  it("answers null for prose, so nothing gets written into the memory file", () => {
    // A note nobody can trust is worse in that file than no note.
    expect(parseArchitecture("I had a look and it seems fine.")).toBeNull();
    expect(parseArchitecture('{"services": [], "deploys": [], "gaps": []}')).toBeNull();
  });
});
