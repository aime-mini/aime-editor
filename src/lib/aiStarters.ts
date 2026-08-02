import type { TranslationKey } from "../i18n/en";

/**
 * What to offer someone staring at an empty AI panel.
 *
 * Three fixed suggestions are a poster; these are picked from what is actually
 * in front of the user - the file they have open, the changes they have not
 * committed, the tests this project can run - so the first prompt is one worth
 * sending. The order matters: nearest to what they are doing comes first.
 */
export interface StarterContext {
  /** File name only - the prompt reads better and the CLI still finds it. */
  openFileName: string | null;
  /** How many files the working tree has changed. */
  changedFiles: number;
  /** True when the project declares a test command Aime detected. */
  hasTests: boolean;
  hasReadme: boolean;
}

export interface Starter {
  /** Short label on the button. */
  key: TranslationKey;
  /** The prompt actually sent - spelled out rather than derived, so a missing
   *  translation is a compile error instead of a runtime blank. */
  promptKey: TranslationKey;
  /** Substituted into both. */
  params?: Record<string, string>;
}

/** At most this many, because a wall of suggestions is another poster. */
const LIMIT = 4;

export function startersFor(context: StarterContext): Starter[] {
  const starters: Starter[] = [];

  if (context.openFileName) {
    starters.push({
      key: "ai.starter.explainFile",
      promptKey: "ai.starter.explainFile.prompt",
      params: { file: context.openFileName },
    });
  }
  if (context.changedFiles > 0) {
    starters.push({
      key: "ai.starter.reviewChanges",
      promptKey: "ai.starter.reviewChanges.prompt",
      params: { count: String(context.changedFiles) },
    });
  }
  if (context.openFileName && context.hasTests) {
    starters.push({
      key: "ai.starter.testFile",
      promptKey: "ai.starter.testFile.prompt",
      params: { file: context.openFileName },
    });
  }
  starters.push({ key: "ai.starter.explainProject", promptKey: "ai.starter.explainProject.prompt" });
  if (!context.hasReadme) {
    starters.push({ key: "ai.starter.writeReadme", promptKey: "ai.starter.writeReadme.prompt" });
  }
  starters.push({ key: "ai.starter.findBugs", promptKey: "ai.starter.findBugs.prompt" });

  return starters.slice(0, LIMIT);
}

/** Whether a project's file list contains a README, in any of its spellings. */
export function hasReadme(files: string[]): boolean {
  return files.some((path) => /^readme(\.[a-z]+)?$/i.test(path.split(/[\\/]/).pop() ?? ""));
}
