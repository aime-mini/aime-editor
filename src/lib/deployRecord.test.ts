import { describe, expect, it } from "vitest";
import type { DeploySlot } from "../stores/deploy";
import { lastDeployLines, parseRecord, recordOf } from "./deployRecord";

const plan = {
  summary: "Deploy shop to Cloud Run from source",
  reply: "",
  target: { existing: true, resourceId: "web", region: "asia-southeast1" },
  proposal: null,
  keep: [],
  steps: [],
  files: [],
  prove: null,
};

const slot = (stage: DeploySlot["stage"]): DeploySlot => ({
  cloudId: "gcp",
  account: {
    id: "my-project",
    label: "My Project",
    detail: "my-project",
    current: false,
    owner: "dev@example.com",
    tenant: "",
    signIn: "",
  },
  stage,
  log: [{ text: "Deploying", kind: "note" }],
  notes: [],
  spentUsd: 0.4,
});

const deployStep = {
  label: "Deploy from source",
  args: ["run", "deploy", "web", "--source", "."],
  changes: "",
};

describe("recordOf", () => {
  it("writes down only a deploy that has come to rest", () => {
    expect(recordOf(slot({ kind: "planning" }), 1, 2)).toBeNull();
    const done = recordOf(
      slot({
        kind: "done",
        plan,
        steps: [{ step: deployStep, state: "passed" }],
        url: "https://web-abc.a.run.app",
        probe: { status: 200, durationMs: 42, bodyHead: "ok" },
        kept: 0,
      }),
      1,
      2,
    );
    expect(done).toMatchObject({
      outcome: "done",
      url: "https://web-abc.a.run.app",
      reason: null,
      spentUsd: 0.4,
    });
    const blocked = recordOf(slot({ kind: "blocked", plan: null, steps: [], reason: "Stopped." }), 1, 2);
    expect(blocked).toMatchObject({ outcome: "blocked", url: null, reason: "Stopped." });
  });
});

describe("parseRecord", () => {
  it("reads back a record of this shape and nothing else", () => {
    const record = recordOf(slot({ kind: "blocked", plan: null, steps: [], reason: "Stopped." }), 1, 2);
    expect(parseRecord(JSON.stringify(record))).toEqual(record);
    expect(parseRecord(JSON.stringify({ ...record, version: 0 }))).toBeNull();
    expect(parseRecord("not json")).toBeNull();
  });
});

describe("lastDeployLines", () => {
  it("tells the next deploy what ran, under which CLI, and how it ended", () => {
    const record = recordOf(
      slot({
        kind: "blocked",
        plan,
        steps: [
          { step: deployStep, state: "failed" },
          {
            step: { label: "Roll", args: ["rollout", "restart"], changes: "", program: "kubectl" },
            state: "pending",
          },
        ],
        reason: "ERROR: quota",
      }),
      1,
      Date.UTC(2026, 10, 15),
    );
    const lines = lastDeployLines(record, "gcloud");
    expect(lines[0]).toContain("2026-11-15T00:00:00.000Z");
    expect(lines).toContain("Plan: Deploy shop to Cloud Run from source");
    expect(lines).toContain("- failed: Deploy from source - gcloud run deploy web --source .");
    expect(lines).toContain("- pending: Roll - kubectl rollout restart");
    expect(lines.at(-1)).toBe("It stopped: ERROR: quota");
    expect(lastDeployLines(null, "gcloud")).toEqual([]);
  });
});
