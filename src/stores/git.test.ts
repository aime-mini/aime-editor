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

/** What git_pending_diff answers; tests set it to the case they are about. */
let pendingDiff = "";
/** Prompts handed to the AI, so a test can assert what the model was asked. */
const oneshotPrompts: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    if (command === "git_pending_diff") return Promise.resolve(pendingDiff);
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
vi.mock("../lib/aiOneshot", () => ({
  aiOneshot: (prompt: string) => {
    oneshotPrompts.push(prompt);
    return Promise.resolve("feat: add the thing");
  },
}));

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

/**
 * The AI chores read one diff, and it has to be the whole uncommitted change.
 * A tree whose only change was a new file used to answer "nothing staged" —
 * `git diff` never shows an untracked file — so the button failed on exactly
 * the change a person is most likely to want described.
 */
describe("AI chores read the pending diff", () => {
  beforeEach(async () => {
    gated = false;
    useWorkspace.setState({ rootPath: "C:\\repo" });
    await settle();
    oneshotPrompts.length = 0;
    useGit.setState({ lastError: null, commitMessage: "" });
  });

  it("describes a change the backend reports, whether or not it is staged", async () => {
    pendingDiff = "diff --git a/feature.ts b/feature.ts\nnew file mode 100644\n+export const answer = 42;";

    await useGit.getState().generateCommitMessage();

    expect(useGit.getState().commitMessage).toBe("feat: add the thing");
    expect(useGit.getState().lastError).toBeNull();
    expect(oneshotPrompts).toHaveLength(1);
    expect(oneshotPrompts[0]).toContain("export const answer = 42;");
  });

  it("says there is nothing to describe, and asks the model nothing", async () => {
    pendingDiff = "   \n";

    await useGit.getState().generateCommitMessage();

    expect(oneshotPrompts).toHaveLength(0);
    expect(useGit.getState().lastError).toBe(
      "Nothing to describe - this working tree has no uncommitted change.",
    );
    expect(useGit.getState().commitMessage).toBe("");
  });

  it("clips a diff too large for one prompt, and says it clipped", async () => {
    pendingDiff = `+${"x".repeat(20_000)}`;

    await useGit.getState().generateCommitMessage();

    const prompt = oneshotPrompts[0] ?? "";
    expect(prompt).toContain("[diff truncated]");
    // Prompt = instructions + 12 000 characters of diff + the marker, so the
    // ceiling is what bounds it rather than the 20 001 characters available.
    expect(prompt.length).toBeLessThan(13_000);
  });
});
