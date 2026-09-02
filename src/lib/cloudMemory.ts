import type { CloudArchitecture } from "./cloudDiscovery";

/**
 * Where a cloud discovery ends up: the project's own memory file.
 *
 * `AGENTS.md` is the one file every AI CLI reads on every turn (ARCHITECTURE.md
 * §4), so an inventory written there is in front of the AI the next time
 * someone asks it to deploy something - which is the whole point of discovering
 * it. A panel that showed the same list on screen would be a thing to read
 * once; this is a thing the work is done from.
 *
 * Everything Aime writes lives between two markers, so a person's own notes in
 * that file are never touched and a second discovery replaces the first instead
 * of stacking. That is the only reason this is a splice rather than an append.
 */

const START = "<!-- aime:cloud -->";
const END = "<!-- /aime:cloud -->";

/** One cloud's findings, as they go into the file. */
export interface CloudNote {
  /** The cloud's label, as the panel spells it. */
  label: string;
  /** Who the CLI is signed in as, in that cloud's own words. */
  account: string;
  architecture: CloudArchitecture;
  /** When it was discovered, so a stale map can be recognised as one. */
  discoveredAt: number;
}

/**
 * The managed section, rendered from what every discovered cloud found.
 *
 * Written for the reader that matters most here, which is a model with a
 * question about where something runs: short lines, exact names, and the limits
 * of the map stated rather than implied.
 */
export function renderCloudNote(notes: readonly CloudNote[]): string {
  if (notes.length === 0) return "";
  const lines = [
    START,
    "",
    "## Cloud accounts this project is connected to",
    "",
    "Discovered by Aime from the signed-in CLI on this machine. Read-only: nothing here was created",
    "or changed by the discovery. Names are exactly as the cloud spells them, so a command can use",
    "them. Where a section says what it could not see, treat the rest as the whole of what is known.",
  ];
  for (const note of notes) {
    lines.push(
      "",
      `### ${note.label} — ${note.account}`,
      "",
      `_Discovered ${new Date(note.discoveredAt).toISOString().slice(0, 10)}._`,
    );
    if (note.architecture.deploys.length > 0) {
      lines.push("", "How this project reaches it today:");
      for (const one of note.architecture.deploys) lines.push(`- ${one}`);
    }
    if (note.architecture.services.length > 0) {
      lines.push("", "| Name | Kind | Where | Notes |", "| --- | --- | --- | --- |");
      for (const service of note.architecture.services) {
        lines.push(
          `| ${cell(service.name)} | ${cell(service.kind)} | ${cell(service.where)} | ${cell(service.notes)} |`,
        );
      }
    }
    if (note.architecture.gaps.length > 0) {
      lines.push("", "Not seen by this discovery:");
      for (const gap of note.architecture.gaps) lines.push(`- ${gap}`);
    }
  }
  lines.push("", END);
  return lines.join("\n");
}

/**
 * Puts the section into a memory file, replacing whatever was there before.
 *
 * A file with no markers gets the section appended; a file with them gets that
 * span swapped. An empty section removes it, because a marker pair with nothing
 * between it tells a reader a discovery happened and found nothing - which is
 * not the same as no discovery having happened.
 */
export function spliceCloudNote(memory: string, section: string): string {
  const start = memory.indexOf(START);
  const end = memory.indexOf(END);
  const managed = start !== -1 && end > start;
  if (!managed) {
    if (section === "") return memory;
    const body = memory.trimEnd();
    return body === "" ? `${section}\n` : `${body}\n\n${section}\n`;
  }
  const before = memory.slice(0, start).trimEnd();
  const after = memory.slice(end + END.length).trimStart();
  const parts = [before, section, after].filter((part) => part !== "");
  return `${parts.join("\n\n")}\n`;
}

/** One table cell: a pipe inside it would silently split the row in two. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
