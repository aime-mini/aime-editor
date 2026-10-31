import { describe, expect, it } from "vitest";
import { CHAT_PAGE_SIZE, firstShown } from "./chatWindow";

describe("the part of a conversation on screen", () => {
  it("draws a short conversation whole", () => {
    expect(firstShown(CHAT_PAGE_SIZE - 1, 1)).toBe(0);
    expect(firstShown(0, 1)).toBe(0);
  });

  it("draws the newest page of a long one", () => {
    expect(firstShown(1100, 1)).toBe(1100 - CHAT_PAGE_SIZE);
  });

  it("adds a page for each time earlier messages are asked for, down to the first", () => {
    expect(firstShown(1100, 2)).toBe(1100 - 2 * CHAT_PAGE_SIZE);
    expect(firstShown(1100, 1000)).toBe(0);
  });
});
