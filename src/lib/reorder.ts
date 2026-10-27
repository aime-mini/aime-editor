/**
 * Where a dragged item lands in a row of others, worked out from what is on
 * screen rather than from indexes, so items of any width reorder alike.
 */

/** `items` with the one at `from` taken out and put back at `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const moved = [...items];
  const [item] = moved.splice(from, 1);
  if (item === undefined) return [...items];
  moved.splice(to, 0, item);
  return moved;
}

/**
 * The index a dragged item takes when let go at `pointerX`: one past every
 * other item whose middle the pointer has crossed.
 *
 * @param others the horizontal extent of every item but the dragged one, in row order.
 */
export function slotAt(pointerX: number, others: readonly { left: number; width: number }[]): number {
  return others.filter((other) => other.left + other.width / 2 < pointerX).length;
}
