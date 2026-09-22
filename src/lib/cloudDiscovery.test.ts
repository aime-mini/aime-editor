import { describe, expect, it } from "vitest";
import { discoverPrompt, parseArchitecture } from "./cloudDiscovery";

const INVENTORY = [
  { name: "dotnetvn-test1", kind: "Microsoft.Web/sites", location: "southeastasia", group: "rg-study" },
  {
    name: "ASP-rgdotnetvnstudy",
    kind: "Microsoft.Web/serverFarms",
    location: "southeastasia",
    group: "rg-study",
  },
];

describe("the discovery prompt", () => {
  it("hands over the inventory Aime already read, and says there is no CLI to run", () => {
    const prompt = discoverPrompt({
      cloud: "Azure",
      cli: "az",
      account: "someone@example.com",
      resources: INVENTORY,
      canReadRepo: true,
    });
    expect(prompt).toContain("NO shell and NO cloud CLI");
    expect(prompt).toContain("Azure");
    expect(prompt).toContain("`az`");
    expect(prompt).toContain("someone@example.com");
    // Every row, in the words the panel uses, so a later command can take them.
    expect(prompt).toContain("Microsoft.Web/sites  dotnetvn-test1  southeastasia  rg-study");
    expect(prompt).toContain("Microsoft.Web/serverFarms");
    // And the rule that keeps the answer to those rows.
    expect(prompt).toContain("Every service must be one of the inventory rows above");
  });

  it("says plainly when the account holds nothing, rather than leaving a blank", () => {
    const prompt = discoverPrompt({
      cloud: "Azure",
      cli: "az",
      account: "me",
      resources: [],
      canReadRepo: true,
    });
    expect(prompt).toContain("the account holds no resources");
  });

  /**
   * A CLI Aime cannot hold to a files-only turn does not get an unrestricted
   * one - it gets a turn with no tools, and a brief that does not pretend the
   * repository was read.
   */
  it("asks only about the inventory when the repository cannot be read", () => {
    const prompt = discoverPrompt({
      cloud: "Azure",
      cli: "az",
      account: "me",
      resources: INVENTORY,
      canReadRepo: false,
    });
    expect(prompt).toContain("NO shell and NO cloud CLI");
    expect(prompt).toContain("no way to read this repository");
    expect(prompt).toContain('Leave "deploys"');
    expect(prompt).not.toContain("Read the repository");
    // The inventory and its rules are the same contract either way.
    expect(prompt).toContain("this IS the inventory");
    expect(prompt).toContain("Every service must be one of the inventory rows above");
  });
});

describe("parseArchitecture", () => {
  it("reads the three lists, fenced or not", () => {
    const reply = [
      "```json",
      '{"deploys":["GitHub Actions pushes to the web app"],',
      ' "services":[{"name":"dotnetvn-test1","kind":"web app","where":"southeastasia","notes":"F1 plan"}],',
      ' "gaps":["the static site\'s build source is not in this repository"]}',
      "```",
    ].join("\n");
    const architecture = parseArchitecture(reply);
    expect(architecture?.services).toHaveLength(1);
    expect(architecture?.services[0].name).toBe("dotnetvn-test1");
    expect(architecture?.deploys[0]).toContain("GitHub Actions");
    expect(architecture?.gaps).toHaveLength(1);
  });

  /**
   * The answer that started the rewrite, captured 2026-09-17 by running the old
   * prompt through the CLI Aime spawns for a one-shot (`claude -p --tools ""`).
   * With no tools the model cannot run anything, so it wrote a transcript of
   * commands it had not run - listing files this repository does not contain -
   * and nothing in it parsed. Null is the only honest answer, and it is why the
   * discovery now reads an inventory instead of asking for one.
   */
  it("is null for a reply that only tells the story of running commands", () => {
    const invented = [
      "I'll start by exploring the project files to understand what's configured, then query Azure.",
      "",
      '<invoke name="Bash"><parameter name="command">ls -la</parameter></invoke>',
      "",
      "total 29",
      "drwxr-xr-x 1 linh.pham 4096 0 Sep 17 09:12 .github",
      "drwxr-xr-x 1 linh.pham 4096 0 Sep 17 09:12 infra",
    ].join("\n");
    expect(parseArchitecture(invented)).toBeNull();
  });

  it("is null for an answer that found nothing and said nothing", () => {
    expect(parseArchitecture('{"deploys":[],"services":[],"gaps":[]}')).toBeNull();
    expect(parseArchitecture("I could not tell.")).toBeNull();
  });
});
