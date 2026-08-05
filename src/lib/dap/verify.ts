/**
 * Proving that an adapter Aime was taught actually debugs something.
 *
 * An agent can install a debugger, work out its command line and write the
 * entry — and be wrong in a dozen ways that all look like success from the
 * outside: the wrong transport, a missing launch field, an adapter that starts
 * and exits, a breakpoint the adapter silently declines. So nothing an agent
 * writes is believed. Aime starts the adapter itself, sets one breakpoint on a
 * line the entry names, launches, and requires a real `stopped` event **on that
 * line** before the language counts as debuggable (ARCHITECTURE.md §5).
 *
 * The check runs through `DebugSession` — the same client, handshake and
 * breakpoint handling a real run uses — because a verification that took a
 * shortcut would prove the shortcut, not the debugger.
 */

import { launchConfig, newBreakpoint } from "./launch";
import { samePath } from "./paths";
import type { AdapterAvailability } from "./availability";
import type { DebugSession } from "./session";
import type { StackFrame } from "./protocol";
import type { DebugTarget } from "./targets";

/** What the check saw. `detail` is for the agent as much as for the user. */
export interface Verdict {
  ok: boolean;
  detail: string;
  /** The line it actually stopped on, when it stopped at all. */
  stoppedAt?: number;
}

/** Long enough for a compile-and-launch, short enough to fail a hung adapter. */
const VERIFY_TIMEOUT_MS = 90_000;

export interface VerifyRequest {
  adapter: AdapterAvailability;
  /** The program to run, and where — built from the entry's `verifyWith`. */
  target: DebugTarget;
  /** The line the entry says execution will reach. */
  line: number;
  root: string;
}

/**
 * Runs one throwaway session and reports what happened.
 *
 * Never throws: every way this can fail is a verdict the agent can act on, and
 * an exception here would just become a stack trace in a log nobody reads.
 */
export async function verifyAdapter(request: VerifyRequest): Promise<Verdict> {
  const { adapter, target, line, root } = request;
  const { DebugSession } = await import("./session");

  // A holder rather than a `let`: the session is assigned inside a callback, and
  // the cleanup below has to see it.
  const held: { session: DebugSession | null } = { session: null };
  const output: string[] = [];
  try {
    const stopped = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The adapter's own words are the useful part: delve reports a build
        // error as output events and answers `launch` with nothing else.
        reject(
          new Error(
            `no stopped event within ${String(VERIFY_TIMEOUT_MS / 1000)} s${
              output.length > 0 ? `\n${output.join("").trim()}` : ""
            }`,
          ),
        );
      }, VERIFY_TIMEOUT_MS);

      void DebugSession.launch({
        languageId: adapter.languageId,
        cwd: target.cwd,
        root,
        configuration: launchConfig(adapter.configType, target.program, target.cwd, adapter.launchExtra),
        breakpoints: new Map([[target.program, [newBreakpoint(line)]]]),
        // A check proves one breakpoint; stopping on exceptions would only add
        // ways for it to stop somewhere else.
        exceptionFilters: [],
        callbacks: {
          onOutput: (body) => {
            output.push(body.output ?? "");
          },
          onStopped: (context) => {
            // A stop with no frames is possible - an adapter may report one
            // before it can describe it - and it is not proof of anything.
            const top = context.frames[0] as StackFrame | undefined;
            clearTimeout(timer);
            // The frame has to be in the program that was launched: an adapter
            // that stops in its own bootstrap has not proven anything.
            if (top?.source?.path && !samePath(top.source.path, target.program)) {
              reject(new Error(`stopped in ${top.source.path}, not in the program it was given`));
              return;
            }
            resolve(top?.line ?? 0);
          },
          onContinued: () => undefined,
          onExceptionFilters: () => undefined,
          onBreakpointsAnswered: () => undefined,
          onBreakpointChanged: () => undefined,
          onEnded: () => {
            clearTimeout(timer);
            reject(
              new Error(
                `the program ran to the end without stopping on line ${String(line)}${
                  output.length > 0 ? `\n${output.join("").trim()}` : ""
                }`,
              ),
            );
          },
          onError: (reason) => {
            clearTimeout(timer);
            reject(new Error(reason));
          },
        },
      }).then(
        (started) => {
          held.session = started;
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });

    const stoppedAt = await stopped;
    // Adapters are allowed to move a breakpoint to the nearest statement, so the
    // check is "it stopped in this program", not "it stopped on this exact line"
    // - but the line it chose is reported, because a wildly different one means
    // the entry named the wrong place.
    return {
      ok: true,
      detail: `stopped on line ${String(stoppedAt)} of ${relative(root, target.program)}`,
      stoppedAt,
    };
  } catch (err: unknown) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await held.session?.stop();
  }
}

/** Paths in a verdict are read by a person, so they are shown project-relative. */
function relative(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}
