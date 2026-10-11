import { invoke } from "@tauri-apps/api/core";
import { useAi } from "../stores/ai";
import { agentTurn } from "./agentTurn";
import { ROOT_SCOPE } from "./knowledge";
import { forgetAll, memoriesWithEvidence, syncMirror, today, writeAll } from "./knowledgeStore";
import {
  askedAgain,
  changesFrom,
  filesWithin,
  memoriesShown,
  outlineOf,
  parseLearned,
  parseState,
  renderState,
  studiedParts,
  studiesDue,
  studyPrompt,
  topFolders,
  type Learned,
  type LearningState,
} from "./projectMap";

/**
 * Learns a project in the background, so the first conversation about it
 * already knows the codebase (`projectMap.ts` decides what to study and how
 * the answers become memories).
 *
 * Invisible by design: no panel, no progress, nothing to approve. Each study is
 * a read-only turn of the person's own CLI with file tools only - it can read
 * the code and nothing else - outside every conversation, one at a time.
 * A failed turn stops the run and the next open picks up where it stopped,
 * since what is left is kept beside the memories.
 */

/** What a run left to do, beside the memories it wrote. */
const STATE_FILE = ".aime/learning.json";

/** Projects being learned now: one opened in two windows is learned once. */
const learning = new Set<string>();

/**
 * Learns the project at `root` when this Aime may start turns of its own -
 * automation driving the person's real CLI turns it off (`background_turns_allowed`).
 */
export async function learnInBackground(root: string): Promise<void> {
  if (!(await invoke<boolean>("background_turns_allowed"))) return;
  if (await cliCanAnswer()) await learnProject(root);
}

/**
 * Whether the chosen CLI is installed and signed in. Asked here when nothing
 * has asked yet: the AI panel asks when it appears, and a project opened with
 * the panel hidden would otherwise never be learned.
 */
async function cliCanAnswer(): Promise<boolean> {
  if (useAi.getState().providerHealth === "unknown") await useAi.getState().checkHealth();
  const { providerHealth, signedIn } = useAi.getState();
  return providerHealth === "ok" && signedIn !== false;
}

/** Studies whatever of the project is due. Never throws: a failure is logged and retried on the next open. */
export async function learnProject(root: string): Promise<void> {
  const base = root.replace(/[\\/]+$/, "");
  if (learning.has(base)) return;
  learning.add(base);
  try {
    await learn(base);
  } catch (error: unknown) {
    console.warn("Aime could not finish learning this project:", error);
  } finally {
    // What was written after the last turn is mirrored, and `.aime/` kept out of git, now rather than at the next turn.
    await syncMirror(base);
    learning.delete(base);
  }
}

async function learn(root: string): Promise<void> {
  const files = await invoke<string[]>("list_files", { root });
  let state = await readState(root);
  const { memories, evidence } = await memoriesWithEvidence(root);
  const queue = studiesDue({ files, memories, evidence, state });
  if (queue.length === 0) return;

  for (let scope = queue.shift(); scope !== undefined; scope = queue.shift()) {
    const learned = await study(root, scope, files);
    if (learned === null) return;
    if (scope === ROOT_SCOPE) {
      const studied = studiedParts(memories);
      queue.push(...learned.parts.filter((part) => !queue.includes(part) && !studied.includes(part)));
      state = { ...state, considered: topFolders(files) };
    }
    state = { ...state, pending: [...queue] };
    await writeState(root, state);
  }
}

/** One study: the turn, then its answer written as memories. Null when the turn gave nothing usable. */
async function study(root: string, scope: string, files: readonly string[]): Promise<Learned | null> {
  // Read again for every study: the one before may have written memories this one should see.
  const { memories, evidence } = await memoriesWithEvidence(root);
  const shown = memoriesShown(memories, scope);
  const prompt = studyPrompt({
    scope,
    outline: outlineOf(filesWithin(files, scope)),
    known: shown,
    evidence,
    studied: studiedParts(memories),
  });
  const learned = await readableAnswer({ root, scope, prompt });
  if (learned === null) return null;
  const { write, forget } = changesFrom({ learned, existing: memories, shown, evidence, day: today() });
  await writeAll(root, write);
  await forgetAll(root, forget);
  return learned;
}

async function readableAnswer(ask: { root: string; scope: string; prompt: string }): Promise<Learned | null> {
  const { root, scope, prompt } = ask;
  // Asked once more when the answer could not be used: a model that ignored the format is told so.
  for (const asked of [prompt, askedAgain(prompt, scope)]) {
    const { code, text } = await agentTurn({
      prompt: asked,
      cwd: root,
      permission: "readOnly",
      tools: "filesOnly",
    });
    if (code !== 0) {
      console.warn(`learning ${scope}: the CLI ended with exit code ${String(code)}`);
      return null;
    }
    const learned = parseLearned(text, { scope, day: today() });
    if (learned !== null) return learned;
  }
  console.warn(`learning ${scope}: twice an answer that could not be used`);
  return null;
}

async function readState(root: string): Promise<LearningState> {
  try {
    return parseState(await invoke<string>("read_file", { path: `${root}/${STATE_FILE}` }));
  } catch {
    return { pending: [], considered: [] }; // never learned here, or learned on another machine
  }
}

async function writeState(root: string, state: LearningState): Promise<void> {
  await invoke("write_file", { path: `${root}/${STATE_FILE}`, content: renderState(state) });
}
