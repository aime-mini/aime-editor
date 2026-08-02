import { invoke } from "@tauri-apps/api/core";

/**
 * Writes what went wrong to a file on this machine, and nowhere else.
 *
 * A crash reporter would be easier; it would also post stack traces - which
 * carry file paths, project names and sometimes prompts - to a third party
 * from an editor that opens private repositories. The log is here for the
 * user to read and to send if they choose to, which is the same information
 * without the decision being made for them.
 *
 * Never throws: a failure to record a failure must not become the failure the
 * user sees.
 */
export function reportError(kind: string, error: unknown, extra = ""): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  void invoke("report_error", {
    report: { kind, message, detail: [stack, extra].filter(Boolean).join("\n") },
    // The clock belongs to the side that has a locale; Rust would only guess.
    timestamp: new Date().toISOString(),
  }).catch(() => {
    /* nothing sensible left to do */
  });
}

/**
 * Starts recording failures nobody caught.
 *
 * These are the ones that leave no trace otherwise: a rejected promise with no
 * handler, an error thrown outside React. Both are silent in a desktop window
 * where there is no console open to notice them.
 */
export function watchForUncaughtErrors(): void {
  window.addEventListener("error", (event) => {
    reportError("uncaught", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError("unhandled-rejection", event.reason);
  });
}

/** Where the log lives, for the UI to offer to open it. */
export function errorLogPath(): Promise<string> {
  return invoke<string>("error_log_path");
}
