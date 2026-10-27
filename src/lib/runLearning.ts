import type { Survey } from "./aiRun";
import { nameFor, ROOT_SCOPE, type Memory } from "./knowledge";

/**
 * What a task run teaches the project's memory (`lib/knowledge.ts`): how this
 * codebase does things, read out of it in the first step with the file each
 * rule was seen in, and written as memories scoped to the folder they were
 * found in, so the next turn about that folder is handed them.
 *
 * What a reviewer caught is deliberately not written here. A finding is about
 * one diff - "line 40 lacks a null check" - and copied into memory it would
 * be a pitfall for ever about nothing in particular. Whether a finding is the
 * sign of a trap in this codebase is a judgement of meaning, so the step that
 * fixes findings is asked to make it and to write the general rule
 * (`POLISH_PROMPT` in `stores/run.ts`).
 */

/** The conventions a run's reading of the code found. */
export function conventionsLearned(survey: Survey, day: string): Memory[] {
  const conventions = survey.patterns.map((pattern): Memory => {
    const { rule, file } = splitCitation(pattern);
    return {
      name: nameFor(rule),
      kind: "convention",
      scope: file === null ? ROOT_SCOPE : folderOf(file),
      summary: rule,
      files: file === null ? [] : [file],
      updated: day,
      body: "",
    };
  });
  if (survey.testsLiveIn === "") return conventions;
  const { rule, file } = splitCitation(survey.testsLiveIn);
  return [
    ...conventions,
    {
      name: "where-tests-live",
      kind: "convention",
      scope: ROOT_SCOPE,
      summary: `Tests: ${rule}`,
      files: file === null ? [] : [file],
      updated: day,
      body: "",
    },
  ];
}

/** "plain ES modules - src/checkout.js" as the rule and the file it cites, when it cites one. */
function splitCitation(text: string): { rule: string; file: string | null } {
  const at = text.lastIndexOf(" - ");
  const cited = at === -1 ? "" : text.slice(at + 3).trim();
  return /^[\w.@-]+(\/[\w.@-]+)+$|^[\w@-]+\.\w+$/.test(cited)
    ? { rule: text.slice(0, at).trim(), file: cited }
    : { rule: text.trim(), file: null };
}

function folderOf(file: string): string {
  const slash = file.replace(/\\/g, "/").lastIndexOf("/");
  return slash === -1 ? ROOT_SCOPE : file.slice(0, slash);
}
