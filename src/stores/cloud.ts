import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { translate } from "../i18n";
import { aiOneshot } from "../lib/aiOneshot";
import { DISCOVER_PROMPT, parseArchitecture } from "../lib/cloudDiscovery";
import { renderCloudNote, spliceCloudNote, type CloudNote } from "../lib/cloudMemory";
import { useWorkspace } from "./workspace";

/**
 * The clouds this machine can reach, and what they hold.
 *
 * Connecting is signing into the vendor's own CLI - Aime never asks for a key,
 * and never stores one (see `src-tauri/src/cloud.rs`). What this store adds is
 * the half the user asked for: once a cloud is connected, find out what is
 * already running there and write it into the project's memory, so the next
 * request to deploy or to chase a bug starts from what exists.
 */

/** Mirror of the Rust `CloudStatus` (cloud.rs). */
export interface CloudStatus {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  version: string | null;
  /** Set when the CLI is a copy Aime downloaded, not one on PATH. */
  path: string | null;
  signedIn: boolean | null;
  account: string | null;
  signInHint: string;
  installHint: string;
  /** Whether Aime could run that install here - see the Rust `CloudStatus`. */
  installable: boolean;
}

/** Mirror of the Rust `MemoryPaths` (memory.rs), as far as a project needs it. */
interface MemoryPaths {
  projectPath: string | null;
}

interface CloudState {
  clouds: CloudStatus[];
  /** False until the first probe answers, so the panel can say "looking". */
  ready: boolean;
  /** The cloud a discovery is running for, or null. */
  discovering: string | null;
  /** What the last discovery wrote, or why it wrote nothing. */
  result: { cloud: string; wrote: boolean; detail: string } | null;
  /** What every discovery in this session found, newest answer per cloud. */
  notes: Record<string, CloudNote>;

  refresh: () => Promise<void>;
  discover: (id: string) => Promise<void>;
}

export const useCloud = create<CloudState>((set, get) => ({
  clouds: [],
  ready: false,
  discovering: null,
  result: null,
  notes: {},

  refresh: async () => {
    try {
      set({ clouds: await invoke<CloudStatus[]>("cloud_report"), ready: true });
    } catch (error: unknown) {
      // A probe that will not run is not four signed-out clouds. The rows keep
      // whatever they last knew and the panel stays honest about being unsure.
      console.warn("could not read the cloud report:", error);
      set({ ready: true });
    }
  },

  /**
   * Asks the AI what exists in one cloud, then writes it into the project's
   * memory file.
   *
   * Aime holds the two ends and the AI does the middle: the account comes from
   * a measured probe, the file is written by Aime, and only a reply that parses
   * into services, deployments or stated gaps is written at all. A model that
   * answered with prose leaves the memory exactly as it was - a note nobody can
   * trust is worse in that file than no note.
   */
  discover: async (id) => {
    const cloud = get().clouds.find((candidate) => candidate.id === id);
    const rootPath = useWorkspace.getState().rootPath;
    if (cloud === undefined || rootPath === null || get().discovering !== null) return;

    set({ discovering: id, result: null });
    try {
      const account = cloud.account ?? cloud.label;
      const asking = [
        DISCOVER_PROMPT,
        "",
        `The cloud: ${cloud.label}, through its own CLI (\`${cloud.command}\`) on this machine.`,
        `Signed in as: ${account}`,
      ].join("\n");
      const architecture = parseArchitecture(await aiOneshot(asking, rootPath));
      if (architecture === null) {
        set({ result: { cloud: cloud.label, wrote: false, detail: translate("cloud.noAnswer") } });
        return;
      }

      const notes = {
        ...get().notes,
        [id]: { label: cloud.label, account, architecture, discoveredAt: Date.now() },
      };
      set({ notes });
      const wrote = await writeMemory(rootPath, notes);
      set({
        result: {
          cloud: cloud.label,
          wrote,
          detail: wrote
            ? translate("cloud.wrote", {
                services: architecture.services.length,
                gaps: architecture.gaps.length,
              })
            : translate("cloud.memoryFailed"),
        },
      });
    } catch (error: unknown) {
      set({ result: { cloud: cloud.label, wrote: false, detail: String(error) } });
    } finally {
      set({ discovering: null });
    }
  },
}));

/**
 * Rewrites the managed section of the project's memory file.
 *
 * Read, splice, write - rather than append - so a second discovery replaces the
 * first and a person's own notes in that file are never touched. Claude's
 * pointer file is refreshed the same way `MemoryModal` does it, or the note
 * would be invisible to whichever CLI the reader switches to next.
 */
async function writeMemory(rootPath: string, notes: Record<string, CloudNote>): Promise<boolean> {
  try {
    // `project_memory_paths`, not `memory_paths`: the latter resolves a global
    // path through the selected provider's adapter and fails outright for a CLI
    // the user added themselves, which would have made this feature quietly
    // write nothing for exactly those users.
    const paths = await invoke<MemoryPaths>("project_memory_paths", { rootPath });
    if (paths.projectPath === null) return false;
    const existing = await invoke<string>("read_file", { path: paths.projectPath }).catch(() => "");
    const section = renderCloudNote(Object.values(notes));
    await invoke("write_file", {
      path: paths.projectPath,
      content: spliceCloudNote(existing, section),
    });
    await invoke("ensure_memory_bridge", { rootPath });
    return true;
  } catch (error: unknown) {
    console.warn("could not write the cloud note into the project memory:", error);
    return false;
  }
}
