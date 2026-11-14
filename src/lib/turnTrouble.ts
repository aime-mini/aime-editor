import { asksToSignInAgain } from "./signInAsked";

/**
 * Why an AI CLI's turn gave up, as far as what to do next goes.
 *
 * Neither is the work's fault, and neither is helped by asking the AI again
 * with the same words a second later: a sign-in that expired needs a person,
 * and a service that cannot be reached needs time. Treating either as an
 * answer - which is what a run did before - spent its repair rounds on a dead
 * network and then blamed the code.
 */
export type TurnTrouble = "signIn" | "unreachable";

/**
 * How AI CLIs say the service could not be reached, or would not answer now.
 * The first patterns are measured; the rest is the wording such failures share,
 * so a CLI added through providers.json is recognised as well.
 */
const UNREACHABLE: readonly RegExp[] = [
  // Claude Code 2.1.286, its base URL on a closed port:
  // "API Error: Connection refused - a firewall or proxy may be blocking it (ECONNREFUSED)".
  /\bECONNREFUSED\b/,
  // Codex 0.146.0, its backend on a closed port: "stream disconnected before completion:
  // error sending request for url (...)", after "(os error 10061)" on Windows.
  /\bstream disconnected before completion\b/i,
  /\berror sending request for url\b/i,
  /\bos error (?:10060|10061|10065|111|113)\b/,
  /\b(?:ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/,
  /\bfetch failed\b/i,
  /\bconnection (?:refused|reset|timed out|error)\b/i,
  /\b(?:overloaded|service unavailable|bad gateway|gateway timeout|temporarily unavailable)\b/i,
  /\b(?:status|code|HTTP)\W{0,3}(?:429|5\d\d)\b/i,
  /\btoo many requests\b/i,
  /\b(?:rate|usage) limit\b/i,
  /\bquota\b/i,
];

/** What a failed turn's own words say about why it failed; null when they say nothing this can act on. */
export function troubleIn(said: string): TurnTrouble | null {
  if (asksToSignInAgain(said)) return "signIn";
  if (UNREACHABLE.some((pattern) => pattern.test(said))) return "unreachable";
  return null;
}
