/**
 * What a cloud's pane is showing, named once.
 *
 * A cloud tab has four states and no fifth: the CLIs are still being asked,
 * this cloud's CLI is not on the machine, it is here but nobody has signed in,
 * or there are accounts to work in. Every one of them has its own next move on
 * screen, which is why a blank pane is never right.
 *
 * The name is stamped on the pane as `data-cloud-state`, so "every cloud says
 * one true thing about itself" is a claim that can be checked against the
 * panel's own markup rather than against the words on the page - a cloud's name
 * appearing somewhere else can then never make that pass.
 */
export type PaneState = "looking" | "cli-missing" | "signed-out" | "accounts";

/** The pane's state for one cloud, from what the panel knows about it. */
export function paneStateOf(
  installed: boolean,
  accounts: readonly unknown[] | undefined,
  probing: boolean,
): PaneState {
  if (accounts === undefined) return "looking";
  if (accounts.length > 0) return "accounts";
  // While the CLIs are being asked again, the last answer is not the answer:
  // a cloud whose CLI was missing a moment ago must not offer an install until
  // the probe that would find it has finished.
  if (!installed) return probing ? "looking" : "cli-missing";
  return "signed-out";
}
