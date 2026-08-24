import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cleanup's whole contract is what it will NOT delete: nothing tracked,
 * nothing that predates the run, nothing the run's record is made of. A bug
 * here erases somebody's work, so every rule gets a test that would catch its
 * absence.
 */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { emptyTrash, freshUntracked, trashOf } = await import("./runTrash");

/** A git status whose untracked files are exactly these. */
function statusWith(untracked: string[]): unknown {
  return {
    is_repo: true,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [
      ...untracked.map((path) => ({ path, orig_path: null, staged: " ", unstaged: "?", conflicted: false })),
      // A modified tracked file, which must never surface as trash.
      { path: "src/cart.js", orig_path: null, staged: " ", unstaged: "M", conflicted: false },
    ],
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("freshUntracked", () => {
  it("keeps only what was not there before the run", () => {
    expect(freshUntracked(["notes.txt"], ["notes.txt", "scratch.log"])).toEqual(["scratch.log"]);
  });

  it("keeps nothing when nothing changed", () => {
    expect(freshUntracked(["notes.txt"], ["notes.txt"])).toEqual([]);
  });
});

describe("trashOf", () => {
  function project(untrackedNow: string[], evidence: { path: string; modified: number }[]): void {
    invoke.mockImplementation((command: string, args: { path?: string }) => {
      if (command === "git_status") return Promise.resolve(statusWith(untrackedNow));
      if (command === "list_dir") {
        const dir = (args.path ?? "").replace(/\\/g, "/");
        return Promise.resolve(
          evidence
            .filter((one) => one.path.startsWith(`${dir}/`) && !one.path.slice(dir.length + 1).includes("/"))
            .map((one) => ({
              name: one.path.split("/").pop(),
              path: one.path,
              is_dir: false,
              modified_ms: one.modified,
              size_bytes: 5,
            })),
        );
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    });
  }

  it("offers only what the run created, and marks the evidence worth keeping", async () => {
    project(
      ["notes.txt", "scratch.log"],
      [
        { path: "C:/work/.aime/evidence/TC1.png", modified: 2_000 },
        { path: "C:/work/test-results/run.png", modified: 2_000 },
      ],
    );

    const items = await trashOf("C:/work", ["notes.txt"], 1_000);
    expect(items.map((item) => [item.shown, item.keeper])).toEqual([
      [".aime/evidence/TC1.png", true],
      ["scratch.log", false],
      ["test-results/run.png", false],
    ]);
    // The pre-existing untracked file and the tracked file are not in the list
    // at all - not even unticked. They were never this run's to offer.
    expect(items.some((item) => item.shown === "notes.txt")).toBe(false);
    expect(items.some((item) => item.shown.includes("cart.js"))).toBe(false);
  });

  it("leaves another run's artifacts alone", async () => {
    project([], [{ path: "C:/work/.aime/evidence/TC1.png", modified: 500 }]);
    await expect(trashOf("C:/work", [], 1_000)).resolves.toEqual([]);
  });
});

describe("emptyTrash", () => {
  it("deletes what it can and names what it could not", async () => {
    invoke.mockImplementation((_command: string, args: { path: string }) =>
      args.path.includes("locked") ? Promise.reject(new Error("in use")) : Promise.resolve(undefined),
    );

    const result = await emptyTrash(["C:/work/scratch.log", "C:/work/locked.log"]);
    expect(result.deleted).toBe(1);
    expect(result.failed).toEqual(["C:/work/locked.log"]);
  });
});
