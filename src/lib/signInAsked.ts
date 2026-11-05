/**
 * The wording AI CLIs use when their sign-in has stopped working.
 *
 * A CLI's own status cannot tell: `claude auth status` (2.1.318) and
 * `codex login status` (0.146.0) both kept reporting a login whose refresh
 * token was no longer accepted, because they read the stored credentials
 * without using them. Only the turn that uses them finds out, and says so in
 * its error. The first patterns are what those CLIs print; the rest is the
 * wording sign-in failures share, so a CLI added through providers.json is
 * recognised as well.
 */
const SIGN_IN_ASKED: readonly RegExp[] = [
  // Claude Code 2.1.318: "Failed to authenticate: OAuth session expired and could not be refreshed".
  /\bfailed to authenticate\b/i,
  // Codex 0.146.0: "Your access token could not be refreshed. Please log out and sign in again."
  /\b(sign|log)\s?in again\b/i,
  /\b(token|session|credentials?)\b[^.]*\b(expired|revoked|could not be refreshed)\b/i,
  // Claude Code signed out: "Not logged in · Please run /login".
  /\bnot (signed|logged) in\b/i,
  /\brun \/?login\b/i,
  /\b(unauthori[sz]ed|unauthenticated|not authenticated)\b/i,
  /\bre-?authenticate\b/i,
];

/** Whether an AI CLI's error says its sign-in has to be done again. */
export function asksToSignInAgain(error: string): boolean {
  return SIGN_IN_ASKED.some((pattern) => pattern.test(error));
}
