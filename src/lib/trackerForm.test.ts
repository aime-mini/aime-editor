import { describe, expect, it } from "vitest";
import { fillTemplate } from "./trackerForm";

describe("fillTemplate", () => {
  it("hands back a static address untouched", () => {
    expect(fillTemplate("https://id.atlassian.com/manage-profile/security/api-tokens", {})).toBe(
      "https://id.atlassian.com/manage-profile/security/api-tokens",
    );
  });

  it("puts a field in as it was typed, even when the field is a whole origin", () => {
    // The bug this test exists for: percent-encoding turned a self-hosted Jira's
    // own address into https%3A%2F%2Fjira.company.com inside the link.
    expect(fillTemplate("{site}/secure/ViewProfile.jspa", { site: "https://jira.company.com" })).toBe(
      "https://jira.company.com/secure/ViewProfile.jspa",
    );
    // A site typed as a bare host is completed, the way the connectors do it.
    expect(fillTemplate("{site}/secure/ViewProfile.jspa", { site: "jira.company.com" })).toBe(
      "https://jira.company.com/secure/ViewProfile.jspa",
    );
    expect(
      fillTemplate("https://dev.azure.com/{organization}/_usersSettings/tokens", { organization: "iodm" }),
    ).toBe("https://dev.azure.com/iodm/_usersSettings/tokens");
  });

  it("offers nothing while a field it needs is still empty", () => {
    expect(fillTemplate("{site}/secure/ViewProfile.jspa", {})).toBeNull();
    expect(fillTemplate("{site}/x", { site: "   " })).toBeNull();
    expect(fillTemplate("", { site: "jira.company.com" })).toBeNull();
  });

  it("offers nothing when what came out is not a link a browser follows", () => {
    expect(fillTemplate("{site}/x", { site: "not a site at all" })).toBeNull();
    expect(fillTemplate("{site}", { site: "javascript:alert(1)" })).toBeNull();
    expect(fillTemplate("{site}", { site: "file:///c:/windows" })).toBeNull();
  });
});
