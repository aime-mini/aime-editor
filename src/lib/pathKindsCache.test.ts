import { describe, expect, it, vi } from "vitest";
import { PathKindsCache, type PathKind } from "./pathKindsCache";

/** Lets queued microtasks and settled promises run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function diskWith(existing: Record<string, PathKind>) {
  return vi.fn((paths: string[]) => Promise.resolve(paths.map((path) => existing[path] ?? null)));
}

const nothing = () => undefined;

describe("the paths a conversation mentions", () => {
  it("asks the questions of one moment as one request", async () => {
    const disk = diskWith({ "a.ts": "file" });
    const cache = new PathKindsCache(disk);
    cache.watch(["a.ts", "b.ts"], nothing);
    cache.watch(["b.ts", "c"], nothing);
    await settle();
    expect(disk).toHaveBeenCalledTimes(1);
    expect(disk).toHaveBeenCalledWith(["a.ts", "b.ts", "c"]);
    expect(cache.kindOf("a.ts")).toBe("file");
    expect(cache.kindOf("b.ts")).toBeUndefined();
  });

  it("does not ask again about a path still being asked", async () => {
    let answer: (kinds: (PathKind | null)[]) => void = nothing;
    const disk = vi.fn(() => new Promise<(PathKind | null)[]>((resolve) => (answer = resolve)));
    const cache = new PathKindsCache(disk);
    cache.watch(["a.ts"], nothing);
    await settle();
    cache.recheck(2);
    await settle();
    expect(disk).toHaveBeenCalledTimes(1);
    answer(["file"]);
    await settle();
    expect(cache.kindOf("a.ts")).toBe("file");
  });

  it("asks about a missing path again only after the disk changed", async () => {
    const disk = diskWith({});
    const cache = new PathKindsCache(disk);
    cache.watch(["new.ts"], nothing);
    await settle();
    cache.watch(["new.ts"], nothing);
    await settle();
    expect(disk).toHaveBeenCalledTimes(1);
    cache.recheck(1);
    await settle();
    expect(disk).toHaveBeenCalledTimes(2);
  });

  it("never asks again about a path that exists", async () => {
    const disk = diskWith({ src: "dir" });
    const cache = new PathKindsCache(disk);
    cache.watch(["src"], nothing);
    await settle();
    cache.recheck(5);
    await settle();
    expect(disk).toHaveBeenCalledTimes(1);
    expect(cache.kindOf("src")).toBe("dir");
  });

  it("tells a message only when one of its paths came back different", async () => {
    const existing: Record<string, PathKind> = {};
    const cache = new PathKindsCache(diskWith(existing));
    const mentionsNew = vi.fn();
    const mentionsOther = vi.fn();
    cache.watch(["new.ts"], mentionsNew);
    cache.watch(["other.ts"], mentionsOther);
    await settle();
    // Both missing, as before: nobody needs to draw anything again.
    expect(mentionsNew).not.toHaveBeenCalled();

    existing["new.ts"] = "file";
    cache.recheck(1);
    await settle();
    expect(mentionsNew).toHaveBeenCalledTimes(1);
    expect(mentionsOther).not.toHaveBeenCalled();
    expect(cache.kindOf("new.ts")).toBe("file");
  });

  it("stops asking for a message that is gone", async () => {
    const disk = diskWith({});
    const cache = new PathKindsCache(disk);
    const stop = cache.watch(["gone.ts"], nothing);
    await settle();
    stop();
    cache.recheck(1);
    await settle();
    expect(disk).toHaveBeenCalledTimes(1);
  });
});
