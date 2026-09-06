import { activeEditor } from "./monacoAccess";
import { commandOf, type PlannedRead } from "./cloudReads";
import { answerKey, useCloud, type CloudResource } from "../stores/cloud";
import { CLOUD_TAB, useWorkspace } from "../stores/workspace";

/**
 * What the user is looking at, told to the AI with every chat turn.
 *
 * The AI CLI runs in the project folder and sees the files on disk; it does not
 * see the window. Asked "what does this do?" it would have to guess which file,
 * and asked "give me the connection string of this database" while the cloud
 * panel shows exactly that database, it had nothing to go on at all (reported
 * 2026-09-04). So each turn carries a short description of the editor as it
 * stands: the file in front, the selection, the other open tabs, and whichever
 * special view - diff, commit, work item, task run, cloud panel - holds the
 * editor area, with the configuration the panel has already read for the open
 * resource. It is attached to what is sent and never shown as the user's words.
 *
 * Secrets stay out by construction: a read marked `secret` is never included,
 * whether or not the user has revealed it on screen. The rule that a revealed
 * secret lives only in the store and in no prompt is kept here as much as in
 * the panel.
 */

/** The description is context, not the question: caps keep it that. */
const MAX_SELECTION_CHARS = 4_000;
const MAX_READ_CHARS = 6_000;
const MAX_READS_CHARS = 16_000;
const MAX_OTHER_FILES = 20;

/** A view that takes the editor area instead of a file. */
export type SpecialView =
  | { kind: "diff"; path: string }
  | { kind: "commit"; hash: string }
  | { kind: "conflict"; path: string }
  | { kind: "blame"; path: string }
  | { kind: "workItem"; id: string }
  | { kind: "run" }
  | { kind: "cloud"; cloud: CloudFocus };

/** The cloud panel as it stands: which cloud, which account, which resource. */
export interface CloudFocus {
  cloudLabel: string;
  account: { id: string; label: string } | null;
  resource: Pick<CloudResource, "id" | "kind" | "name" | "location" | "group"> | null;
  /** Non-secret reads the panel has already run for that resource. */
  reads: { command: string; json: string }[];
}

/** The editor as the user sees it. Paths are absolute; `rootPath` relativises them. */
export interface ViewSnapshot {
  rootPath: string;
  activeFile: string | null;
  /** Every other file tab, in strip order. */
  otherFiles: string[];
  cursorLine: number | null;
  selection: { startLine: number; endLine: number; text: string } | null;
  /** What holds the editor area when it is not the active file. */
  inFront: SpecialView | null;
}

/**
 * The block prepended to a chat turn, or null when nothing is open - an empty
 * editor is the one case where saying so adds nothing the CLI cannot see.
 */
export function describeView(view: ViewSnapshot): string | null {
  const lines: string[] = [];
  if (view.inFront !== null) lines.push(...describeSpecialView(view.inFront));
  if (view.activeFile !== null) lines.push(...describeFile(view, view.inFront === null));
  if (view.otherFiles.length > 0) {
    const shown = view.otherFiles.slice(0, MAX_OTHER_FILES).map((path) => relative(path, view.rootPath));
    const more = view.otherFiles.length - shown.length;
    lines.push(`- Other open files: ${shown.join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`);
  }
  if (lines.length === 0) return null;
  return [
    "<aime_view>",
    "What is open in the editor right now. Aime attached this; the user did not type it.",
    ...lines,
    "</aime_view>",
  ].join("\n");
}

function describeFile(view: ViewSnapshot, inFront: boolean): string[] {
  if (view.activeFile === null) return [];
  const where = inFront ? "In front" : "Behind it, the active file";
  const cursor = view.cursorLine === null ? "" : `, cursor at line ${String(view.cursorLine)}`;
  const lines = [`- ${where}: @${relative(view.activeFile, view.rootPath)}${cursor}`];
  if (view.selection !== null) {
    const { startLine, endLine } = view.selection;
    const range =
      startLine === endLine ? `line ${String(startLine)}` : `lines ${String(startLine)}-${String(endLine)}`;
    lines.push(`- Selected text (${range}):`, "```", clip(view.selection.text, MAX_SELECTION_CHARS), "```");
  }
  return lines;
}

function describeSpecialView(inFront: SpecialView): string[] {
  switch (inFront.kind) {
    case "diff":
      return [`- In front: the diff of ${inFront.path} against HEAD`];
    case "commit":
      return [`- In front: commit ${inFront.hash}`];
    case "conflict":
      return [`- In front: the merge-conflict resolver for ${inFront.path}`];
    case "blame":
      return [`- In front: the blame view of ${inFront.path}`];
    case "workItem":
      return [`- In front: work item #${inFront.id} from the project's tracker`];
    case "run":
      return ["- In front: a task run (the AI working through a ticket, with its evidence)"];
    case "cloud":
      return describeCloud(inFront.cloud);
  }
}

function describeCloud(cloud: CloudFocus): string[] {
  const account = cloud.account === null ? "" : `, account "${cloud.account.label}" (${cloud.account.id})`;
  const lines = [`- In front: the cloud panel - ${cloud.cloudLabel}${account}`];
  if (cloud.resource === null) return lines;
  const { resource } = cloud;
  const region = resource.location === "" ? "" : `, region ${resource.location}`;
  const group = resource.group === "" ? "" : `, group ${resource.group}`;
  lines.push(`- Open resource: ${resource.kind} "${resource.name}"${region}${group}`, `  id: ${resource.id}`);
  if (cloud.reads.length === 0) return lines;
  lines.push("- Its configuration as the CLI answered (reads that can carry a credential are withheld):");
  let budget = MAX_READS_CHARS;
  for (const read of cloud.reads) {
    if (budget <= 0) {
      lines.push("  (further reads omitted for length)");
      break;
    }
    const allowed = Math.min(MAX_READ_CHARS, budget);
    budget -= Math.min(read.json.length, allowed);
    lines.push(`  $ ${read.command}`, clip(read.json, allowed));
  }
  return lines;
}

/** Repo-relative with forward slashes, the shape an `@` mention takes; absolute when outside. */
function relative(path: string, rootPath: string): string {
  const under = path.startsWith(`${rootPath}\\`) || path.startsWith(`${rootPath}/`);
  return (under ? path.slice(rootPath.length + 1) : path).replaceAll("\\", "/");
}

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (${String(text.length - max)} more characters)`;
}

/** The editor as it stands this instant, read from the stores. */
export function currentView(): ViewSnapshot | null {
  const workspace = useWorkspace.getState();
  if (workspace.rootPath === null) return null;
  const editor = activeEditor();
  const monacoSelection = editor?.getSelection() ?? null;
  const selected =
    monacoSelection === null || monacoSelection.isEmpty()
      ? null
      : {
          startLine: monacoSelection.startLineNumber,
          endLine: monacoSelection.endLineNumber,
          text: editor?.getModel()?.getValueInRange(monacoSelection) ?? "",
        };
  return {
    rootPath: workspace.rootPath,
    activeFile: workspace.openFilePath,
    otherFiles: workspace.openTabs.filter((tab) => tab !== workspace.openFilePath && tab !== CLOUD_TAB),
    cursorLine: editor?.getPosition()?.lineNumber ?? null,
    selection: selected,
    inFront: specialViewInFront(),
  };
}

/** Mirrors the order `EditorPane` decides in: the first view that is set wins. */
function specialViewInFront(): SpecialView | null {
  const w = useWorkspace.getState();
  if (w.cloudOpen) return { kind: "cloud", cloud: cloudFocus() };
  if (w.runOpen) return { kind: "run" };
  if (w.workItemId !== null) return { kind: "workItem", id: w.workItemId };
  if (w.conflictPath !== null) return { kind: "conflict", path: w.conflictPath };
  if (w.blamePath !== null) return { kind: "blame", path: w.blamePath };
  if (w.commitHash !== null) return { kind: "commit", hash: w.commitHash };
  if (w.diffPath !== null) return { kind: "diff", path: w.diffPath };
  return null;
}

function cloudFocus(): CloudFocus {
  const cloud = useCloud.getState();
  const cloudId = cloud.tab;
  const accountId = cloud.selected[cloudId];
  const account = cloud.accounts[cloudId]?.find((candidate) => candidate.id === accountId);
  const resource = cloud.detail;
  return {
    cloudLabel: cloud.clouds.find((candidate) => candidate.id === cloudId)?.label ?? cloudId,
    account: account === undefined ? null : { id: account.id, label: account.label },
    resource:
      resource === null
        ? null
        : {
            id: resource.id,
            kind: resource.kind,
            name: resource.name,
            location: resource.location,
            group: resource.group,
          },
    reads: resource === null || accountId === undefined ? [] : loadedReads(cloudId, accountId, resource),
  };
}

/** The reads already answered for a resource, the ones that never carry a credential. */
function loadedReads(
  cloudId: string,
  accountId: string,
  resource: CloudResource,
): { command: string; json: string }[] {
  const cloud = useCloud.getState();
  const plan = cloud.plans[`${cloudId}/${resource.kind}`];
  if (plan?.kind !== "ready") return [];
  const shareable = (read: PlannedRead) => read.purpose !== "secret";
  return plan.reads.filter(shareable).flatMap((read) => {
    const answer = cloud.answers[answerKey(resource, read)];
    if (answer?.kind !== "loaded") return [];
    return [{ command: commandOf(cloudId, accountId, resource, read), json: answer.json }];
  });
}
