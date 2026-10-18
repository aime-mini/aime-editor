import type { UiAiEvent } from "./types";

/**
 * Output of a CLI described in `providers.json` rather than built in.
 *
 * Two shapes cover the field: a CLI that just prints its answer, and one that
 * prints JSON per line. Neither reports cost, tokens or a session id, so the
 * UI shows none - inventing them would be worse than their absence. The model
 * is the one thing a JSON line may carry that is read besides the text.
 */
export function createGenericParser(kind: "plain" | "jsonl", textField: string) {
  return (raw: unknown): UiAiEvent[] => {
    if (kind === "plain") {
      // The Rust side wraps unparsable lines as {type:"raw", text}; for a
      // plain CLI that wrapper is the line itself.
      const text = typeof raw === "string" ? raw : ((raw as { text?: string }).text ?? "");
      return text ? [{ kind: "message-delta", text: `${text}\n` }] : [];
    }
    if (typeof raw !== "object" || raw === null) return [];
    const line = raw as Record<string, unknown>;
    const events: UiAiEvent[] = [];
    // A CLI that names its model says what "Auto" picked - Gemini CLI does, in
    // the `init` line of its `stream-json` output (read from gemini-cli-core 0.64.0).
    if (typeof line.model === "string" && line.model) events.push({ kind: "ran-on", model: line.model });
    const value = line[textField];
    if (typeof value === "string" && value) events.push({ kind: "message-delta", text: value });
    return events;
  };
}
