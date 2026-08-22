import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { translate } from "../i18n";
import { explainTrackerError, type TrackerProblem } from "../lib/trackerErrors";
import { useAi } from "./ai";
import { useGit } from "./git";
import { useLayout } from "./layout";
import { useWorkspace } from "./workspace";

/**
 * The work items assigned to whoever is sitting here, and the two moves that
 * connect them to the repository: start a branch, or hand the item to the AI.
 *
 * Everything service-specific is behind the Rust connectors (`trackers/`), so
 * this store speaks only about work items - which is what lets a second service
 * arrive without a line changing here.
 *
 * A board belongs to the open workspace: `activeId` is what *this project* is
 * bound to, read back from disk when the folder changes, so two repositories
 * never show each other's work.
 */

/** Mirror of the Rust `ConnectionField`. */
export interface ConnectionField {
  name: string;
  placeholder: string;
  optional: boolean;
}

/** A service that can be connected to, and what connecting asks for. */
export interface TrackerKind {
  kind: string;
  label: string;
  secretLabel: string;
  /** Where that credential is created, as a `{field}` template over the form. */
  secretHelpUrl: string;
  fields: ConnectionField[];
}

export interface TrackerConnection {
  id: string;
  kind: string;
  label: string;
  settings: Record<string, string>;
  hasToken: boolean;
}

export type StateCategory = "todo" | "inProgress" | "done" | "removed" | "unknown";

export interface WorkItem {
  id: string;
  /**
   * What a person calls this item when that is not its id (ClickUp custom task
   * ids); null when the id is what everybody reads.
   */
  displayId: string | null;
  title: string;
  itemType: string;
  state: string;
  category: StateCategory;
  webUrl: string;
  /** What this item sits under (a story, a test plan), when the service says so. */
  parent: Parent | null;
  /**
   * The ways this item is filed, each labelled by the service: board, sprint,
   * release, milestone. The panel groups by whichever the reader picks, so a new
   * way of organizing costs nothing here.
   */
  dimensions: Fact[];
}

export interface StateOption {
  name: string;
  category: StateCategory;
}

/** Mirror of the Rust `Fact`: one labelled thing, in the service's own words. */
export interface Fact {
  label: string;
  value: string;
}

/** What an item sits under, with the title so a row can say it. */
export interface Parent {
  id: string;
  title: string;
}

/** One entry of the conversation on an item. */
export interface Comment {
  author: string;
  when: string;
  text: string;
}

/**
 * The parts of an item a row does not already carry. The item itself is not in
 * here: the panel is holding it when it asks, and sending it back cost Azure
 * DevOps a second request to build it with.
 */
export interface WorkItemDetail {
  description: string;
  /** The short facts worth reading beside it, as the service labels them. */
  facts: Fact[];
}

/** How much of a description is worth sending with a prompt. */
const DESCRIPTION_PROMPT_LIMIT = 6_000;

/**
 * How long a list stays good enough to show without asking again. The panel
 * mounts every time the sidebar switches to it, and a board is not worth three
 * HTTP requests per tab click; the Refresh button ignores this entirely.
 */
const STALE_AFTER_MS = 60_000;

interface TrackerState {
  kinds: TrackerKind[];
  connections: TrackerConnection[];
  /** The board this workspace is bound to; null until it is pointed at one. */
  activeId: string | null;
  items: WorkItem[];
  loading: boolean;
  /**
   * False until the configuration has been read for the open project. Knowing
   * nothing yet is not the same as knowing there is nothing, and the difference
   * on screen is a connect form flashing in front of a project that is already
   * on a board.
   */
  ready: boolean;
  /** True while a connect attempt is in flight - it makes a real query. */
  connecting: boolean;
  problem: TrackerProblem | null;
  /** Finished work is left out until asked for; most boards have years of it. */
  includeFinished: boolean;
  /**
   * Whose work the board is asked for. True by default: a board is mostly other
   * people's work, and this panel is about what is on this person's plate.
   */
  mineOnly: boolean;
  /** When the items on screen were read; null until they have been. */
  loadedAt: number | null;

  /** Reads what is configured, and the items when they are stale (on mount). */
  load: () => Promise<void>;
  /** Reads only what is configured - no network, so anything may ask for it. */
  loadConnections: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Points this workspace at another board it already has. */
  setActive: (connectionId: string) => Promise<void>;
  /** Stops this project from using a board, leaving the board itself alone. */
  unbind: () => Promise<void>;
  toggleFinished: () => void;
  /** Switches between this person's work and everything on the board. */
  setMineOnly: (mineOnly: boolean) => void;
  /** Verifies the credential by using it; only then is anything stored. */
  connect: (kind: string, settings: Record<string, string>, token: string) => Promise<boolean>;
  disconnect: (connectionId: string) => Promise<void>;
  /**
   * The states this item may move to, as its service defines them - which is why
   * the whole item travels: Azure DevOps answers about its type, Jira about the
   * transitions available from this issue's current status.
   */
  statesFor: (item: WorkItem) => Promise<StateOption[]>;
  moveTo: (item: WorkItem, state: string) => Promise<void>;
  /** Creates the branch under that name and switches to it. */
  startBranch: (name: string) => Promise<void>;
  /** Puts the item, description and all, in front of the AI panel. */
  askAi: (item: WorkItem) => Promise<void>;
  /** Everything the opened item view shows: text and the short facts. */
  detailOf: (item: WorkItem) => Promise<WorkItemDetail | null>;
  /** The conversation on one item, oldest first. */
  commentsOf: (item: WorkItem) => Promise<Comment[] | null>;
  /** Says something on one item; answers false when the service refused. */
  comment: (item: WorkItem, text: string) => Promise<boolean>;
  /**
   * The item's own text, for the row that has been opened. Answers the empty
   * string when the service has none, and `null` when it could not be read - the
   * two mean different things on screen.
   */
}

export const useTrackers = create<TrackerState>((set, get) => ({
  kinds: [],
  connections: [],
  activeId: null,
  items: [],
  loading: false,
  ready: false,
  connecting: false,
  problem: null,
  includeFinished: false,
  mineOnly: true,
  loadedAt: null,

  load: async () => {
    await get().loadConnections();
    const { loadedAt } = get();
    if (loadedAt === null || Date.now() - loadedAt > STALE_AFTER_MS) {
      await get().refresh();
    }
  },

  loadConnections: async () => {
    const { rootPath } = useWorkspace.getState();
    try {
      const [kinds, connections, bound] = await Promise.all([
        invoke<TrackerKind[]>("tracker_kinds"),
        invoke<TrackerConnection[]>("tracker_connections"),
        // No folder open means no board to show; the panel is not reachable
        // then, but the MCP dialog asks for this list too.
        rootPath === null ? Promise.resolve(null) : invoke<string | null>("tracker_binding", { rootPath }),
      ]);
      // What this workspace is bound to, unless that connection is gone.
      const activeId = connections.some((connection) => connection.id === bound) ? bound : null;
      // Another window may have re-pointed this workspace since; whatever is on
      // screen belongs to the board that was bound then, not to this one.
      const boardChanged = activeId !== get().activeId;
      set({
        kinds,
        connections,
        activeId,
        ready: true,
        ...(boardChanged ? { items: [], loadedAt: null } : {}),
      });
    } catch (error: unknown) {
      // Ready all the same: the panel now knows as much as it is going to, and
      // the problem it shows beats a spinner that never stops.
      set({ ready: true, problem: explainTrackerError(error) });
    }
  },

  refresh: async () => {
    const { activeId, includeFinished, mineOnly } = get();
    if (activeId === null) {
      set({ items: [], problem: null, loadedAt: null });
      return;
    }
    set({ loading: true, problem: null });
    try {
      const items = await invoke<WorkItem[]>("tracker_work_items", {
        connectionId: activeId,
        query: { mineOnly, includeFinished },
      });
      set({ items, loadedAt: Date.now() });
    } catch (error: unknown) {
      set({ items: [], problem: explainTrackerError(error), loadedAt: null });
    } finally {
      set({ loading: false });
    }
  },

  setActive: async (connectionId) => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null) return;
    try {
      await invoke("tracker_bind", { rootPath, connectionId });
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return;
    }
    set({ activeId: connectionId, items: [], problem: null, loadedAt: null });
    await get().refresh();
  },

  unbind: async () => {
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null) return;
    try {
      await invoke("tracker_unbind", { rootPath });
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return;
    }
    // The board and its token stay; this project simply stops showing one, so
    // the picker asks again.
    set({ activeId: null, items: [], problem: null, loadedAt: null });
  },

  toggleFinished: () => {
    set((state) => ({ includeFinished: !state.includeFinished, loadedAt: null }));
    void get().refresh();
  },

  setMineOnly: (mineOnly) => {
    if (get().mineOnly === mineOnly) return;
    // The question changes what the service is asked, so what is on screen is
    // stale until the next answer arrives.
    set({ mineOnly, items: [], loadedAt: null });
    void get().refresh();
  },

  connect: async (kind, settings, token) => {
    // Connecting binds a workspace, so there has to be one; the panel only
    // exists inside a project, which makes this a guard and not a case.
    const { rootPath } = useWorkspace.getState();
    if (rootPath === null) return false;
    set({ connecting: true, problem: null });
    try {
      // Connecting binds this workspace to the board it just proved works.
      const connection = await invoke<TrackerConnection>("tracker_connect", {
        rootPath,
        kind,
        settings,
        token,
      });
      set((state) => ({
        connections: [...state.connections.filter((existing) => existing.id !== connection.id), connection],
        activeId: connection.id,
      }));
      await get().refresh();
      return true;
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return false;
    } finally {
      set({ connecting: false });
    }
  },

  disconnect: async (connectionId) => {
    try {
      await invoke("tracker_disconnect", { connectionId });
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return;
    }
    // Disconnecting drops every workspace's binding to it, this one included.
    set((state) => ({
      connections: state.connections.filter((connection) => connection.id !== connectionId),
      activeId: state.activeId === connectionId ? null : state.activeId,
      items: [],
      problem: null,
      loadedAt: null,
    }));
    await get().refresh();
  },

  statesFor: async (item) => {
    const { activeId } = get();
    if (activeId === null) return [];
    try {
      return await invoke<StateOption[]>("tracker_states", { connectionId: activeId, item });
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return [];
    }
  },

  moveTo: async (item, state) => {
    const { activeId, includeFinished } = get();
    if (activeId === null) return;
    set({ loading: true, problem: null });
    try {
      const updated = await invoke<WorkItem>("tracker_set_state", {
        connectionId: activeId,
        item,
        state,
      });
      // An item moved into a finished state leaves a list that excludes those,
      // which is the answer the query would give now.
      const gone = !includeFinished && (updated.category === "done" || updated.category === "removed");
      set((current) => ({
        items: gone
          ? current.items.filter((existing) => existing.id !== updated.id)
          : current.items.map((existing) => (existing.id === updated.id ? updated : existing)),
      }));
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
    } finally {
      set({ loading: false });
    }
  },

  startBranch: async (name) => {
    await useGit.getState().createBranch(name);
    // The git store keeps its own failures, and a refusal there (a name that
    // already exists, a name git will not take) would otherwise be invisible in
    // the panel the click came from - the branch simply would not appear.
    const refusal = useGit.getState().lastError;
    if (refusal !== null) set({ problem: explainTrackerError(refusal) });
  },

  detailOf: async (item) => {
    const { activeId } = get();
    if (activeId === null) return null;
    try {
      return await invoke<WorkItemDetail>("tracker_item_detail", { connectionId: activeId, item });
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return null;
    }
  },

  commentsOf: async (item) => {
    const { activeId } = get();
    if (activeId === null) return null;
    try {
      return await invoke<Comment[]>("tracker_comments", { connectionId: activeId, item });
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return null;
    }
  },

  comment: async (item, text) => {
    const { activeId } = get();
    if (activeId === null) return false;
    try {
      await invoke<Comment>("tracker_add_comment", { connectionId: activeId, item, text });
      return true;
    } catch (error: unknown) {
      set({ problem: explainTrackerError(error) });
      return false;
    }
  },

  askAi: async (item) => {
    const { activeId } = get();
    const { rootPath } = useWorkspace.getState();
    if (activeId === null || rootPath === null) return;

    let description = "";
    try {
      const detail = await invoke<WorkItemDetail>("tracker_item_detail", {
        connectionId: activeId,
        item,
      });
      description = detail.description.slice(0, DESCRIPTION_PROMPT_LIMIT);
    } catch (error: unknown) {
      // The title alone is still a usable prompt, so a failed detail read is
      // reported and the turn goes ahead rather than being cancelled.
      set({ problem: explainTrackerError(error) });
    }

    useLayout.getState().setAiPanelVisible(true);
    await useAi.getState().sendPrompt(
      translate("tracker.aiPrompt", {
        type: item.itemType,
        id: item.id,
        title: item.title,
        state: item.state,
        url: item.webUrl,
        description: description === "" ? translate("tracker.noDescription") : description,
      }),
      rootPath,
    );
  },
}));

/**
 * A board belongs to a project, so opening another one has to forget this one's
 * work before it shows anything - the same rule the git store follows.
 *
 * Forgetting is all that happens here: reading the new project's board is the
 * panel's job when it mounts. Doing it from the subscription instead put three
 * IPC calls into every project open, including the opens of everyone who never
 * looks at this panel - work nobody asked for, at the moment the editor is
 * busiest.
 */
useWorkspace.subscribe((state, previous) => {
  if (state.rootPath === previous.rootPath) return;
  // `ready` goes back with them: which board *this* project uses is unread
  // again, and the panel must wait rather than ask a question it will answer
  // itself a moment later.
  useTrackers.setState({ items: [], problem: null, activeId: null, loadedAt: null, ready: false });
});
