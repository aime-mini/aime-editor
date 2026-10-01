import type { Finding, Survey } from "./aiRun";
import { nameFor, ROOT_SCOPE, type Memory } from "./knowledge";

/**
 * What a task run teaches the project's memory (`lib/knowledge.ts`).
 *
 * Two lessons a run learns for certain and used to forget the moment it ended:
 * how this codebase does things, read out of it in the first step with the
 * file each rule was seen in, and what a reviewer caught in the change and had
 * fixed - the trap the next change near those files is most likely to fall
 * into again. Both are written as memories scoped to the folder they were
 * found in, so the next turn about that folder is handed them.
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

/** What the reviewer found and the run had fixed, as traps to avoid next time. */
export function lessonsLearned(fixed: readonly Finding[], day: string): Memory[] {
  return fixed.map((finding): Memory => ({
    name: nameFor(finding.message),
    kind: "pitfall",
    scope: folderOf(finding.file),
    summary: finding.message,
    files: [finding.file],
    updated: day,
    body: `A reviewer found this (${finding.kind}) in a change here, and it was fixed. How it was proved: ${finding.check}`,
  }));
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
