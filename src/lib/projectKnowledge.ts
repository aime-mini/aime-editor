import { invoke } from "@tauri-apps/api/core";
import type { Survey } from "./aiRun";

/**
 * What Aime has read about a project, kept between task runs and handed to
 * every conversation about it.
 *
 * Each run's first step reads the code around its change and writes down how
 * this repository does things, every rule citing the file it was seen in. That
 * reading cost a model call and a few minutes, and it used to be thrown away
 * when the run ended: the next run read the same code again, and the chat knew
 * none of it. Now it is merged into `.aime/project.json` - newest first,
 * without repeats - and rendered as `.aime/PROJECT.md`, which every AI CLI is
 * told to read (`PROGRESS_MEMORY_PROMPT`). It sits in `.aime/`, which no git
 * tracks: it is a cache of what was read, not a rule a person wrote; those go
 * in AGENTS.md.
 */

export const KNOWLEDGE_JSON = ".aime/project.json";
export const KNOWLEDGE_MD = ".aime/PROJECT.md";

/** Lines kept. The oldest go first: the code they describe has had the most time to change. */
const KEPT = 40;

/** One thing a run read about the project. */
export interface Learned {
  text: string;
  kind: "convention" | "tests";
  /** The day it was last seen in the code, `YYYY-MM-DD`. */
  seen: string;
}

/** What one run read merged into what earlier runs read: newest first, each said once. */
export function learnFrom(known: readonly Learned[], survey: Survey, day: string): Learned[] {
  const fresh: Learned[] = [
    ...survey.patterns.map((text): Learned => ({ text, kind: "convention", seen: day })),
    ...(survey.testsLiveIn === "" ? [] : [{ text: survey.testsLiveIn, kind: "tests" as const, seen: day }]),
  ];
  const said = new Set(fresh.map(keyOf));
  // Where tests live has one answer at a time: the newest reading replaces it.
  const testsAnswered = fresh.some((one) => one.kind === "tests");
  const kept = known.filter((old) => !said.has(keyOf(old)) && !(old.kind === "tests" && testsAnswered));
  return [...fresh, ...kept].slice(0, KEPT);
}

/** Reads `project.json`; anything unreadable in it is left out rather than trusted. */
export function parseKnowledge(text: string): Learned[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const learned = (value as { learned?: unknown } | null)?.learned;
  if (!Array.isArray(learned)) return [];
  return learned.flatMap((one: unknown): Learned[] => {
    if (typeof one !== "object" || one === null) return [];
    const { text, kind, seen } = one as Record<string, unknown>;
    if (typeof text !== "string" || text.trim() === "" || (kind !== "convention" && kind !== "tests"))
      return [];
    return [{ text, kind, seen: typeof seen === "string" ? seen : "" }];
  });
}

/** The page every AI CLI reads. */
export function renderKnowledge(learned: readonly Learned[]): string {
  const conventions = learned.filter((one) => one.kind === "convention");
  const tests = learned.find((one) => one.kind === "tests");
  return [
    "# What Aime has read about this project",
    "",
    "Written by Aime from what its task runs read in the code, each line citing where it was seen.",
    "Follow it, check it against the code where it matters, and do not edit it: Aime rewrites this",
    "file after every run. Rules of your own belong in AGENTS.md.",
    ...(conventions.length === 0
      ? []
      : ["", "## How things are done here", "", ...conventions.map((one) => `- ${one.text} (${one.seen})`)]),
    ...(tests === undefined ? [] : ["", "## Tests", "", `- ${tests.text} (${tests.seen})`]),
    "",
  ].join("\n");
}

/** What a run's first step is told about the project before it reads the code itself. */
export function knowledgeBlock(learned: readonly Learned[]): string[] {
  if (learned.length === 0) return [];
  return [
    "What earlier runs read about this repository - confirm it in the code rather than taking it on trust,",
    "and say where it no longer holds:",
    ...learned.map((one) => `- ${one.kind === "tests" ? "Tests: " : ""}${one.text}`),
  ];
}

export async function readKnowledge(root: string): Promise<Learned[]> {
  try {
    return parseKnowledge(await invoke<string>("read_file", { path: `${base(root)}/${KNOWLEDGE_JSON}` }));
  } catch {
    return []; // never written: no run has read this project yet
  }
}

export async function writeKnowledge(root: string, learned: readonly Learned[]): Promise<void> {
  await invoke("write_file", {
    path: `${base(root)}/${KNOWLEDGE_JSON}`,
    content: `${JSON.stringify({ version: 1, learned }, null, 2)}\n`,
  });
  await invoke("write_file", { path: `${base(root)}/${KNOWLEDGE_MD}`, content: renderKnowledge(learned) });
}

/** The same rule said twice in other spacing or case is one rule. */
function keyOf(one: Learned): string {
  return `${one.kind}:${one.text.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

function base(root: string): string {
  return root.replace(/[\\/]+$/, "");
}
