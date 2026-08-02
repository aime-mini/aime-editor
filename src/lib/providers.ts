/**
 * Per-provider capabilities the AI panel offers to the user.
 * Values must match what each CLI actually accepts:
 * - Claude Code 2.1.220 — `--model` takes an alias or full name, `--effort`
 *   takes low|medium|high|xhigh|max.
 * - Codex CLI 0.146.0 — `-m` takes a catalog slug (verified with
 *   `codex debug models`), the effort goes through `-c model_reasoning_effort`
 *   and is restricted per model.
 * An empty value means "don't pass the flag" — the CLI's own default wins.
 */
export interface ProviderOption {
  value: string;
  label: string;
}

export interface ModelOption extends ProviderOption {
  /** Effort levels this model accepts; absent = the provider-wide list. */
  efforts?: ProviderOption[];
}

export interface ProviderCapabilities {
  displayName: string;
  models: ModelOption[];
  /** Efforts offered while the model is left on "Auto". */
  efforts: ProviderOption[];
  /** false = the CLI reports no price (subscription billing) — hide cost UI. */
  reportsCost: boolean;
  /** Shown when the CLI is missing, so the user can install it without leaving Aime. */
  installCommand: string;
  /**
   * Cheapest model good enough for one-shot chores (commit messages, conflict
   * merges); empty = the CLI's own default is already the sensible choice.
   */
  quickModel: string;
}

const DEFAULT_OPTION: ProviderOption = { value: "", label: "Auto" };

/** Effort pickers show the raw CLI values — there is nothing to translate. */
function efforts(...levels: string[]): ProviderOption[] {
  return [DEFAULT_OPTION, ...levels.map((value) => ({ value, label: value }))];
}

const CLAUDE_EFFORTS = efforts("low", "medium", "high", "xhigh", "max");
const CODEX_EFFORTS_TO_MAX = efforts("low", "medium", "high", "xhigh", "max");
const CODEX_EFFORTS_TO_ULTRA = efforts("low", "medium", "high", "xhigh", "max", "ultra");
/** Safe set while the model is unknown ("Auto"): every catalog model takes these. */
const CODEX_EFFORTS_COMMON = efforts("low", "medium", "high", "xhigh");

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  claude: {
    displayName: "Claude Code",
    // Aliases first (they always track the newest release), then pinned
    // versions for users who want a specific one. Availability of a pinned
    // model depends on the user's plan — the CLI reports an error if not.
    models: [
      DEFAULT_OPTION,
      { value: "fable", label: "Fable (latest)" },
      { value: "opus", label: "Opus (latest)" },
      { value: "sonnet", label: "Sonnet (latest)" },
      { value: "haiku", label: "Haiku (latest)" },
      { value: "claude-fable-5", label: "Fable 5" },
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-opus-4-7", label: "Opus 4.7" },
      { value: "claude-opus-4-6", label: "Opus 4.6" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { value: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
    efforts: CLAUDE_EFFORTS,
    reportsCost: true,
    installCommand: "npm install -g @anthropic-ai/claude-code",
    quickModel: "haiku",
  },
  codex: {
    displayName: "Codex",
    models: [
      DEFAULT_OPTION,
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: CODEX_EFFORTS_TO_ULTRA },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: CODEX_EFFORTS_TO_ULTRA },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: CODEX_EFFORTS_TO_MAX },
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5.2", label: "GPT-5.2" },
    ],
    efforts: CODEX_EFFORTS_COMMON,
    reportsCost: false,
    installCommand: "npm install -g @openai/codex",
    // Codex bills per subscription and its catalog default is already fast.
    quickModel: "",
  },
};

export function capabilitiesOf(providerId: string): ProviderCapabilities {
  return (
    PROVIDER_CAPABILITIES[providerId] ?? {
      displayName: providerId,
      models: [DEFAULT_OPTION],
      efforts: [DEFAULT_OPTION],
      reportsCost: false,
      installCommand: "",
      quickModel: "",
    }
  );
}

/** Efforts the chosen model accepts — passing an unsupported one is a CLI error. */
export function effortsOf(providerId: string, model: string): ProviderOption[] {
  const capabilities = capabilitiesOf(providerId);
  return capabilities.models.find((m) => m.value === model)?.efforts ?? capabilities.efforts;
}
