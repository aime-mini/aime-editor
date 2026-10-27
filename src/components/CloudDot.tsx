import type { TranslationKey } from "../i18n/en";
import type { CloudStatus } from "../stores/cloud";

/**
 * One cloud's state as a dot: green signed in, red signed out, grey installed
 * but unasked, faint when the CLI is not on this machine.
 *
 * Its own file because the tab strip and the cloud picker both say this, and a
 * colour that means "signed in" in one place and something else in the other
 * is worse than no colour at all.
 */
export function CloudDot({ cloud }: { cloud: CloudStatus }) {
  const tone =
    cloud.signedIn === true
      ? "bg-ok"
      : cloud.signedIn === false
        ? "bg-danger"
        : cloud.installed
          ? "bg-muted"
          : "bg-muted opacity-40";
  return <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}

/** What that dot means, as a sentence - the tab's tooltip and the picker's line. */
export function cloudStateText(cloud: CloudStatus, t: (key: TranslationKey) => string): string {
  if (!cloud.installed) return t("cloud.notInstalled");
  if (cloud.signedIn === false) return t("cloud.signInFirst");
  if (cloud.signedIn === null) return t("cloud.signedInUnknown");
  return cloud.account ?? "";
}
