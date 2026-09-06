import { translate } from "../i18n";

/**
 * The backend's structured spawn failures, turned into a localized sentence.
 *
 * Both prefixes carry the CLI's name because the reader's next move depends on
 * it, and both are raised before any token is spent. Anything else is passed
 * through: a CLI's own stderr says more than a message written about it.
 */
export function formatProviderError(error: unknown): string {
  const raw = String(error);

  const missing = /^CLI_MISSING::(.+?)::([\s\S]*)$/.exec(raw);
  if (missing) return translate("ai.cliMissing", { cli: missing[1], error: missing[2] });

  const needsStdin = /^PROMPT_NEEDS_STDIN::(.+)$/.exec(raw);
  if (needsStdin) return translate("ai.promptNeedsStdin", { cli: needsStdin[1] });

  return raw;
}
