import { describe, expect, it } from "vitest";
import { globToRegExp } from "./glob";

const PATHS = ["yeu-cau/brief.md", "yeu-cau/anh/logo.png", "src/app.ts", "src/lib/cart.ts", "README.md"];

const matched = (glob: string) => PATHS.filter((path) => globToRegExp(glob).test(path));

describe("globToRegExp", () => {
  it("lets ** cross any number of folders, none included", () => {
    expect(matched("yeu-cau/**/*")).toEqual(["yeu-cau/brief.md", "yeu-cau/anh/logo.png"]);
    expect(matched("src/**/*.ts")).toEqual(["src/app.ts", "src/lib/cart.ts"]);
    expect(matched("yeu-cau/**")).toEqual(["yeu-cau/brief.md", "yeu-cau/anh/logo.png"]);
    expect(matched("**/*.md")).toEqual(["yeu-cau/brief.md", "README.md"]);
  });

  it("keeps * and ? inside one folder", () => {
    expect(matched("*.md")).toEqual(["README.md"]);
    expect(matched("src/*")).toEqual(["src/app.ts"]);
    expect(matched("src/ap?.ts")).toEqual(["src/app.ts"]);
  });

  it("reads every other character as itself", () => {
    expect(globToRegExp("a+b(1).md").test("a+b(1).md")).toBe(true);
    expect(globToRegExp("a.md").test("abmd")).toBe(false);
  });
});
