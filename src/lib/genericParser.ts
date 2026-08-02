import type { UiAiEvent } from "./types";

/**
 * Output of a CLI described in `providers.json` rather than built in.
 *
 * Two shapes cover the field: a CLI that just prints its answer, and one that
 * prints JSON per line. Neither reports cost, tokens or a session id, so the
 * UI shows none - inventing them would be worse than their absence.
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
    const value = (raw as Record<string, unknown>)[textField];
    return typeof value === "string" && value ? [{ kind: "message-delta", text: value }] : [];
  };
}
