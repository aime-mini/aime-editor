import type { UiAiEvent } from "./types";

/**
 * Output of a CLI described in `providers.json` rather than built in.
 *
 * Two shapes cover the field: a CLI that just prints its answer, and one that
 * prints JSON per line. Neither reports cost or tokens in a shape Aime can know,
 * so the UI shows none - inventing them would be worse than their absence.
 * Besides the text, a JSON line may carry the model and, where the config names
 * the field (`sessionField`), the session to carry on in.
 */
export function createGenericParser(kind: "plain" | "jsonl", textField: string, sessionField: string) {
  return (raw: unknown): UiAiEvent[] => {
    if (kind === "plain") {
      // The Rust side wraps unparsable lines as {type:"raw", text}; for a
      // plain CLI that wrapper is the line itself.
      const text = typeof raw === "string" ? raw : ((raw as { text?: string }).text ?? "");
      return text ? [{ kind: "message-delta", text: `${text}\n` }] : [];
    }
    if (typeof raw !== "object" || raw === null) return [];
    const line = raw as Record<string, unknown>;
    // A CLI that echoes the prompt back - Gemini CLI 0.68 opens its stream-json
    // with the user's message as `role: "user"` - has not answered with it.
    if (line.role === "user") return [];
    const events: UiAiEvent[] = [];
    const session = sessionField === "" ? undefined : line[sessionField];
    if (typeof session === "string" && session) events.push({ kind: "session-info", sessionId: session });
    // A CLI that names its model says what "Auto" picked - Gemini CLI does, in
    // the `init` line of its `stream-json` output (read from gemini-cli-core 0.64.0).
    if (typeof line.model === "string" && line.model) events.push({ kind: "ran-on", model: line.model });
    const value = line[textField];
    if (typeof value === "string" && value) events.push({ kind: "message-delta", text: value });
    return events;
  };
}
