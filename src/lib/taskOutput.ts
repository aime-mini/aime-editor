/**
 * Reading a task's result out of raw terminal output.
 *
 * A task runs inside the interactive shell of a terminal tab, so the PTY never
 * reports its exit status — the shell prints it instead (see the Rust
 * `TASK_EXIT_MARKER` in tasks/mod.rs). These helpers are pure so the parsing
 * rules can be tested without a terminal.
 */

/** Mirror of the Rust `TASK_EXIT_MARKER`; only a line carrying digits counts. */
const EXIT_MARKER = /\[aime\] exit code: (\d+)/;

/**
 * The marker may be split across two PTY chunks, so the tail of what was seen
 * before is re-scanned together with the new chunk.
 */
const OVERLAP_CHARS = 120;

/** Color (CSI) and title (OSC) sequences: the terminal keeps them, an AI prompt must not. */
const ANSI_SEQUENCE = new RegExp(
  // eslint-disable-next-line no-control-regex
  "\\u001B\\[[0-9;?]*[ -/]*[@-~]|\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)",
  "g",
);

/**
 * The task's exit code once the shell has reported it, else null.
 * The shell also echoes the command line, which *contains* the marker text
 * followed by the shell's own variable — requiring digits keeps that echo from
 * being read as a result.
 */
export function readExitCode(seenOutput: string, chunk: string): number | null {
  const match = EXIT_MARKER.exec(seenOutput.slice(-OVERLAP_CHARS) + chunk);
  return match ? Number(match[1]) : null;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}
