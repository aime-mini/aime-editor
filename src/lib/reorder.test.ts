import { describe, expect, it } from "vitest";
import { moveItem, slotAt } from "./reorder";

describe("moveItem", () => {
  it("moves an item to the right, the others closing up behind it", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item to the left", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the row as it was for an index that is not in it", () => {
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("slotAt", () => {
  // Three other tabs of different widths: middles at 50, 150 and 260.
  const others = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 120 },
  ];

  it("is the first slot before the first middle", () => {
    expect(slotAt(40, others)).toBe(0);
  });

  it("counts the middles the pointer has crossed", () => {
    expect(slotAt(151, others)).toBe(2);
  });

  it("is the last slot past the last middle", () => {
    expect(slotAt(900, others)).toBe(3);
  });
});
