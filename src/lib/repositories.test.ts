import { describe, expect, it } from "vitest";
import {
  foldersUpTo,
  inRepository,
  isWithin,
  relativeTo,
  repositoryLabel,
  repositoryOf,
} from "./repositories";

const WORKSPACE = "C:\\Work\\ACME";
const FRONTEND = "C:\\Work\\ACME\\frontend";
const BACKEND = "C:\\Work\\ACME\\backend";
const WEB = "C:\\Work\\ACME\\apps\\web";

describe("which repository a file belongs to", () => {
  const repositories = [FRONTEND, BACKEND, WEB];

  it("is the one whose root holds it", () => {
    expect(repositoryOf("C:\\Work\\ACME\\backend\\src\\api.cs", repositories)).toBe(BACKEND);
    expect(repositoryOf("C:\\Work\\ACME\\apps\\web\\index.ts", repositories)).toBe(WEB);
  });

  it("is none for a file outside every repository", () => {
    expect(repositoryOf("C:\\Work\\ACME\\README.md", repositories)).toBeNull();
  });

  it("is not a sibling whose name only starts the same way", () => {
    expect(repositoryOf("C:\\Work\\ACME\\frontend-legacy\\a.ts", repositories)).toBeNull();
  });

  it("is the deepest one when repositories nest", () => {
    const nested = "C:\\Work\\ACME\\frontend\\vendored";
    expect(repositoryOf(`${nested}\\lib.ts`, [FRONTEND, nested])).toBe(nested);
  });

  it("does not care which slash or which case a Windows path came back in", () => {
    expect(repositoryOf("c:/work/acme/frontend/src/app.ts", repositories)).toBe(FRONTEND);
    expect(isWithin("C:\\Work\\ACME\\frontend", "c:/work/acme/frontend/")).toBe(true);
  });

  it("does care about case where the file system does", () => {
    expect(isWithin("/home/me/App/src", "/home/me/app")).toBe(false);
  });
});

describe("a path between git and the disk", () => {
  it("is named relative to its repository, the way git names it", () => {
    expect(relativeTo(FRONTEND, "C:\\Work\\ACME\\frontend\\src\\app.ts")).toBe("src/app.ts");
    expect(relativeTo("/home/me/api/", "/home/me/api/src/main.go")).toBe("src/main.go");
  });

  it("comes back to disk in the repository's own separators", () => {
    expect(inRepository(FRONTEND, "src/app.ts")).toBe("C:\\Work\\ACME\\frontend\\src\\app.ts");
    expect(inRepository("/home/me/api", "src/main.go")).toBe("/home/me/api/src/main.go");
  });
});

describe("what a repository is called", () => {
  it("is its folder below the workspace", () => {
    expect(repositoryLabel(FRONTEND, WORKSPACE)).toBe("frontend");
    expect(repositoryLabel(WEB, WORKSPACE)).toBe("apps/web");
  });

  it("is its own name when the workspace sits inside it, or is it", () => {
    expect(repositoryLabel(FRONTEND, "C:\\Work\\ACME\\frontend\\src")).toBe("frontend");
    expect(repositoryLabel(FRONTEND, FRONTEND)).toBe("frontend");
  });
});

describe("the folders the tree marks for a change", () => {
  it("are every folder between the file and the workspace root, the repository's own included", () => {
    expect(foldersUpTo("C:\\Work\\ACME\\frontend\\src\\app.ts", WORKSPACE)).toEqual([
      "C:\\Work\\ACME\\frontend\\src",
      "C:\\Work\\ACME\\frontend",
    ]);
  });

  it("stop at the workspace even when the repository reaches above it", () => {
    expect(
      foldersUpTo("C:\\Work\\ACME\\frontend\\src\\ui\\button.ts", "C:\\Work\\ACME\\frontend\\src"),
    ).toEqual(["C:\\Work\\ACME\\frontend\\src\\ui"]);
  });
});
