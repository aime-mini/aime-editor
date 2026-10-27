import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { translate } from "../i18n";
import { told } from "../stores/notices";

/**
 * The transfer pack (`src-tauri/src/transfer.rs`): everything Aime knows
 * about the projects of this machine - chats, memory, the CLIs' transcripts -
 * as one file for another machine, and the other way round.
 */

/** Mirror of the Rust `Exported`. */
export interface Exported {
  projects: number;
  chats: number;
  memories: number;
  transcripts: number;
  transcriptsMissing: number;
}

/** Mirror of the Rust `Imported`. */
export interface Imported {
  adopted: string[];
  pending: string[];
  chats: number;
  memories: number;
  transcripts: number;
}

/** Mirror of the Rust `Adopted`: what a folder just opened took from the pack. */
export interface Adopted {
  name: string;
  path: string;
  chats: number;
  memories: number;
  transcripts: number;
}

const ADOPTED_EVENT = "transfer:adopted";

export function exportPack(roots: string[], target: string): Promise<Exported> {
  return invoke<Exported>("transfer_export", { roots, target });
}

export function importPack(archive: string, candidates: string[]): Promise<Imported> {
  return invoke<Imported>("transfer_import", { archive, candidates });
}

/**
 * Says so when a folder that was just opened turned out to be a project
 * brought from another machine - the chat and memory it shows are the old
 * machine's, and that should not be a surprise.
 */
export function watchAdoptions(): Promise<() => void> {
  return listen<Adopted>(ADOPTED_EVENT, ({ payload }) => {
    told(
      translate("transfer.adopted", { name: payload.name }),
      translate("transfer.adoptedDetail", {
        chats: payload.chats,
        memories: payload.memories,
        transcripts: payload.transcripts,
      }),
    );
  });
}
