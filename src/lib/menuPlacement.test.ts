import { describe, expect, it } from "vitest";
import { MENU_MARGIN, placeMenu } from "./menuPlacement";

const VIEWPORT = { width: 1200, height: 800 };
const anchor = (x: number, y: number) => ({ x, y });

describe("placeMenu", () => {
  it("leaves a menu that fits exactly where it was asked for", () => {
    expect(placeMenu(anchor(100, 120), { width: 200, height: 300 }, VIEWPORT)).toEqual({
      left: 100,
      top: 120,
    });
  });

  it("opens upwards when there is no room below and room above", () => {
    // 300 tall from y=700 would end at 1000, past the window; above, it starts
    // at 400, which is inside it.
    expect(placeMenu(anchor(100, 700), { width: 200, height: 300 }, VIEWPORT)).toEqual({
      left: 100,
      top: 400,
    });
  });

  it("stays inside the window when a menu is taller than the window itself", () => {
    // The measured bug: 2216px of branches in an 800px window, asked for at
    // y=100. Lifting it by its own height put every branch above the screen.
    const { top } = placeMenu(anchor(100, 100), { width: 200, height: 784 }, VIEWPORT);
    expect(top).toBe(MENU_MARGIN);
  });

  it("never lands on a negative edge, whatever it is asked for", () => {
    const placement = placeMenu(anchor(0, 0), { width: 4000, height: 4000 }, VIEWPORT);
    expect(placement).toEqual({ left: MENU_MARGIN, top: MENU_MARGIN });
  });

  it("opens to the left of the anchor when it would overflow the right edge", () => {
    expect(placeMenu(anchor(1100, 120), { width: 300, height: 200 }, VIEWPORT)).toEqual({
      left: 800,
      top: 120,
    });
  });

  it("pulls a menu back from the bottom edge when it cannot flip either", () => {
    // 495 tall from y=500 overflows the bottom, and flipping puts its top at 5,
    // inside the margin - so it slides up to the last row that keeps it whole.
    const height = 495;
    const { top } = placeMenu(anchor(40, 500), { width: 200, height }, VIEWPORT);
    expect(top).toBe(VIEWPORT.height - MENU_MARGIN - height);
  });

  it("honours a margin the caller sets", () => {
    const { left, top } = placeMenu(anchor(0, 0), { width: 100, height: 100 }, VIEWPORT, 20);
    expect({ left, top }).toEqual({ left: 20, top: 20 });
  });
});
