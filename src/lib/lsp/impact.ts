import { invoke } from "@tauri-apps/api/core";
import type { SymbolProbe, SymbolReferences } from "../blastRadius";
import { languageOf } from "../languages";
import { monaco } from "../monaco";
import { sessionOf, useLsp } from "../../stores/lsp";
import type { LanguageSession } from "./session";

/**
 * "Who else uses this?", answered by the language server rather than guessed.
 *
 * This is the half of a blast radius that needs a real editor, and it is the
 * reason a run inside Aime can say something a bare CLI agent cannot: the
 * server is already indexing the project, and `textDocument/references` is an
 * exact answer where a model's recollection of the callers is a plausible one.
 *
 * A file the run is about to change is usually not open, and Monaco can only
 * ask about buffers it holds - so one is created for the probe and thrown away
 * again, which is what puts the file through `didOpen`/`didClose` on the way.
 */

/**
 * How many symbols of one file are followed.
 *
 * Every symbol costs a round trip, and the tail of a long file is rarely what a
 * change turns on. The cap is a budget, not a claim about the file - what it
 * cuts is reported as unknown further down, never as "nothing depends on it".
 */
const SYMBOLS_PER_FILE = 12;

/**
 * How long the first file is given to produce a reference outside itself, and
 * how often it is asked again while it does not.
 *
 * `whenIndexed` waits for the server to say it has finished loading, which is
 * exact when the server says it - but the grace it falls back on for servers
 * that stay silent is a timer, and a timer races the announcement on a loaded
 * machine. Measured on 2026-08-23: run alone, this repository's own e2e sample
 * answered its dependants; run beside fifteen other specs, the same probe asked
 * before the project was up and got answers confined to the open file.
 *
 * So the timer is only the first attempt. What is polled after it is the thing
 * actually needed - an answer that leaves the file - and once one arrives for a
 * language nothing is retried again: the server has demonstrated its reach, and
 * every later zero from it means what it says.
 */
const REACH_DEADLINE_MS = 20_000;
const REACH_POLL_MS = 500;

/** A probe backed by the language servers this editor already runs. */
export function languageServerProbe(root: string): SymbolProbe {
  // Languages whose server has stopped answering. Asking it again buys nothing
  // and costs the request timeout, once per remaining file.
  const silent = new Set<string>();
  // Languages already waited for. The index is built once per server, and the
  // wait is only ever the first file's.
  const indexed = new Set<string>();
  // Languages whose reach is settled, either way: one file has proved the
  // server sees past what it is handed, or one file has already spent the
  // retry budget failing to. A server that never reaches must cost this run
  // one wait, not one per file - forty files at the deadline is thirteen
  // minutes of a run spent learning the same thing forty times.
  const settled = new Set<string>();

  return {
    dependentsOf: async (file) => {
      const languageId = languageOf(file);
      if (silent.has(languageId)) return null;

      await useLsp.getState().ensure(languageId);
      const session = sessionOf(languageId);
      // No outline means no symbols to follow, which is not the same as a file
      // nothing depends on - and the caller is told which of the two it is.
      if (!session?.providesOutline) return null;

      const borrowed = await borrowModel(root, file, languageId);
      if (borrowed === null) return null;
      try {
        // After the file is open, never before: opening it is what sets a
        // server indexing, and what the wait is waiting for.
        if (!indexed.has(languageId)) {
          await session.whenIndexed();
          indexed.add(languageId);
        }
        const references = await untilItReaches(session, borrowed.model, root, file, {
          retry: !settled.has(languageId),
        });
        settled.add(languageId);
        return references;
      } catch (error: unknown) {
        console.error("blast radius: the language server did not answer for", file, error);
        silent.add(languageId);
        return null;
      } finally {
        borrowed.release();
      }
    },
  };
}

/** Whether anything here names a file other than the one that was asked about. */
function leavesTheFile(references: SymbolReferences[], file: string): boolean {
  const asked = file.replaceAll("\\", "/").toLowerCase();
  return references.some((reference) =>
    reference.files.some((other) => other.replaceAll("\\", "/").toLowerCase() !== asked),
  );
}

/**
 * The references, asked again while the server's answers have not yet left the
 * file - a project that is still loading answers exactly like a project where
 * nothing depends on anything (see `REACH_DEADLINE_MS`).
 *
 * The budget is one file per language, spent by the caller whatever the outcome:
 * after it, an answer confined to one file is taken as a fact about the file -
 * either because the server has shown its reach, or because it has already had
 * its chance to.
 */
async function untilItReaches(
  session: LanguageSession,
  model: monaco.editor.ITextModel,
  root: string,
  file: string,
  { retry }: { retry: boolean },
): Promise<SymbolReferences[]> {
  const startedAt = Date.now();
  for (;;) {
    const references = await referencesIn(session, model, root);
    if (!retry || leavesTheFile(references, file)) return references;
    if (Date.now() - startedAt >= REACH_DEADLINE_MS) return references;
    await new Promise((resolve) => setTimeout(resolve, REACH_POLL_MS));
  }
}

/** Every top-level symbol of the model, and the files referencing each. */
async function referencesIn(
  session: LanguageSession,
  model: monaco.editor.ITextModel,
  root: string,
): Promise<SymbolReferences[]> {
  const symbols = (await session.documentSymbols(model)).slice(0, SYMBOLS_PER_FILE);
  const references: SymbolReferences[] = [];
  for (const symbol of symbols) {
    const locations = await session.references(model, {
      lineNumber: symbol.selectionRange.startLineNumber,
      column: symbol.selectionRange.startColumn,
    });
    references.push({
      symbol: symbol.name,
      files: locations.flatMap((location) => insideProject(root, location.uri.fsPath)),
    });
  }
  return references;
}

/** The model for a file, opening one for the probe when the file is not. */
interface BorrowedModel {
  model: monaco.editor.ITextModel;
  release: () => void;
}

async function borrowModel(root: string, file: string, languageId: string): Promise<BorrowedModel | null> {
  const path = `${root}/${file}`;
  // `Uri.parse`, not `Uri.file`: that is how the editor spells the models it
  // opens, and a different spelling would both miss an open file and leave a
  // second model for it behind.
  const uri = monaco.Uri.parse(path);

  const open = monaco.editor.getModel(uri);
  // A file the user has open is already synced with the server, and disposing
  // it here would close the document under the editor.
  if (open !== null) return { model: open, release: () => undefined };

  const text = await invoke<string>("read_file", { path }).catch((error: unknown) => {
    // The file the phase named does not exist - a plausible path is one of the
    // things a model does invent, and it is not a reason to stop the run.
    console.error("blast radius: could not read", path, error);
    return null;
  });
  if (text === null) return null;

  const created = monaco.editor.createModel(text, languageId, uri);
  return {
    model: created,
    release: () => {
      created.dispose();
    },
  };
}

/** Path segments that are somebody else's code, however much it references us. */
const NOT_OUR_CODE = ["node_modules", "dist", "build", "target", "out"];

/**
 * A referencing file as a path relative to the project, or nothing at all.
 *
 * Two kinds of answer are dropped rather than reported: anything outside the
 * repository, and anything inside a dependency or a build output. Neither is a
 * file the change can break, and listing `node_modules/@types/node/index.d.ts`
 * as depending on a change is how a useful radius turns into noise.
 */
function insideProject(root: string, absolute: string): string[] {
  const clean = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
  const [inside, base] = [clean(absolute), clean(root)];
  if (!inside.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return [];

  const relative = inside.slice(base.length + 1);
  return relative.split("/").some((segment) => NOT_OUR_CODE.includes(segment)) ? [] : [relative];
}
