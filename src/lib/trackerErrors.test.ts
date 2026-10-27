import { describe, expect, it } from "vitest";
import { explainTrackerError } from "./trackerErrors";

describe("explainTrackerError", () => {
  it("tells a rejected token apart, because that is the one the user can fix", () => {
    const problem = explainTrackerError(
      "TRACKER_AUTH::Azure DevOps answered with its sign-in page - the token is missing, wrong or expired",
    );
    expect(problem.key).toBe("tracker.error.auth");
    expect(problem.needsCredential).toBe(true);
    expect(problem.params.detail).toContain("sign-in page");
  });

  it("keeps the service's own explanation for the other failures", () => {
    expect(explainTrackerError("TRACKER_NOT_FOUND::work item 999: TF401232")).toEqual({
      key: "tracker.error.notFound",
      params: { detail: "work item 999: TF401232" },
      needsCredential: false,
    });
    expect(explainTrackerError("TRACKER_NETWORK::dev.azure.com: dns error")).toEqual({
      key: "tracker.error.network",
      params: { detail: "dev.azure.com: dns error" },
      needsCredential: false,
    });
    expect(explainTrackerError("TRACKER_CONFIG::'project' is missing")).toEqual({
      key: "tracker.error.config",
      params: { detail: "'project' is missing" },
      needsCredential: false,
    });
  });

  it("splits an API refusal into its status and its message", () => {
    expect(explainTrackerError("TRACKER_API::400::VS402337: The state is not valid")).toEqual({
      key: "tracker.error.api",
      params: { status: "400", detail: "VS402337: The state is not valid" },
      needsCredential: false,
    });
  });

  it("shows anything it does not recognise as it came", () => {
    // A bug in Aime must not be dressed up as the service saying no.
    const problem = explainTrackerError(new Error("invoke failed"));
    expect(problem.key).toBe("tracker.error.unknown");
    expect(problem.params.detail).toContain("invoke failed");
    expect(problem.needsCredential).toBe(false);
  });
});
