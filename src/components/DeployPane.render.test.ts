import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccount } from "../stores/cloud";
import type { DeployPlan, DeployStep, StagedFile } from "../lib/deploy";
import type { DeployStage } from "../stores/deploy";

/**
 * The deploy pane is where a person agrees to what runs, so what it renders is
 * part of the promise: the files they agree to are on the page to read, a page
 * missing one cannot be agreed to, and every step carries its command. These
 * render the real component to markup - no DOM, no clicks - and read it.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

const { DeployPane } = await import("./DeployPane");
const { useDeploy } = await import("../stores/deploy");
const { useCloud } = await import("../stores/cloud");

/**
 * Sets a store's state for a server render. Server rendering reads a store's
 * INITIAL state (zustand's server snapshot is `getInitialState`), so the state
 * a test sets is written into that object as well.
 */
function serve<T extends object>(
  store: { getInitialState: () => T; setState: (partial: Partial<T>) => void },
  partial: Partial<T>,
): void {
  store.setState(partial);
  Object.assign(store.getInitialState(), partial);
}

const SLOT = "gcp/acme-shop";

const account: CloudAccount = {
  id: "acme-shop",
  label: "ACME Shop",
  detail: "acme-shop",
  current: false,
  owner: "jane.doe@example.com",
  tenant: "",
  signIn: "",
};

const deployStep: DeployStep = {
  label: "Deploy from source",
  args: ["run", "deploy", "web", "--source", "."],
  changes: "a new revision",
};

const plan: DeployPlan = {
  summary: "Deploy shop to a new Cloud Run service",
  reply: "",
  target: { existing: false, resourceId: null, region: "asia-southeast1" },
  proposal: null,
  keep: [],
  steps: [deployStep],
  files: [{ path: "Dockerfile", why: "the repository has none" }],
  prove: null,
};

const written: StagedFile = {
  path: "Dockerfile",
  why: "the repository has none",
  content: "FROM node:22-slim",
};
const unwritten: StagedFile = { path: "k8s/web.yaml", why: "the workload", content: null };

function rendered(stage: DeployStage, spentUsd = 0): string {
  serve(useDeploy, {
    open: SLOT,
    slots: { [SLOT]: { cloudId: "gcp", account, stage, log: [], notes: [], spentUsd } },
  });
  return renderToStaticMarkup(createElement(DeployPane, { slot: SLOT }));
}

/** The opening markup of the button whose text ends with `label`. */
function button(html: string, label: string): string {
  const at = html.indexOf(` ${label}</button>`);
  if (at === -1) throw new Error(`no button "${label}" on the page`);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, at);
}

const survey = {
  app: { name: "shop", kind: "web", stack: "Node", port: 8080, healthPath: "/healthz", builds: "Dockerfile" },
  existing: [],
  inspect: [],
  missing: [],
};

beforeEach(() => {
  serve(useCloud, { resources: { [SLOT]: { kind: "loaded", resources: [], truncated: false, readAt: 0 } } });
});

describe("the confirm page", () => {
  it("shows every staged file's contents to read before Deploy", () => {
    const html = rendered({ kind: "confirm", survey, plan, answers: [], tooling: [], files: [written] });
    expect(html).toContain('data-staged-file="Dockerfile"');
    expect(html).toContain("<pre");
    expect(html).toContain("FROM node:22-slim");
    expect(button(html, "Deploy")).not.toContain('disabled=""');
  });

  it("cannot be agreed to while a planned file was never written", () => {
    const html = rendered({
      kind: "confirm",
      survey,
      plan,
      answers: [],
      tooling: [],
      files: [written, unwritten],
    });
    expect(html).toContain('data-staged-missing="true"');
    expect(html).toContain("Not written - this file will not be put in place");
    expect(button(html, "Deploy")).toContain('disabled=""');
  });
});

describe("the page that asks about a rewrite", () => {
  it("shows the files the rewrite changed, and holds Go while one is missing", () => {
    const html = rendered({
      kind: "reconfirm",
      plan,
      steps: [{ step: deployStep, state: "failed" }],
      revised: [deployStep],
      changed: [false],
      files: [written, unwritten],
      why: "The step failed.",
    });
    expect(html).toContain("Files it changed");
    expect(html).toContain("FROM node:22-slim");
    expect(button(html, "Run these steps")).toContain('disabled=""');
  });
});

describe("the steps", () => {
  it("carry the command each one runs, scoped as Aime runs it", () => {
    const html = rendered({ kind: "deploying", plan, steps: [{ step: deployStep, state: "running" }] }, 0.42);
    expect(html).toContain("gcloud run deploy web --source . --project acme-shop");
    expect(html).toContain("AI $0.42");
  });

  it("mark a step that was running when the deploy ended as stopped", () => {
    const html = rendered({
      kind: "blocked",
      plan,
      steps: [{ step: deployStep, state: "stopped" }],
      reason: "Stopped.",
    });
    expect(html).toContain("lucide-circle-slash");
  });
});
