/**
 * How many messages of a conversation are on screen at first, and how many
 * more each "show earlier" adds. A long conversation is hundreds of answers,
 * each a tree of rendered Markdown and tool chips: drawn all at once, every
 * change to the conversation re-checks them all, and thousands of nodes stay
 * alive that nobody has scrolled to.
 */
export const CHAT_PAGE_SIZE = 60;

/** The index of the first message drawn when `pages` pages of `total` are shown. */
export function firstShown(total: number, pages: number): number {
  return Math.max(0, total - CHAT_PAGE_SIZE * pages);
}
