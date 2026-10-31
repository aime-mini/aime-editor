import { describe, expect, it } from "vitest";
import { touchesListedFolder } from "./listedFolders";

describe("an ignored change the file tree has to show", () => {
  const listed = ["C:/repo", "C:\\repo\\dist"];

  it("is one inside a folder on screen, whichever way its slashes lean", () => {
    expect(touchesListedFolder(["C:\\repo\\dist\\app.js"], listed)).toBe(true);
    expect(touchesListedFolder(["C:\\repo\\.env"], listed)).toBe(true);
  });

  it("is not one deeper inside a folder that is closed", () => {
    expect(touchesListedFolder(["C:\\repo\\data\\profile\\Cache\\f_1"], listed)).toBe(false);
  });

  it("is not one when nothing is listed", () => {
    expect(touchesListedFolder(["C:\\repo\\a.log"], [])).toBe(false);
  });
});
