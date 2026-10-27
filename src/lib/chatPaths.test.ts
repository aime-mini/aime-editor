import { describe, expect, it } from "vitest";
import { mentionInCode, mentionInHref, mentionsInText, resolvePath } from "./chatPaths";

const ROOT = "C:\\work\\shop";

describe("mentionsInText", () => {
  it("finds absolute Windows and POSIX paths, and relative ones with a separator", () => {
    const text = "Wrote C:\\work\\shop\\out\\report.html and /tmp/aime/log.txt, see src/app.ts.";
    expect(mentionsInText(text, ROOT).map((m) => [text.slice(m.start, m.end), m.path])).toEqual([
      ["C:\\work\\shop\\out\\report.html", "C:\\work\\shop\\out\\report.html"],
      ["/tmp/aime/log.txt", "/tmp/aime/log.txt"],
      ["src/app.ts", "C:\\work\\shop\\src\\app.ts"],
    ]);
  });

  it("keeps the short name Windows gives a long folder inside the path", () => {
    const text = "Saved to C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\clip.mp4 for you.";
    expect(mentionsInText(text, ROOT).map((m) => m.path)).toEqual([
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\clip.mp4",
    ]);
    expect(mentionInCode("work/PROGRA~1/run.log", ROOT)?.path).toBe(
      "C:\\work\\shop\\work\\PROGRA~1\\run.log",
    );
  });

  it("takes the line an answer points at, and leaves the sentence's punctuation out", () => {
    const text = "The bug is in src/cart.ts:42:7.";
    const [mention] = mentionsInText(text, ROOT);
    expect(text.slice(mention.start, mention.end)).toBe("src/cart.ts:42:7");
    expect(mention.line).toBe(42);
  });

  it("does not read a bare word or the inside of an address as a path", () => {
    expect(mentionsInText("Edit README.md now", ROOT)).toEqual([]);
    expect(mentionsInText("https://example.com/a/b", ROOT)).toEqual([]);
  });
});

describe("mentionInCode", () => {
  it("reads a code span that is a path, with or without a line", () => {
    expect(mentionInCode("package.json", ROOT)?.path).toBe("C:\\work\\shop\\package.json");
    expect(mentionInCode("C:\\Program Files\\Aime\\aime.exe", ROOT)?.path).toBe(
      "C:\\Program Files\\Aime\\aime.exe",
    );
    expect(mentionInCode("src/lib/cart.ts:12", ROOT)).toMatchObject({
      path: "C:\\work\\shop\\src\\lib\\cart.ts",
      line: 12,
    });
  });

  it("leaves code that is not a path alone", () => {
    expect(mentionInCode("npm run build", ROOT)).toBeNull();
    expect(mentionInCode("useState()", ROOT)).toBeNull();
    expect(mentionInCode("fetch", ROOT)).toBeNull();
  });
});

describe("mentionInHref", () => {
  it("reads file addresses and relative targets, and leaves web addresses to the browser", () => {
    expect(mentionInHref("file:///C:/work/shop/a%20b.md", ROOT)?.path).toBe("C:/work/shop/a b.md");
    expect(mentionInHref("file:///home/me/x.txt", ROOT)?.path).toBe("/home/me/x.txt");
    expect(mentionInHref("docs/setup.md#L9", ROOT)).toMatchObject({
      path: "C:\\work\\shop\\docs\\setup.md",
      line: 9,
    });
    expect(mentionInHref("https://example.com", ROOT)).toBeNull();
    expect(mentionInHref("mailto:a@b.c", ROOT)).toBeNull();
  });
});

describe("resolvePath", () => {
  it("joins a relative path to the workspace in the workspace's own spelling", () => {
    expect(resolvePath("./src/a.ts", "/home/me/shop/")).toBe("/home/me/shop/src/a.ts");
    expect(resolvePath("src/a.ts", ROOT)).toBe("C:\\work\\shop\\src\\a.ts");
  });
});
