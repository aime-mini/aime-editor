import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { putChangeBack, setChangeAside } = await import("./heldOut");

/** A disk and a HEAD, in memory: path -> content. */
let disk: Map<string, string>;
let head: Map<string, string>;
/** Fails the nth rename, to cut a set-aside off half way. */
let failRenameAt: number | null;
let renames = 0;

beforeEach(() => {
  disk = new Map([
    ["/p/src/cart.js", "changed cart"],
    ["/p/src/new.js", "a new file"],
    ["/p/test.cjs", "the test"],
  ]);
  head = new Map([
    ["src/cart.js", "cart as it was"],
    ["src/gone.js", "a file the change deleted"],
  ]);
  failRenameAt = null;
  renames = 0;
  invoke.mockReset();
  invoke.mockImplementation((command: string, args: Record<string, string>) => {
    switch (command) {
      case "write_file":
        disk.set(args.path, args.content);
        return Promise.resolve();
      case "read_file":
        return disk.has(args.path)
          ? Promise.resolve(disk.get(args.path))
          : Promise.reject(new Error("no file"));
      case "path_size":
        return disk.has(args.path) ? Promise.resolve(1) : Promise.reject(new Error("no file"));
      case "delete_path":
        for (const key of [...disk.keys()])
          if (key === args.path || key.startsWith(`${args.path}/`)) disk.delete(key);
        return Promise.resolve();
      case "rename_path": {
        renames += 1;
        if (renames === failRenameAt) return Promise.reject(new Error("the disk said no"));
        const content = disk.get(args.from);
        if (content === undefined) return Promise.reject(new Error("no file"));
        disk.delete(args.from);
        disk.set(args.to, content);
        return Promise.resolve();
      }
      case "git_show_head":
        return Promise.resolve(head.get(args.path) ?? "");
      default:
        return Promise.reject(new Error(`unexpected ${command}`));
    }
  });
});

const CHANGE = [
  { path: "src/cart.js", state: "modified" as const },
  { path: "src/new.js", state: "added" as const },
  { path: "src/gone.js", state: "deleted" as const },
];

/** The project's own files, without the run's bookkeeping. */
function project(): Record<string, string> {
  return Object.fromEntries([...disk].filter(([path]) => !path.includes("/.aime/")));
}

describe("setChangeAside and putChangeBack", () => {
  it("leaves the tree as HEAD has it, then puts every file back as it was", async () => {
    const before = project();
    await setChangeAside("/p", "run-1", CHANGE);
    expect(project()).toEqual({
      "/p/src/cart.js": "cart as it was",
      "/p/src/gone.js": "a file the change deleted",
      "/p/test.cjs": "the test",
    });

    expect(await putChangeBack("/p", "run-1")).toEqual([]);
    expect(project()).toEqual(before);
    expect([...disk.keys()].some((path) => path.includes("/held-out"))).toBe(false);
  });

  it("puts back a change cut off half way, and again does nothing harmful", async () => {
    const before = project();
    failRenameAt = 2;
    await expect(setChangeAside("/p", "run-1", CHANGE)).rejects.toThrow("the disk said no");

    expect(await putChangeBack("/p", "run-1")).toEqual([]);
    expect(project()).toEqual(before);
    // Nothing set aside any more: a second call finds no list and changes nothing.
    expect(await putChangeBack("/p", "run-1")).toEqual([]);
    expect(project()).toEqual(before);
  });
});
