/**
 * Where a popup menu sits, given the corner it was asked for and the window it
 * has to live in.
 *
 * A menu longer than the window is the normal case rather than the exception:
 * measured on a real machine (2026-08-26) a working repository had 109 local and
 * 1678 remote-tracking branches, and the branch menu that listed them was
 * 2216px tall in an 800px window. Moving such a menu "back into view" by
 * lifting it by its own height puts the whole list above the top of the screen —
 * which is how a full list of branches came to look like no list at all.
 *
 * The rule here is therefore: flip to the other side of the anchor only when the
 * menu fits there, and otherwise stay inside the window. What does not fit is
 * reached by scrolling, never by leaving the screen.
 */

/** Breathing room kept between the menu and every window edge. */
export const MENU_MARGIN = 8;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Placement {
  left: number;
  top: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * @param anchor where the menu was asked to appear (its top-left corner)
 * @param size the menu as measured on screen, already capped by its own CSS
 * @param viewport the window the menu must stay inside
 */
export function placeMenu(
  anchor: Point,
  size: Size,
  viewport: Size,
  margin: number = MENU_MARGIN,
): Placement {
  const lastTop = viewport.height - margin - size.height;
  const flipsUp = anchor.y > lastTop && anchor.y - size.height >= margin;
  const top = flipsUp ? anchor.y - size.height : clamp(anchor.y, margin, lastTop);

  const lastLeft = viewport.width - margin - size.width;
  const flipsLeft = anchor.x > lastLeft && anchor.x - size.width >= margin;
  const left = flipsLeft ? anchor.x - size.width : clamp(anchor.x, margin, lastLeft);

  return { left, top };
}
