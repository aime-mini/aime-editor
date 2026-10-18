import { describe, expect, it } from "vitest";
import { linkTarget, localPicture } from "./documentLinks";

const readme = "C:\\work\\shop\\docs\\README.md";

describe("where a link in a Markdown file points", () => {
  it("reads a relative path from the document's own folder", () => {
    expect(linkTarget(readme, "setup.md")).toEqual({ kind: "file", path: "C:\\work\\shop\\docs\\setup.md" });
    expect(linkTarget(readme, "../LICENSE")).toEqual({ kind: "file", path: "C:\\work\\shop\\LICENSE" });
    expect(linkTarget(readme, "./src/app.ts#L10")).toEqual({
      kind: "file",
      path: "C:\\work\\shop\\docs\\src\\app.ts",
    });
    expect(linkTarget(readme, "my%20notes.md")).toEqual({
      kind: "file",
      path: "C:\\work\\shop\\docs\\my notes.md",
    });
  });

  it("keeps the separator of the platform the document lives on", () => {
    expect(linkTarget("/home/me/repo/README.md", "docs/a.md")).toEqual({
      kind: "file",
      path: "/home/me/repo/docs/a.md",
    });
    expect(linkTarget("/home/me/repo/README.md", "/etc/hosts")).toEqual({ kind: "file", path: "/etc/hosts" });
  });

  it("tells anchors and the web apart from files", () => {
    expect(linkTarget(readme, "#getting-started")).toEqual({ kind: "anchor", id: "getting-started" });
    expect(linkTarget(readme, "#c%C3%A0i-%C4%91%E1%BA%B7t")).toEqual({ kind: "anchor", id: "cài-đặt" });
    expect(linkTarget(readme, "https://github.com")).toEqual({ kind: "external", url: "https://github.com" });
    expect(linkTarget(readme, "mailto:a@b.c")).toEqual({ kind: "external", url: "mailto:a@b.c" });
  });

  it("takes absolute and file:// paths as they are", () => {
    expect(linkTarget(readme, "D:\\other\\x.md")).toEqual({ kind: "file", path: "D:\\other\\x.md" });
    expect(linkTarget(readme, "file:///C:/x/y.png")).toEqual({ kind: "file", path: "C:/x/y.png" });
    expect(linkTarget(readme, "file:///home/x/y.png")).toEqual({ kind: "file", path: "/home/x/y.png" });
  });
});

describe("which pictures are on disk", () => {
  it("loads files and leaves the web and inline data to the browser", () => {
    expect(localPicture(readme, "images/logo.png")).toBe("C:\\work\\shop\\docs\\images\\logo.png");
    expect(localPicture(readme, "https://img.shields.io/badge/x.svg")).toBeNull();
    expect(localPicture(readme, "data:image/png;base64,AAAA")).toBeNull();
  });
});
