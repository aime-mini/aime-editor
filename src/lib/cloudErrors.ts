/**
 * Reading the CLI's own refusal well enough to offer the fix.
 *
 * A listing that fails is not one thing. Reported 2026-09-09: clicking most
 * Google Cloud projects ended on a wall of red with a "Sign in" button under
 * it - and signing in fixes nothing, because the CLI was not complaining about
 * who you are. It was saying the Cloud Asset API is not enabled, and it named
 * the API and the page that enables it in the same sentence.
 *
 * So the error is parsed rather than displayed and shrugged at. Every field
 * here comes out of the CLI's own words - never a guess about what the message
 * probably means - and the text these patterns were written against is the
 * captured error in `cloudErrors.test.ts`.
 */

/** A Google API the CLI says has to be turned on before this call works. */
export interface DisabledApi {
  /**
   * The API's own id, e.g. `cloudasset.googleapis.com` - taken from the page
   * the CLI offered, because the sentence itself uses the display name. Null
   * when the CLI gave no page, and then there is nothing to enable BY id.
   */
  service: string | null;
  /** What the CLI called it in the sentence, e.g. `Cloud Asset`. */
  display: string;
  /** The project the CLI says it is not enabled in - the one billed for it. */
  project: string;
  /** The console page the CLI itself pointed at, when it gave one. */
  url: string | null;
}

/**
 * `<Display name> API has not been used in project <project> before or it is
 * disabled.`
 *
 * That sentence is Google's, word for word, on every API that needs enabling;
 * the project it names is the one the quota is charged to, which is why it can
 * differ from the project being listed.
 */
const DISABLED_API =
  /([A-Za-z0-9][A-Za-z0-9 .-]*?) API has not been used in project ([a-z0-9][a-z0-9-]*) before or it is disabled/i;

/** The page the CLI offers, which carries the API id and the project in it. */
const ENABLE_URL = /https:\/\/console\.developers\.google\.com\/apis\/api\/(\S+?)\/overview\?\S+/;

/** The API the CLI wants enabled, or null when it is complaining about something else. */
export function disabledApi(reason: string): DisabledApi | null {
  const found = DISABLED_API.exec(reason);
  if (found === null) return null;
  const [, display, project] = found;
  const page = ENABLE_URL.exec(reason);
  // Trailing punctuation belongs to the sentence, not to the URL.
  const url = page === null ? null : page[0].replace(/[.,)\]]+$/, "");
  return { service: page?.[1] ?? null, display: display.trim(), project, url };
}

/**
 * The one command that turns a disabled API on, or null when the CLI named no
 * API id to turn on.
 *
 * Both the API and the project come out of the CLI's own message: which API a
 * call needs is not Aime's guess.
 */
export function enableApiCommand(api: DisabledApi): string | null {
  return api.service === null ? null : `gcloud services enable ${api.service} --project ${api.project}`;
}

/** A project the CLI says has no billing account, and what that stopped. */
export interface BillingOff {
  /**
   * The project as the CLI named it. Measured: `services enable` names the
   * project NUMBER and `app describe` names the id, so this is shown beside
   * the project Aime already knows rather than in place of it.
   */
  project: string;
  /** The APIs it refused to turn on, when the message listed them. */
  services: string[];
}

/**
 * The three sentences Google Cloud uses when a project has no billing account,
 * each captured on a real project (`cloudErrors.test.ts`):
 *
 * - `services enable` - *Billing account for project '130881371924' is not
 *   found. Billing must be enabled for activation of service(s) '…'*
 * - every read on a project whose billing lapsed - *Read access to project
 *   'testfcm-1c2ef' was denied: please check billing account associated*
 * - an API that bills per call - *This API method requires billing to be
 *   enabled. Please enable billing on project #samplebigquery-428108* - found
 *   2026-09-11 by running a planned read against every resource in the
 *   account. Without this one, `gcloud dataplex entry-groups describe` looked
 *   like a wrong command: Aime spent two AI turns trying to fix a command that
 *   was right all along, and then dropped it.
 */
const BILLING_OFF = [
  /Billing account for project '([^']+)' is not found/i,
  /Read access to project '([^']+)' was denied: please check billing account associated/i,
  /This API method requires billing to be enabled\. Please enable billing on project #?([a-z0-9][a-z0-9-]*)/i,
];

/** The services that same message says it could not turn on. */
const BLOCKED_SERVICES = /for activation of service\(s\) '([^']+)'/i;

/**
 * The project whose billing is off, or null when this is some other refusal.
 *
 * Worth telling apart from every other failure because no amount of retrying,
 * signing in or rewriting the command gets past it, and because the fix is one
 * command - `gcloud billing projects link` - as long as an OPEN billing account
 * exists. Creating one does not exist in the CLI at all (measured: `gcloud
 * billing accounts` has describe, list and the IAM verbs, and no `create`), so
 * that is the one case where the panel has to send someone to Google's page.
 */
export function billingOff(reason: string): BillingOff | null {
  const named = BILLING_OFF.map((pattern) => pattern.exec(reason)).find((found) => found !== null);
  if (named === undefined) return null;
  const services = BLOCKED_SERVICES.exec(reason);
  return {
    project: named[1],
    services: services === null ? [] : services[1].split(",").map((service) => service.trim()),
  };
}

/**
 * Whether the CLI is saying nobody is signed in, or that the sign-in expired.
 *
 * Only then is a Sign in button the answer. Measured on this machine: Azure
 * answers `Status_InteractionRequired`, `gcloud` says there is no active
 * account, AWS reports its token as expired, Supabase asks for a token.
 */
const AUTH_WORDS = [
  /status_interactionrequired/i,
  /interactive authentication is needed/i,
  /do not currently have an active account/i,
  /reauthentication (is )?(required|failed)/i,
  /invalid[_ ]grant/i,
  /expired token|token has expired|expiredtoken/i,
  /credentials were refused|unable to locate credentials/i,
  /access token not provided/i,
  /unauthorized/i,
  /please run.*login/i,
];

export function looksLikeSignIn(reason: string): boolean {
  return AUTH_WORDS.some((pattern) => pattern.test(reason));
}

/**
 * Why a command that Aime checked still did not work.
 *
 * The difference decides what happens next, so it is worth telling apart
 * rather than showing one wall of red: a command that cannot address the
 * resource is Aime's to fix - the AI wrote it and can rewrite it - while a
 * project with an API switched off, no billing or an expired sign-in would
 * refuse the RIGHT command just as flatly, and rewriting it there would burn a
 * turn to arrive at the same command.
 */
export type CliRefusal = "wall" | "command";

/**
 * Which of the two a CLI's own words describe.
 *
 * Captured against a real Google account (`cloudErrors.test.ts`): the walls
 * say *Cloud Logging API has not been used in project …*, *Read access to
 * project 'x' was denied: please check billing account associated*, or that
 * nobody is signed in; a wrong command says `HTTPError 404` with an HTML page
 * behind it, or `NOT_FOUND: Bucket \`…\` … does not exist`. Anything Aime
 * cannot place is treated as the command's fault, because that is the half it
 * can do something about.
 */
export function cliRefusal(reason: string): CliRefusal {
  const wall = disabledApi(reason) !== null || billingOff(reason) !== null || looksLikeSignIn(reason);
  return wall ? "wall" : "command";
}

/** How much of a CLI's answer is worth reading when it went wrong. */
const CLI_ERROR_SHOWN = 300;

/**
 * A CLI's refusal as a sentence, not as a web page.
 *
 * Measured 2026-09-11: `gcloud iam service-accounts describe` answers a wrong
 * identifier with `HTTPError 404:` followed by Google's whole HTML error page,
 * doctype and stylesheet included - 1.5 KB of markup where a panel has one
 * line, and the same 1.5 KB in any prompt built out of it. The tags are taken
 * out, the run of whitespace they leave behind is closed up, and what is left
 * is cut to a line a person reads.
 */
export function shortCliError(reason: string): string {
  const text = reason
    .replace(/<!doctype[^>]*>/gi, " ")
    .replace(/<style[^]*?<\/style>/gi, " ")
    .replace(/<script[^]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= CLI_ERROR_SHOWN ? text : `${text.slice(0, CLI_ERROR_SHOWN).trimEnd()}…`;
}
