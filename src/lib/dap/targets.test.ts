import { describe, expect, it } from "vitest";
import { fileTarget, resolveTarget, type DebugTarget, type Resolution } from "./targets";

const ROOT = "C:\\work\\repo";

function target(id: string, languageId: string): DebugTarget {
  return { id, label: id, languageId, program: `${ROOT}\\${id}`, cwd: ROOT };
}

const GO = target("cmd/api", "go");
const NODE = target("web/index.js", "javascript");

/** A candidate that is a folder of its own, the way a monorepo service is. */
function service(name: string, languageId: string): DebugTarget {
  return {
    id: `${languageId}:${name}`,
    label: name,
    languageId,
    program: `${ROOT}\\${name}\\main.go`,
    cwd: `${ROOT}\\${name}`,
  };
}

const API = service("services\\api", "go");
const WORKER = service("services\\worker", "go");

function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
    targets: [],
    chosenId: null,
    openFilePath: `${ROOT}\\web\\lib\\helper.js`,
    openLanguageId: "javascript",
    root: ROOT,
    ...over,
  };
}

describe("resolveTarget", () => {
  it("runs the project's only program, whatever file is open", () => {
    // The bug this whole module exists for: pressing F5 on a helper module used
    // to run the helper module.
    const resolved = resolveTarget(resolution({ targets: [GO] }));
    expect(resolved).toEqual({ target: GO, origin: "only" });
  });

  it("keeps what the user picked, even when the scan finds more", () => {
    const resolved = resolveTarget(resolution({ targets: [GO, NODE], chosenId: NODE.id }));
    expect(resolved).toEqual({ target: NODE, origin: "chosen" });
  });

  it("follows the file being edited into the program it belongs to", () => {
    // Moving between two services is the whole point: no picker, no arguments to
    // re-enter, because the arguments are stored per target.
    const inApi = resolveTarget(
      resolution({
        targets: [API, WORKER],
        openFilePath: `${ROOT}\\services\\api\\handler.go`,
        openLanguageId: "go",
      }),
    );
    expect(inApi).toEqual({ target: API, origin: "nearest" });

    const inWorker = resolveTarget(
      resolution({
        targets: [API, WORKER],
        openFilePath: `${ROOT}\\services\\worker\\queue.go`,
        openLanguageId: "go",
      }),
    );
    expect(inWorker).toEqual({ target: WORKER, origin: "nearest" });
  });

  it("lets the open file overrule a choice made in another program", () => {
    const resolved = resolveTarget(
      resolution({
        targets: [API, WORKER],
        chosenId: WORKER.id,
        openFilePath: `${ROOT}\\services\\api\\handler.go`,
        openLanguageId: "go",
      }),
    );
    expect(resolved).toEqual({ target: API, origin: "nearest" });
  });

  it("keeps the choice when the open file is not inside a program of its own", () => {
    // A shared module, a README: these sit above every candidate, and are no
    // reason to undo a deliberate pick.
    const resolved = resolveTarget(
      resolution({
        targets: [API, WORKER],
        chosenId: WORKER.id,
        openFilePath: `${ROOT}\\shared\\log.go`,
        openLanguageId: "go",
      }),
    );
    expect(resolved).toEqual({ target: WORKER, origin: "chosen" });
  });

  it("prefers the innermost program when candidates nest", () => {
    // The repository root is a candidate too, and it holds every file. Taking it
    // would mean the target never changes, which is the behaviour being fixed.
    const rootProject = target("root", "go");
    const resolved = resolveTarget(
      resolution({
        targets: [rootProject, API],
        openFilePath: `${ROOT}\\services\\api\\handler.go`,
        openLanguageId: "go",
      }),
    );
    expect(resolved).toEqual({ target: API, origin: "nearest" });
  });

  it("matches paths whatever the separators and case", () => {
    // Windows hands paths back both ways, and the same folder can arrive as
    // C:\work\repo or c:/work/repo within one session.
    const resolved = resolveTarget(
      resolution({
        targets: [API, WORKER],
        openFilePath: "c:/WORK/repo/services/API/handler.go",
        openLanguageId: "go",
      }),
    );
    expect(resolved).toEqual({ target: API, origin: "nearest" });
  });

  it("prefers the candidate written in the language of the open file", () => {
    const resolved = resolveTarget(resolution({ targets: [GO, NODE] }));
    expect(resolved).toEqual({ target: NODE, origin: "matched" });
  });

  it("takes the outermost program when nothing matches, and says it assumed", () => {
    // Two languages, neither of them the open file's: this is the case an agent
    // is meant to answer. Until then the panel has to show what it took.
    const resolved = resolveTarget(
      resolution({ targets: [GO, NODE], openFilePath: `${ROOT}\\notes.md`, openLanguageId: "markdown" }),
    );
    expect(resolved).toEqual({ target: GO, origin: "assumed" });
  });

  it("falls back to the open file when the project offers no program", () => {
    const resolved = resolveTarget(resolution());
    expect(resolved?.origin).toBe("file");
    expect(resolved?.target.program).toBe(`${ROOT}\\web\\lib\\helper.js`);
    // Running a loose script by hand happens from the project root, so that is
    // where Aime runs it too.
    expect(resolved?.target.cwd).toBe(ROOT);
  });

  it("lets the open file be the remembered choice, so a rescan does not undo it", () => {
    const openFilePath = `${ROOT}\\scripts\\migrate.js`;
    const chosen = fileTarget(openFilePath, "javascript", ROOT);
    const resolved = resolveTarget(resolution({ targets: [GO, NODE], chosenId: chosen.id, openFilePath }));
    expect(resolved).toEqual({ target: chosen, origin: "chosen" });
  });

  it("has nothing to run with no candidates and no open file", () => {
    expect(resolveTarget(resolution({ openFilePath: null, openLanguageId: null }))).toBeNull();
  });

  it("drops a remembered choice that the project no longer has", () => {
    // A target that was renamed away must not leave F5 pointing at nothing.
    const resolved = resolveTarget(resolution({ targets: [GO], chosenId: "go:cmd/gone" }));
    expect(resolved).toEqual({ target: GO, origin: "only" });
  });
});
