import { describe, expect, it } from "vitest";
import type { TaskDef } from "../stores/tasks";
import { statusLine, tasksOfTree, treesReached } from "./runTrees";

/** The layout measured on the user's own `C:\Projects\IODM`: one folder deep, and two. */
const WORKSPACE = "C:\\Projects\\IODM";
const BACKEND = "C:\\Projects\\IODM\\Backend";
const FRONTEND = "C:\\Projects\\IODM\\Frontend\\Front end";
const REPOSITORIES = [BACKEND, FRONTEND];

describe("treesReached", () => {
  it("names the other repositories the files land in, once each, in the order they came", () => {
    const files = [
      "Backend/src/Api/InvoiceController.cs",
      "Frontend/Front end/src/invoice/api.ts",
      "Frontend/Front end/src/invoice/Invoice.tsx",
      "docs/invoices.md",
    ];
    expect(treesReached(files, WORKSPACE, REPOSITORIES, [BACKEND])).toEqual([FRONTEND]);
  });

  it("adds nothing for files in the repositories the run already has, or in none", () => {
    expect(treesReached(["Backend/a.cs", "notes.md"], WORKSPACE, REPOSITORIES, [BACKEND])).toEqual([]);
  });

  it("reads a path written with forward slashes against a workspace written with backslashes", () => {
    expect(treesReached(["frontend/front end/src/x.ts"], WORKSPACE, REPOSITORIES, [BACKEND])).toEqual([
      FRONTEND,
    ]);
  });
});

describe("tasksOfTree", () => {
  const tasks: TaskDef[] = [
    { id: "test", label: "npm test", kind: "test", command: "npm test" },
    { id: "check", label: "lint", kind: "check", command: "npm run lint", cwd: "web" },
  ];

  it("runs a joined repository's tasks from its folder, named after it", () => {
    expect(tasksOfTree(tasks, FRONTEND, WORKSPACE)).toEqual([
      {
        id: "Frontend/Front end:test",
        label: "Frontend/Front end · npm test",
        kind: "test",
        command: "npm test",
        cwd: "Frontend/Front end",
      },
      {
        id: "Frontend/Front end:check",
        label: "Frontend/Front end · lint",
        kind: "check",
        command: "npm run lint",
        cwd: "Frontend/Front end/web",
      },
    ]);
  });
});

describe("statusLine", () => {
  it("reads the same whatever order git listed the files in, and differs once one changes", () => {
    const listed = [
      { path: "src/b.ts", staged: " ", unstaged: "M" },
      { path: "src/a.ts", staged: "?", unstaged: "?" },
    ];
    expect(statusLine(listed)).toBe(statusLine([...listed].reverse()));
    expect(statusLine(listed)).not.toBe(
      statusLine([...listed, { path: "src/c.ts", staged: " ", unstaged: "M" }]),
    );
  });
});
