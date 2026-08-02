/**
 * Merge-conflict model: parse conflict markers into sections, apply per-block
 * resolutions, rebuild the file. Pure functions — fully unit-tested.
 * Supports both merge styles: plain (ours/theirs) and diff3 (with a base block).
 */

export interface TextSection {
  kind: "text";
  text: string;
}

export interface ConflictSection {
  kind: "conflict";
  ours: string;
  theirs: string;
  base: string | null;
  oursLabel: string;
  theirsLabel: string;
}

export type Section = TextSection | ConflictSection;

/** A chosen outcome for one conflict block; `custom` carries AI/manual text. */
export type Resolution =
  { kind: "ours" } | { kind: "theirs" } | { kind: "both" } | { kind: "custom"; text: string };

const OURS_MARK = "<<<<<<<";
const BASE_MARK = "|||||||";
const SEP_MARK = "=======";
const THEIRS_MARK = ">>>>>>>";

export function hasConflictMarkers(content: string): boolean {
  return content.includes(OURS_MARK) && content.includes(SEP_MARK) && content.includes(THEIRS_MARK);
}

/**
 * Splits file content into alternating text/conflict sections. Malformed or
 * unterminated markers are treated as plain text rather than dropped —
 * resolving must never lose user content.
 */
export function parseConflicts(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let text: string[] = [];
  let i = 0;

  const flushText = () => {
    if (text.length > 0) {
      sections.push({ kind: "text", text: text.join("\n") });
      text = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith(OURS_MARK)) {
      text.push(line);
      i += 1;
      continue;
    }

    // Scan ahead for a complete block before committing to it.
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    const oursLabel = line.slice(OURS_MARK.length).trim();
    let theirsLabel = "";
    let stage: "ours" | "base" | "theirs" = "ours";
    let end = -1;

    for (let j = i + 1; j < lines.length; j++) {
      const cursor = lines[j];
      if (stage === "ours" && cursor.startsWith(BASE_MARK)) {
        stage = "base";
      } else if ((stage === "ours" || stage === "base") && cursor.startsWith(SEP_MARK)) {
        stage = "theirs";
      } else if (stage === "theirs" && cursor.startsWith(THEIRS_MARK)) {
        theirsLabel = cursor.slice(THEIRS_MARK.length).trim();
        end = j;
        break;
      } else if (stage === "ours") {
        ours.push(cursor);
      } else if (stage === "base") {
        base.push(cursor);
      } else {
        theirs.push(cursor);
      }
    }

    if (end === -1) {
      // Unterminated block — keep the raw line and move on.
      text.push(line);
      i += 1;
      continue;
    }

    flushText();
    sections.push({
      kind: "conflict",
      ours: ours.join("\n"),
      theirs: theirs.join("\n"),
      base: stage === "theirs" && base.length > 0 ? base.join("\n") : null,
      oursLabel,
      theirsLabel,
    });
    i = end + 1;
  }

  flushText();
  return sections;
}

export function resolvedText(conflict: ConflictSection, resolution: Resolution): string {
  switch (resolution.kind) {
    case "ours":
      return conflict.ours;
    case "theirs":
      return conflict.theirs;
    case "both":
      return [conflict.ours, conflict.theirs].filter((part) => part.length > 0).join("\n");
    case "custom":
      return resolution.text;
  }
}

/**
 * Rebuilds the full file. Every conflict must have a resolution — callers
 * gate the save button on that, and this function throws as a last defense.
 */
export function rebuildContent(sections: Section[], resolutions: (Resolution | null)[]): string {
  let conflictIndex = 0;
  const parts = sections.map((section) => {
    if (section.kind === "text") return section.text;
    const resolution = resolutions[conflictIndex];
    conflictIndex += 1;
    if (!resolution) throw new Error(`Conflict #${String(conflictIndex)} is unresolved`);
    return resolvedText(section, resolution);
  });
  return parts.join("\n");
}
