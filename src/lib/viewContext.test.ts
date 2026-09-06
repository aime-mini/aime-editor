import { describe, expect, it } from "vitest";
import { describeView, type ViewSnapshot } from "./viewContext";

const ROOT = "C:\\repo";

const empty: ViewSnapshot = {
  rootPath: ROOT,
  activeFile: null,
  otherFiles: [],
  cursorLine: null,
  selection: null,
  inFront: null,
};

describe("describeView", () => {
  it("says nothing for an empty editor", () => {
    expect(describeView(empty)).toBeNull();
  });

  it("names the active file as an @ mention, relative with forward slashes, with the cursor and selection", () => {
    const text = describeView({
      ...empty,
      activeFile: "C:\\repo\\src\\app\\main.ts",
      otherFiles: ["C:\\repo\\README.md", "D:\\elsewhere\\notes.txt"],
      cursorLine: 12,
      selection: { startLine: 10, endLine: 14, text: "const a = 1;\nconst b = 2;" },
    });
    expect(text).toContain("- In front: @src/app/main.ts, cursor at line 12");
    expect(text).toContain("- Selected text (lines 10-14):\n```\nconst a = 1;\nconst b = 2;\n```");
    // A file outside the repository keeps its full path - a relative one would point nowhere.
    expect(text).toContain("- Other open files: README.md, D:/elsewhere/notes.txt");
    expect(text?.startsWith("<aime_view>\n")).toBe(true);
    expect(text?.endsWith("\n</aime_view>")).toBe(true);
  });

  it("puts the view in front first and the active file behind it", () => {
    const text = describeView({
      ...empty,
      activeFile: "C:\\repo\\a.ts",
      inFront: { kind: "diff", path: "src/a.ts" },
    });
    expect(text?.indexOf("the diff of src/a.ts")).toBeLessThan(
      text?.indexOf("Behind it, the active file: @a.ts") ?? -1,
    );
  });

  it("describes the cloud panel down to the open resource and what was read, never a secret", () => {
    const text = describeView({
      ...empty,
      inFront: {
        kind: "cloud",
        cloud: {
          cloudLabel: "AWS",
          account: { id: "default", label: "default" },
          resource: {
            id: "arn:aws:lambda:ap-southeast-2:000000000000:function:pay-api",
            kind: "lambda/function",
            name: "pay-api",
            location: "ap-southeast-2",
            group: "000000000000",
          },
          // `currentView` filters secrets out before this point; the description
          // says so, so the AI does not go looking for them in what it was given.
          reads: [
            { command: "aws lambda get-function --function-name pay-api", json: '{"Runtime":"nodejs20.x"}' },
          ],
        },
      },
    });
    expect(text).toContain('- In front: the cloud panel - AWS, account "default" (default)');
    expect(text).toContain(
      '- Open resource: lambda/function "pay-api", region ap-southeast-2, group 000000000000',
    );
    expect(text).toContain("  id: arn:aws:lambda:ap-southeast-2:000000000000:function:pay-api");
    expect(text).toContain("credential are withheld");
    expect(text).toContain('  $ aws lambda get-function --function-name pay-api\n{"Runtime":"nodejs20.x"}');
  });

  it("clips a long selection and a long read, saying how much was cut", () => {
    const text = describeView({
      ...empty,
      activeFile: "C:\\repo\\big.ts",
      selection: { startLine: 1, endLine: 1, text: "x".repeat(5_000) },
    });
    expect(text).toContain("x".repeat(4_000));
    expect(text).not.toContain("x".repeat(4_001));
    expect(text).toContain("… (1000 more characters)");

    const cloud = describeView({
      ...empty,
      inFront: {
        kind: "cloud",
        cloud: {
          cloudLabel: "Azure",
          account: null,
          resource: {
            id: "/subscriptions/s/x",
            kind: "Microsoft.Web/sites",
            name: "x",
            location: "",
            group: "",
          },
          reads: [
            { command: "az resource show --ids /subscriptions/s/x", json: "a".repeat(7_000) },
            { command: "az webapp config show", json: "b".repeat(7_000) },
            { command: "az webapp log show", json: "c".repeat(7_000) },
          ],
        },
      },
    });
    // 6,000 + 6,000 exhausts most of the 16,000 budget; the third read gets what is left, and the omission is said.
    expect(cloud).toContain("a".repeat(6_000));
    expect(cloud).toContain("b".repeat(6_000));
    expect(cloud).toContain("c".repeat(4_000));
    expect(cloud).not.toContain("c".repeat(4_001));
  });
});
