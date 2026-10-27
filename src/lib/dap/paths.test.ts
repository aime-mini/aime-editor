import { describe, expect, it } from "vitest";
import { fileNameOf, normalizePath, relativeTo, samePath } from "./paths";

describe("samePath", () => {
  it("sees through the two ways Windows spells a path", () => {
    expect(samePath("C:\\Projects\\app.js", "c:/Projects/app.js")).toBe(true);
    expect(samePath("C:\\Projects\\App.js", "c:\\projects\\app.js")).toBe(true);
  });

  it("understands the file URL some adapters answer with", () => {
    expect(samePath("file:///c:/Projects/app.js", "C:\\Projects\\app.js")).toBe(true);
    expect(samePath("file:///home/me/app.py", "/home/me/app.py")).toBe(true);
    expect(samePath("file:///c:/Projects/my%20app.js", "C:\\Projects\\my app.js")).toBe(true);
  });

  it("keeps POSIX paths case-sensitive, where two cases are two files", () => {
    expect(samePath("/home/me/App.py", "/home/me/app.py")).toBe(false);
  });

  it("is false when a frame has no path at all", () => {
    // Frames for eval'd code and node internals arrive without one.
    expect(samePath(undefined, "/home/me/app.py")).toBe(false);
  });

  it("still tells different files apart", () => {
    expect(samePath("C:/p/a.js", "C:/p/b.js")).toBe(false);
  });
});

describe("normalizePath", () => {
  it("leaves a POSIX path alone apart from its separators", () => {
    expect(normalizePath("/home/me/App.py")).toBe("/home/me/App.py");
  });
});

describe("fileNameOf", () => {
  it("is what a call stack shows", () => {
    expect(fileNameOf("C:\\Projects\\src\\app.js")).toBe("app.js");
    expect(fileNameOf("/home/me/app.py")).toBe("app.py");
  });
});

describe("relativeTo", () => {
  it("shortens a path inside the project, keeping the user's capitalisation", () => {
    expect(relativeTo("C:\\Projects\\App", "C:\\Projects\\App\\src\\main.ts")).toBe("src/main.ts");
  });

  it("leaves a path outside the project alone", () => {
    expect(relativeTo("C:\\Projects\\App", "C:\\Other\\lib.js")).toBe("C:\\Other\\lib.js");
  });
});
