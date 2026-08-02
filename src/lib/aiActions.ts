import { translate } from "../i18n";
import type { TranslationKey } from "../i18n/en";

/**
 * What the AI can be asked to do with the code in front of you.
 *
 * These live in the editor's own right-click menu because that is where the
 * question occurs - selecting a confusing function and asking about it should
 * not require composing a prompt, remembering a file path, or knowing what an
 * agent is. Aime writes the prompt; the user only picks the verb.
 */
export interface AiAction {
  id: string;
  /** Menu label, translated. */
  label: TranslationKey;
  /** Built from the selection; `{file}` and `{code}` are filled in. */
  instruction: string;
}

export const AI_ACTIONS: AiAction[] = [
  {
    id: "explain",
    label: "ai.action.explain",
    instruction:
      "Explain what this code does, in plain language, for someone who did not write it. " +
      "Cover why it exists and anything surprising about it. Do not change any file.",
  },
  {
    id: "improve",
    label: "ai.action.improve",
    instruction:
      "Improve this code: clearer names, less repetition, simpler control flow. Keep its behaviour " +
      "identical. Apply the change to the file, then say in one short paragraph what you changed and why.",
  },
  {
    id: "tests",
    label: "ai.action.tests",
    instruction:
      "Write tests for this code, following the testing style already used in this project. Cover the " +
      "cases that would actually break it, not trivial ones. Create or extend the appropriate test file.",
  },
  {
    id: "fix",
    label: "ai.action.fix",
    instruction:
      "Find bugs in this code and fix them in the file. If you find none, say so plainly instead of " +
      "inventing a change. Explain each fix in one sentence.",
  },
  {
    id: "document",
    label: "ai.action.document",
    instruction:
      "Add or improve the comments and doc-comments for this code, following this project's existing " +
      "style. Comment what the code cannot say itself; do not narrate the obvious.",
  },
];

/** The message Aime sends on the user's behalf. */
export function buildPrompt(action: AiAction, file: string, code: string, language: string): string {
  const scope = code.trim()
    ? `Selected code from ${file}:\n\n\`\`\`${language}\n${code}\n\`\`\``
    : `The whole file ${file}.`;
  return `${action.instruction}\n\n${scope}`;
}

/** Menu label as the user reads it. */
export function labelOf(action: AiAction): string {
  return translate(action.label);
}
