/** The bulk close commands of a tab's right-click menu. */
export type CloseScope = "others" | "right" | "saved" | "all";

/**
 * The tabs one of the bulk close commands takes, for the tab it was asked on.
 *
 * "Close Saved" is the one that never costs text: a tab with unsaved changes
 * stays open whichever tab the menu was opened on.
 */
export function tabsClosedBy(
  scope: CloseScope,
  tabs: readonly string[],
  target: string,
  isDirty: (path: string) => boolean,
): string[] {
  switch (scope) {
    case "others":
      return tabs.filter((tab) => tab !== target);
    case "right":
      return tabs.slice(tabs.indexOf(target) + 1);
    case "saved":
      return tabs.filter((tab) => !isDirty(tab));
    case "all":
      return [...tabs];
  }
}
