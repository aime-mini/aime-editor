import { describe, expect, it } from "vitest";
import { tabsClosedBy } from "./tabClosing";

const TABS = ["a.ts", "b.ts", "c.ts", "d.ts"];
const unsaved = new Set(["b.ts", "d.ts"]);
const isDirty = (path: string) => unsaved.has(path);

describe("tabsClosedBy", () => {
  it("closes every tab but the one asked on", () => {
    expect(tabsClosedBy("others", TABS, "b.ts", isDirty)).toEqual(["a.ts", "c.ts", "d.ts"]);
  });

  it("closes the tabs to the right of the one asked on, and nothing for the last", () => {
    expect(tabsClosedBy("right", TABS, "b.ts", isDirty)).toEqual(["c.ts", "d.ts"]);
    expect(tabsClosedBy("right", TABS, "d.ts", isDirty)).toEqual([]);
  });

  it("leaves every tab with unsaved text open, whichever tab it was asked on", () => {
    expect(tabsClosedBy("saved", TABS, "b.ts", isDirty)).toEqual(["a.ts", "c.ts"]);
  });

  it("closes them all", () => {
    expect(tabsClosedBy("all", TABS, "a.ts", isDirty)).toEqual(TABS);
  });
});
