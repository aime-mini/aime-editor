/**
 * What a plugin may ask Aime for, and what Aime will not let it do.
 *
 * Pure on purpose: these are the rules that keep a plugin from being a way to
 * break the editor, so they are readable and tested without a Worker in sight.
 *
 * The threat model is not malice first — it is an ordinary mistake. A `while
 * (true)` in a plugin, a loop that posts a message per iteration, a command that
 * never returns. None of those may cost the user their editor, so:
 *
 * - plugins run in a **Worker**: a spin loop burns one core and leaves the
 *   window responsive, which is the whole reason for the sandbox.
 * - every call is **capability-checked on the host**, never on the plugin's
 *   honour.
 * - activation and each command have a **deadline**; past it the plugin is
 *   terminated and named.
 * - messages are **rate limited** and the log is **bounded**, so a plugin cannot
 *   fill memory through the host.
 */

/** Capabilities Aime knows how to grant. Mirrors `plugins.rs::KNOWN_CAPABILITIES`. */
export const CAPABILITIES = ["editor", "files", "ui"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The API version this build speaks. Mirrors `plugins.rs::PLUGIN_API_VERSION`. */
export const PLUGIN_API_VERSION = 1;

/** How long a plugin gets to register its commands before it is considered stuck. */
export const ACTIVATION_TIMEOUT_MS = 5_000;

/** How long one command may run. Generous: a plugin may be reading files. */
export const COMMAND_TIMEOUT_MS = 15_000;

/**
 * Calls a plugin may make per second before Aime stops believing it is working.
 *
 * A loop calling `ui.showMessage` would otherwise grow the host's state without
 * bound; a plugin doing real work does not need a hundred calls a second.
 *
 * Counted **in the Worker, where the calls are sent**, and again in the host as a
 * second line of defence. The send side is the only place the count is true, and
 * this was measured rather than reasoned: a plugin looping
 * `aime.ui.showMessage()` posts every message before the host sees the first, and
 * because each of those costs the host a render, a hundred of them take longer
 * than the second they were sent in - the host's own counter kept resetting and
 * took **23 seconds** to call a flood of a hundred thousand messages a runaway,
 * with the window draining that queue the whole time.
 */
export const MAX_CALLS_PER_SECOND = 100;

/** Lines of plugin output kept. Bounded so a chatty plugin cannot fill memory. */
export const MAX_LOG_LINES = 200;

/** What the plugin asked for, and what it needs to be allowed to. */
export function capabilityFor(method: string): Capability | null {
  const [area] = method.split(".");
  if (area === "editor") return "editor";
  if (area === "workspace") return "files";
  if (area === "ui") return "ui";
  // `commands.register` needs nothing: registering is how a plugin is useful at
  // all, and running it is still the user's decision.
  return null;
}

/** Why a call is refused, or nothing when it is allowed. */
export function refusalFor(method: string, granted: readonly string[]): string | null {
  const needed = capabilityFor(method);
  if (needed === null) return null;
  if (granted.includes(needed)) return null;
  return `${method} needs the "${needed}" capability, which this plugin did not ask for`;
}

/** A message from the Worker to Aime. */
export type FromPlugin =
  | { kind: "register"; commandId: string; title: string }
  | { kind: "call"; id: number; method: string; params?: unknown }
  | { kind: "ready" }
  | { kind: "log"; text: string }
  | { kind: "failed"; text: string }
  /**
   * The Worker counted `MAX_CALLS_PER_SECOND` of the plugin's own calls and
   * stopped sending. A report rather than a request: what happens next, and what
   * the user reads about it, stays Aime's decision.
   */
  | { kind: "flooded" }
  /** One command run has finished, successfully or not. */
  | { kind: "done"; runId: number };

/** A message from Aime to the Worker. */
export type ToPlugin =
  | { kind: "answer"; id: number; result?: unknown; error?: string }
  | { kind: "run"; runId: number; commandId: string }
  | { kind: "done"; runId: number };

/** Whether a value is a message shape the host understands. */
export function isFromPlugin(value: unknown): value is FromPlugin {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "register" ||
    kind === "call" ||
    kind === "ready" ||
    kind === "log" ||
    kind === "failed" ||
    kind === "flooded" ||
    kind === "done"
  );
}
