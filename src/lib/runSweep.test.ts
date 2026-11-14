import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { formatBytes, parseInstalled, sweepRun } = await import("./runSweep");

/** A command's outcome as `execRun` answers it. */
function outcome(code: number, stdout = "", stderr = "") {
  return { code, stdout, stderr, durationMs: 1, timedOut: false, cancelled: false, clipped: false };
}

/** The backend as the sweep meets it: one listed install, a scratch folder of 2 MB, a diff of 1 KB. */
function backend(installed: string | null) {
  invoke.mockImplementation((command: string, args: { path?: string }) => {
    if (command === "read_file") {
      return installed === null ? Promise.reject(new Error("no such file")) : Promise.resolve(installed);
    }
    if (command === "path_size") {
      return Promise.resolve(args.path?.endsWith("/scratch") === true ? 2 * 1024 * 1024 : 1024);
    }
    return Promise.resolve(undefined);
  });
}

describe("sweepRun", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("takes back the run's processes, labelled Docker objects, installs and scratch folder", async () => {
    backend(JSON.stringify({ installed: [{ what: "moto", remove: "pip uninstall -y moto" }] }));
    const ran: string[] = [];
    const run = (command: string) => {
      ran.push(command);
      if (command.startsWith("docker ps")) return Promise.resolve(outcome(0, "c1\nc2\n"));
      if (command.startsWith("docker volume ls")) return Promise.resolve(outcome(0, "v1\n"));
      return Promise.resolve(outcome(0));
    };

    const report = await sweepRun({ root: "/p", runId: "run-7", turns: ["run-1", "run-2"], run });

    expect(invoke).toHaveBeenCalledWith("ai_end_left_running", { runIds: ["run-1", "run-2"] });
    expect(ran).toContain('docker ps -aq --filter "label=aime.run=run-7"');
    expect(ran).toContain("docker rm -f c1 c2");
    expect(ran).toContain("docker volume rm -f v1");
    expect(ran).toContain("pip uninstall -y moto");
    expect(invoke).toHaveBeenCalledWith("delete_path", { path: "/p/.aime/runs/run-7/scratch" });
    expect(report).toEqual({ freedBytes: 2 * 1024 * 1024 + 1024, docker: 3, uninstalled: 1, failed: [] });
  });

  it("goes on without Docker on the machine, and says what it could not remove", async () => {
    backend(JSON.stringify({ installed: [{ what: "an SDK", remove: "winget uninstall Some.SDK" }] }));
    const run = (command: string) =>
      Promise.resolve(command.startsWith("docker") ? outcome(1, "", "docker: not found") : outcome(5));

    const report = await sweepRun({ root: "/p", runId: "run-7", turns: [], run });

    expect(report.docker).toBe(0);
    expect(report.uninstalled).toBe(0);
    expect(report.failed).toEqual(["an SDK: `winget uninstall Some.SDK` exited 5"]);
    // The scratch folder still went: one step failing is no reason to leave the rest.
    expect(report.freedBytes).toBeGreaterThan(0);
  });
});

describe("parseInstalled", () => {
  it("reads the installs a run listed, and nothing it could not act on", () => {
    expect(
      parseInstalled(
        JSON.stringify({
          installed: [
            { what: "moto", remove: "pip uninstall -y moto" },
            { what: "no way back", remove: " " },
            "junk",
          ],
        }),
      ),
    ).toEqual([{ what: "moto", remove: "pip uninstall -y moto" }]);
    expect(parseInstalled("not json")).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("says a size the way a person reads it", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3.4 * 1024 ** 3)).toBe("3.4 GB");
    expect(formatBytes(250 * 1024 ** 2)).toBe("250 MB");
  });
});
