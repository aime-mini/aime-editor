import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The evidence gate is the part of "AI drives the app" that Aime itself owns:
 * the agent can claim anything, and these are the checks that decide what the
 * report is allowed to believe. Worth tests because every failure mode here is
 * silent - a stale screenshot, an empty file, a name that matches no case -
 * and each one would otherwise read as proof.
 */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { caseEvidence, caseOf, deployProof } = await import("./evidenceFile");

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  modified_ms: number | null;
  size_bytes: number | null;
}

function file(name: string, over: Partial<Entry> = {}): Entry {
  return {
    name,
    path: `C:/work/.aime/evidence/${name}`,
    is_dir: false,
    modified_ms: 2_000,
    size_bytes: 10,
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("caseOf", () => {
  it("reads the case out of the file name, however the case is cased", () => {
    expect(caseOf("TC1.png", ["TC1", "TC2"])).toBe("TC1");
    expect(caseOf("tc2-after-save.json", ["TC1", "TC2"])).toBe("TC2");
  });

  it("refuses a name that merely contains a case id", () => {
    // "TC1" inside "TC11.png" is a different case, and a file that names no
    // case is not evidence of one.
    expect(caseOf("TC11.png", ["TC1"])).toBeNull();
    expect(caseOf("screenshot.png", ["TC1"])).toBeNull();
  });
});

describe("caseEvidence", () => {
  it("credits a case only with fresh, non-empty files that name it", async () => {
    invoke.mockResolvedValue([
      file("TC1.png"),
      // Each of these claims TC2 and each is disqualified: stale, empty, unsure.
      file("TC2.png", { modified_ms: 500 }),
      file("TC2-second.png", { size_bytes: 0 }),
      file("TC2-third.png", { modified_ms: null }),
    ]);

    const found = await caseEvidence("C:/work", ["TC1", "TC2"], 1_000);
    expect(found.get("TC1")).toEqual(["C:/work/.aime/evidence/TC1.png"]);
    // The case is in the map with nothing behind it - "no evidence" is an
    // answer this map gives, not a missing key.
    expect(found.get("TC2")).toEqual([]);
  });

  it("answers every case as unproved when the folder does not exist", async () => {
    invoke.mockRejectedValue(new Error("no such directory"));
    const found = await caseEvidence("C:/work", ["TC1"], 1_000);
    expect(found.get("TC1")).toEqual([]);
  });
});

describe("deployProof", () => {
  it("takes only what was written during this run", async () => {
    invoke.mockResolvedValue([
      file("health.json", { path: "C:/work/.aime/evidence/deploy/health.json" }),
      file("stale.png", { path: "C:/work/.aime/evidence/deploy/stale.png", modified_ms: 500 }),
    ]);
    await expect(deployProof("C:/work", 1_000)).resolves.toEqual([
      "C:/work/.aime/evidence/deploy/health.json",
    ]);
  });
});
