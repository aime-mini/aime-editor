import type { ProviderOption } from "./providers";

/** The model and effort a turn ran on, as the CLI recorded them (Rust `RanOn`). */
export interface RanOn {
  model?: string;
  effort?: string;
}

/** What a provider's last turn ran on, and what was picked in Aime when it did. */
export interface ObservedRun {
  ranOn: RanOn;
  chose: { model: string; effort: string };
}

/** What "Auto" stands for in each picker right now; null where it cannot be said. */
export interface AutoHints {
  model: string | null;
  effort: string | null;
}

/** A model the CLI names with a context suffix - `claude-opus-5-5[1m]` - is the same model. */
const CONTEXT_SUFFIX = /\[[^\]]*\]$/;

/**
 * What "Auto" stands for, for the pickers to say beside it.
 *
 * The last turn speaks first, but only for the choice it ran under: the model
 * Auto picked says nothing once a model is chosen, and the effort a model ran
 * at says nothing about another model. Where it cannot speak, the CLI's own
 * answer for the current choice does - asked before anything is sent.
 *
 * @param expected what the CLI said it would run the current choice on.
 * @param models the picker's options, so a model is called by the name it has there.
 */
export function autoHints(
  observed: ObservedRun | undefined,
  expected: RanOn | undefined,
  choice: { model: string; effort: string },
  models: readonly ProviderOption[],
): AutoHints {
  const sameModel = observed?.chose.model === choice.model;
  const observedModel = sameModel && choice.model === "" ? observed.ranOn.model : undefined;
  const observedEffort = sameModel && observed.chose.effort === "" ? observed.ranOn.effort : undefined;
  const ranModel = choice.model === "" ? (observedModel ?? expected?.model) : undefined;
  const effort = choice.effort === "" ? (observedEffort ?? expected?.effort ?? null) : null;
  return { model: ranModel === undefined ? null : nameOf(ranModel, models), effort };
}

/** Where a CLI's answer for a choice is kept: it holds for that model in that folder. */
export function expectationKey(providerId: string, cwd: string, model: string): string {
  return JSON.stringify([providerId, cwd, model]);
}

function nameOf(model: string, models: readonly ProviderOption[]): string {
  const base = model.replace(CONTEXT_SUFFIX, "");
  return models.find((option) => option.value === base)?.label ?? base;
}

/**
 * Folds a new observation into the last one. A turn's model is known the moment
 * it starts and its effort only once it has run, so an observation that names
 * one keeps the other - as long as it was made under the same choice.
 */
export function observe(previous: ObservedRun | undefined, next: ObservedRun): ObservedRun {
  const sameChoice =
    previous !== undefined &&
    previous.chose.model === next.chose.model &&
    previous.chose.effort === next.chose.effort;
  return sameChoice ? { chose: next.chose, ranOn: { ...previous.ranOn, ...defined(next.ranOn) } } : next;
}

function defined(ranOn: RanOn): RanOn {
  return Object.fromEntries(Object.entries(ranOn).filter(([, value]) => value !== undefined));
}
