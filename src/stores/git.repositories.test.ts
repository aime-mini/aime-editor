import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitFile, GitStatus } from "./git";

/**
 * A workspace holding several repositories - the product folder with its
 * frontend and its backend. The panel shows one of them; every operation acts
 * on that one; the tree and the counts see all of them.
 */

const WORKSPACE = "C:\\IODM";
const FRONTEND = "C:\\IODM\\frontend";
const BACKEND = "C:\\IODM\\backend";

/** What `git_repositories` answers; a test changes it to model a `git init`. */
let repositories: string[] = [];
/** Every command the store sent, with its arguments. */
const calls: { command: string; args: Record<string, unknown> }[] = [];

const changed = (path: string): GitFile => ({
  path,
  orig_path: null,
  staged: ".",
  unstaged: "M",
  conflicted: false,
});

function statusOf(root: string): GitStatus {
  const files = root === FRONTEND ? [changed("src/app.ts")] : [changed("api/main.rs"), changed("Cargo.toml")];
  return { is_repo: true, branch: "main", upstream: null, ahead: 0, behind: 0, files };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "git_repositories") return Promise.resolve(repositories);
    if (command === "git_status") return Promise.resolve(statusOf(args.root as string));
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));
vi.mock("../lib/aiOneshot", () => ({ aiOneshot: () => Promise.resolve("") }));

const { useGit, changedFileCount } = await import("./git");
const { useWorkspace } = await import("./workspace");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Opens the workspace and waits for the store to have read it. */
async function openWorkspace(root: string | null) {
  useWorkspace.setState({ rootPath: root, openFilePath: null });
  await vi.waitFor(() => {
    expect(useGit.getState().status).not.toBeNull();
  });
  await settle();
}

describe("a workspace holding several repositories", () => {
  beforeEach(async () => {
    repositories = [FRONTEND, BACKEND];
    useWorkspace.setState({ rootPath: null, openFilePath: null });
    await settle();
    await openWorkspace(WORKSPACE);
    calls.length = 0;
  });

  it("reads every repository and counts the changes of all of them", () => {
    const { statuses, repoRoot } = useGit.getState();
    expect(repoRoot).toBe(FRONTEND);
    expect(Object.keys(statuses).sort()).toEqual([BACKEND, FRONTEND]);
    expect(changedFileCount(useGit.getState())).toBe(3);
  });

  it("acts on the repository chosen, naming files the way git does there", async () => {
    useGit.getState().selectRepository(BACKEND);
    await useGit.getState().stage(["api/main.rs"]);
    expect(calls).toContainEqual({ command: "git_stage", args: { root: BACKEND, paths: ["api/main.rs"] } });
  });

  it("follows the file in front to its repository", async () => {
    useWorkspace.setState({ openFilePath: `${BACKEND}\\api\\main.rs` });
    await settle();
    expect(useGit.getState().repoRoot).toBe(BACKEND);
    expect(useGit.getState().status?.files.map((file) => file.path)).toEqual(["api/main.rs", "Cargo.toml"]);
  });

  it("keeps the message typed for each repository while another is shown", () => {
    useGit.getState().setCommitMessage("fix: the frontend");
    useGit.getState().selectRepository(BACKEND);
    expect(useGit.getState().commitMessage).toBe("");
    useGit.getState().selectRepository(FRONTEND);
    expect(useGit.getState().commitMessage).toBe("fix: the frontend");
  });

  it("closes a diff of the repository left, which would read another file in the next one", () => {
    useWorkspace.getState().openDiff("src/app.ts");
    useGit.getState().selectRepository(BACKEND);
    expect(useWorkspace.getState().diffPath).toBeNull();
  });
});

describe("a workspace with no repository", () => {
  beforeEach(async () => {
    repositories = [];
    useWorkspace.setState({ rootPath: null, openFilePath: null });
    await settle();
    await openWorkspace(WORKSPACE);
    calls.length = 0;
  });

  it("offers to make one, in the workspace itself, and finds it on the next read", async () => {
    expect(useGit.getState().status?.is_repo).toBe(false);
    await useGit.getState().init();
    expect(calls).toContainEqual({ command: "git_init", args: { root: WORKSPACE } });

    repositories = [WORKSPACE]; // what git_init left on disk
    await useGit.getState().refresh();
    expect(useGit.getState().repoRoot).toBe(WORKSPACE);
    expect(useGit.getState().status?.is_repo).toBe(true);
  });

  it("offers nothing once the folder is closed", async () => {
    useWorkspace.setState({ rootPath: null });
    await settle();
    expect(useGit.getState().status).toBeNull();
  });
});
