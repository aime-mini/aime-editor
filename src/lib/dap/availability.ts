/**
 * What Aime knows about debugging one language on this machine, and which part
 * of it is worth putting in front of the user.
 *
 * `dap_availability` gives three different answers and they must not be
 * conflated - doing so is how an editor ends up offering to install a debugger
 * for a README. `undefined` is "not asked yet"; `null` is "Aime drives no
 * adapter for this language", which covers every document, stylesheet and data
 * file as well as the program languages whose adapter has not been driven for
 * real yet; an object is "Aime drives an adapter for this", and `available`
 * then says whether it is here.
 */

import type { MissingDebugger } from "../aiSetup";

/** A program and line a taught adapter can be checked against (learned.rs). */
export interface VerifyWith {
  program: string;
  line: number;
}

/** One device a program can be run on (dap/learned.rs). */
export interface Device {
  id: string;
  label: string;
}

/** Mirror of the Rust `AdapterAvailability` (dap/catalog.rs). */
export interface AdapterAvailability {
  adapterId: string;
  languageId: string;
  configType: string;
  available: boolean;
  /** True when Aime can fetch the adapter itself, with no user action. */
  downloadable: boolean;
  /** True when a run builds the project before the debugger sees it. */
  buildsFirst: boolean;
  installHint: string;
  /** True when this adapter was taught to Aime rather than shipped with it. */
  learned: boolean;
  /** False only for a taught adapter Aime has not yet watched stop somewhere. */
  verified: boolean;
  /** Fields this adapter's launch configuration must carry. */
  launchExtra: Record<string, unknown>;
  verifyWith: VerifyWith | null;
  /**
   * The launch field a chosen device id goes into, when this adapter runs
   * programs somewhere other than this machine. Null for everything desktop.
   */
  deviceField: string | null;
}

/**
 * Whether a run may start on this adapter.
 *
 * A taught adapter that has never been watched stop is exactly the "half a
 * debugger" ARCHITECTURE §5 refuses to ship — it just arrives at run time now
 * instead of in a commit, so the same rule is applied here.
 */
export function usable(adapter: AdapterAvailability): boolean {
  return adapter.available && (!adapter.learned || adapter.verified);
}

/** Aime's answer for a language, in the state the probe leaves it. */
export type AdapterProbe = AdapterAvailability | null | undefined;

/**
 * The debugger that installing something on this machine would provide.
 *
 * This is the only debugging gap worth handing to an agent, and each answer it
 * declines to give is deliberate:
 * - not probed yet, or the adapter is already here: there is no gap.
 * - no adapter for the language: an install cannot close it. Aime debugs what
 *   its catalog has been driven against, so C++ is waiting for an Aime release
 *   and a Markdown file is waiting for nothing at all.
 * - an adapter Aime downloads itself: that is one click in Run and Debug, which
 *   is faster than an agent and costs no tokens.
 */
export function installableDebugger(probe: AdapterProbe): MissingDebugger | null {
  if (probe === null || probe === undefined) return null;
  if (probe.available || probe.downloadable) return null;
  return { adapterId: probe.adapterId, installHint: probe.installHint };
}

/**
 * Documents, stylesheets and data formats: files with no program to step
 * through. A list of documents rather than of programs, because program
 * languages are open-ended — php today, elixir tomorrow — and this list is not.
 */
const DOCUMENT_LANGUAGES = new Set([
  "plaintext",
  "markdown",
  "html",
  "css",
  "scss",
  "less",
  "json",
  "yaml",
  "xml",
  "toml",
  "ini",
  "sql",
  "dockerfile",
]);

/**
 * Whether "teach Aime a debugger for this" is an offer an agent could keep.
 *
 * A language with no adapter used to mean waiting for an Aime release, so the
 * panel said only that. Taught adapters (learned.rs, `dap_verify`) changed the
 * answer for program languages — an agent can install one, write the entry and
 * have Aime check it — but not for a README or a stylesheet, where the offer
 * would still be a promise nothing can keep.
 */
export function teachableLanguage(languageId: string): boolean {
  return !DOCUMENT_LANGUAGES.has(languageId);
}
