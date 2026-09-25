import { describe, expect, it } from "vitest";
import {
  foldersUpTo,
  inRepository,
  isWithin,
  relativeTo,
  repositoryLabel,
  repositoryOf,
} from "./repositories";

const WORKSPACE = "C:\\Work\\IODM";
const FRONTEND = "C:\\Work\\IODM\\frontend";
const BACKEND = "C:\\Work\\IODM\\backend";
const WEB = "C:\\Work\\IODM\\apps\\web";

describe("which repository a file belongs to", () => {
  const repositories = [FRONTEND, BACKEND, WEB];

  it("is the one whose root holds it", () => {
    expect(repositoryOf("C:\\Work\\IODM\\backend\\src\\api.cs", repositories)).toBe(BACKEND);
    expect(repositoryOf("C:\\Work\\IODM\\apps\\web\\index.ts", repositories)).toBe(WEB);
  });

  it("is none for a file outside every repository", () => {
    expect(repositoryOf("C:\\Work\\IODM\\README.md", repositories)).toBeNull();
  });

  it("is not a sibling whose name only starts the same way", () => {
    expect(repositoryOf("C:\\Work\\IODM\\frontend-legacy\\a.ts", repositories)).toBeNull();
  });

  it("is the deepest one when repositories nest", () => {
    const nested = "C:\\Work\\IODM\\frontend\\vendored";
    expect(repositoryOf(`${nested}\\lib.ts`, [FRONTEND, nested])).toBe(nested);
  });

  it("does not care which slash or which case a Windows path came back in", () => {
    expect(repositoryOf("c:/work/iodm/frontend/src/app.ts", repositories)).toBe(FRONTEND);
    expect(isWithin("C:\\Work\\IODM\\frontend", "c:/work/iodm/frontend/")).toBe(true);
  });

  it("does care about case where the file system does", () => {
    expect(isWithin("/home/me/App/src", "/home/me/app")).toBe(false);
  });
});

describe("a path between git and the disk", () => {
  it("is named relative to its repository, the way git names it", () => {
    expect(relativeTo(FRONTEND, "C:\\Work\\IODM\\frontend\\src\\app.ts")).toBe("src/app.ts");
    expect(relativeTo("/home/me/api/", "/home/me/api/src/main.go")).toBe("src/main.go");
  });

  it("comes back to disk in the repository's own separators", () => {
    expect(inRepository(FRONTEND, "src/app.ts")).toBe("C:\\Work\\IODM\\frontend\\src\\app.ts");
    expect(inRepository("/home/me/api", "src/main.go")).toBe("/home/me/api/src/main.go");
  });
});

describe("what a repository is called", () => {
  it("is its folder below the workspace", () => {
    expect(repositoryLabel(FRONTEND, WORKSPACE)).toBe("frontend");
    expect(repositoryLabel(WEB, WORKSPACE)).toBe("apps/web");
  });

  it("is its own name when the workspace sits inside it, or is it", () => {
    expect(repositoryLabel(FRONTEND, "C:\\Work\\IODM\\frontend\\src")).toBe("frontend");
    expect(repositoryLabel(FRONTEND, FRONTEND)).toBe("frontend");
  });
});

describe("the folders the tree marks for a change", () => {
  it("are every folder between the file and the workspace root, the repository's own included", () => {
    expect(foldersUpTo("C:\\Work\\IODM\\frontend\\src\\app.ts", WORKSPACE)).toEqual([
      "C:\\Work\\IODM\\frontend\\src",
      "C:\\Work\\IODM\\frontend",
    ]);
  });

  it("stop at the workspace even when the repository reaches above it", () => {
    expect(
      foldersUpTo("C:\\Work\\IODM\\frontend\\src\\ui\\button.ts", "C:\\Work\\IODM\\frontend\\src"),
    ).toEqual(["C:\\Work\\IODM\\frontend\\src\\ui"]);
  });
});
