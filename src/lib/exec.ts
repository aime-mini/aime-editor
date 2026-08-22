import { invoke } from "@tauri-apps/api/core";

/**
 * Running a command without a terminal tab.
 *
 * The Rust side (`src-tauri/src/exec.rs`) spawns the real process and answers
 * with its real exit status. This is the thin frontend face of it: the type,
 * the call, and the cancel.
 */

/** Mirror of the Rust `CommandOutcome`. */
export interface CommandOutcome {
  /** The process's own exit status; null when it was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** True when output was dropped to stay inside the capture limit. */
  clipped: boolean;
}

/**
 * Both streams as one text, which is how a person reads a run — and, it turns
 * out, the only way to read one.
 *
 * Measured on a real vitest run (2026-08-22): it splits its report across the
 * two, putting `Tests  1 failed | 3 passed (4)` on stdout and the
 * `FAIL <file> > <suite> > <test>` lines on stderr. Anything parsing one stream
 * alone gets either the count without the names or the names without the
 * count, so a reader must be handed both.
 */
export function allOutput(outcome: CommandOutcome): string {
  return [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== "").join("\n");
}

/**
 * Runs one command line and waits for it.
 *
 * The id is the caller's so it can be cancelled: this promise settles only
 * once the process is over, so an id handed back at the end would arrive far
 * too late to stop anything.
 */
export function execRun(
  id: string,
  command: string,
  cwd: string,
  timeoutMs?: number,
): Promise<CommandOutcome> {
  return invoke<CommandOutcome>("exec_run", { id, command, cwd, timeoutMs: timeoutMs ?? null });
}

/** Ends a running command. Unknown ids are ignored, not an error. */
export function execCancel(id: string): Promise<void> {
  return invoke("exec_cancel", { id });
}
