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
  /** Names that always mean the newest release (`opus`, `sonnet`, …): never stale, so always offered. */
  aliases: ModelOption[];
  /** The models offered until the installed CLI has been read (`modelsOf`). */
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

const CLAUDE_ALIASES: ModelOption[] = [
  { value: "fable", label: "Fable (latest)" },
  { value: "opus", label: "Opus (latest)" },
  { value: "sonnet", label: "Sonnet (latest)" },
  { value: "haiku", label: "Haiku (latest)" },
];

/**
 * A model the installed CLI itself reported (Rust `ModelChoice`,
 * `providers/catalog.rs`): read from Codex's catalog or the names compiled
 * into Claude Code, so a model that shipped yesterday is in the picker today.
 */
export interface DiscoveredModel {
  value: string;
  label: string;
  /** The reasoning levels it accepts, when the catalog says; empty = unknown. */
  efforts?: string[];
}

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
    aliases: CLAUDE_ALIASES,
    // The fallback while the installed CLI has not been read yet: the aliases,
    // then the pinned versions its binary carried on 2026-10-02. Availability
    // of a pinned model depends on the user's plan - the CLI reports an error.
    models: [
      DEFAULT_OPTION,
      ...CLAUDE_ALIASES,
      { value: "claude-fable-5-1", label: "Fable 5.1" },
      { value: "claude-fable-5", label: "Fable 5" },
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
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
    aliases: [],
    // The fallback while the CLI's catalog has not been read: what
    // `codex debug models` listed on 2026-10-02 (0.146.0).
    models: [
      DEFAULT_OPTION,
      { value: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: CODEX_EFFORTS_TO_ULTRA },
      { value: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: CODEX_EFFORTS_TO_MAX },
      { value: "gpt-5.5", label: "GPT-5.5" },
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
      aliases: [],
      models: [DEFAULT_OPTION],
      efforts: [DEFAULT_OPTION],
      reportsCost: false,
      installCommand: "",
      quickModel: "",
    }
  );
}

/**
 * The models the picker offers: Auto, the aliases, then what the installed
 * CLI reported - or the fallback table while nothing has been reported.
 */
export function modelsOf(
  providerId: string,
  discovered: readonly DiscoveredModel[] | undefined,
): ModelOption[] {
  const capabilities = capabilitiesOf(providerId);
  if (discovered === undefined || discovered.length === 0) return capabilities.models;
  const reported = discovered.map(({ value, label, efforts: levels }): ModelOption =>
    levels === undefined || levels.length === 0
      ? { value, label }
      : { value, label, efforts: efforts(...levels) },
  );
  return [DEFAULT_OPTION, ...capabilities.aliases, ...reported];
}

/** Efforts the chosen model accepts — passing an unsupported one is a CLI error. */
export function effortsOf(
  providerId: string,
  model: string,
  discovered?: readonly DiscoveredModel[],
): ProviderOption[] {
  const own = modelsOf(providerId, discovered).find((m) => m.value === model)?.efforts;
  return own ?? capabilitiesOf(providerId).efforts;
}
