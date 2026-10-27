import { invoke } from "@tauri-apps/api/core";
import { useAi } from "../stores/ai";
import { capabilitiesOf } from "./providers";

/**
 * Runs a one-shot AI chore (commit message, conflict merge) on whichever CLI
 * the user selected, outside the chat session so it never pollutes history.
 * `quick` picks the provider's cheapest capable model where that exists.
 */
export function aiOneshot(prompt: string, cwd: string, quick = false): Promise<string> {
  const { providerId } = useAi.getState();
  return invoke<string>("ai_oneshot", {
    providerId,
    prompt,
    cwd,
    model: quick ? capabilitiesOf(providerId).quickModel : "",
  });
}
