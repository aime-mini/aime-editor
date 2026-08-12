import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "./git";

/**
 * refresh() must never run twice at once: overlapping passes were four git
 * processes each, racing one another for .git/index.lock after a checkout —
 * the loser skipped its index write (status stayed slow) and a losing final
 * pass left the panel on the old branch until the app was restarted.
 */

let statusCalls = 0;
/** When true, git_status answers are held until a test releases them. */
let gated = false;
const held: (() => void)[] = [];

function statusOfCall(call: number): GitStatus {
  return { is_repo: true, branch: `branch-${String(call)}`, upstream: null, ahead: 0, behind: 0, files: [] };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    if (command !== "git_status") return Promise.resolve([]);
    statusCalls += 1;
    const answer = statusOfCall(statusCalls);
    if (!gated) return Promise.resolve(answer);
    return new Promise((resolve) => {
      held.push(() => {
        resolve(answer);
      });
    });
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));
vi.mock("../lib/aiOneshot", () => ({ aiOneshot: () => Promise.resolve("") }));

const { useGit } = await import("./git");
const { useWorkspace } = await import("./workspace");

/** Lets every settled promise chain run out before the test looks at state. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("git refresh single-flight", () => {
  beforeEach(async () => {
    gated = false;
    useWorkspace.setState({ rootPath: "C:\\repo" });
    await settle(); // the rootPath subscription fires a refresh; let it drain
    statusCalls = 0;
    held.length = 0;
    gated = true;
  });

  it("folds calls made during a pass into one trailing pass", async () => {
    const first = useGit.getState().refresh();
    const during = [useGit.getState().refresh(), useGit.getState().refresh(), useGit.getState().refresh()];
    expect(statusCalls).toBe(1); // the three latecomers started no processes

    held.shift()?.(); // pass 1 answers
    await vi.waitFor(() => {
      expect(statusCalls).toBe(2); // exactly one trailing pass, not three
    });
    held.shift()?.(); // trailing pass answers
    await Promise.all([first, ...during]);

    expect(statusCalls).toBe(2);
    // The trailing pass ran after the burst, so the newest answer is what stays.
    expect(useGit.getState().status?.branch).toBe("branch-2");
  });

  it("runs a fresh pass once the previous one has finished", async () => {
    const first = useGit.getState().refresh();
    held.shift()?.();
    await first;

    const second = useGit.getState().refresh();
    held.shift()?.();
    await second;

    expect(statusCalls).toBe(2); // sequential calls are not folded
  });
});
