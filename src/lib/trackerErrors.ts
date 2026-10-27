import type { TranslationKey } from "../i18n/en";

/**
 * What went wrong with a work tracker, in words the panel can show.
 *
 * The Rust side answers with a machine-readable prefix (`TRACKER_AUTH::…`, the
 * same idiom as `CLI_MISSING::` from the AI providers) because the four failures
 * need four different sentences: an expired token is a button, a typo in the
 * project name is a correction, and being offline is neither.
 *
 * The key travels rather than the finished sentence, so a problem shown on
 * screen still follows the user when they switch language.
 */
export interface TrackerProblem {
  key: TranslationKey;
  params: Record<string, string>;
  /** True when reconnecting is what fixes it, which the panel offers directly. */
  needsCredential: boolean;
}

export function explainTrackerError(error: unknown): TrackerProblem {
  const [prefix, ...rest] = String(error).split("::");
  const detail = rest.join("::").trim();
  switch (prefix) {
    case "TRACKER_AUTH":
      return { key: "tracker.error.auth", params: { detail }, needsCredential: true };
    case "TRACKER_NOT_FOUND":
      return { key: "tracker.error.notFound", params: { detail }, needsCredential: false };
    case "TRACKER_NETWORK":
      return { key: "tracker.error.network", params: { detail }, needsCredential: false };
    case "TRACKER_CONFIG":
      return { key: "tracker.error.config", params: { detail }, needsCredential: false };
    case "TRACKER_API": {
      const [, ...message] = rest;
      return {
        key: "tracker.error.api",
        params: { status: rest.length > 0 ? rest[0] : "", detail: message.join("::").trim() },
        needsCredential: false,
      };
    }
    // Anything else is a bug rather than a service saying no; it is shown as it
    // came instead of being dressed up as one of the four.
    default:
      return { key: "tracker.error.unknown", params: { detail: String(error) }, needsCredential: false };
  }
}
