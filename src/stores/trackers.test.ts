import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerConnection, WorkItem } from "./trackers";

/**
 * What the panel shows has to belong to the board this workspace is bound to.
 *
 * The case worth a test is the one no click produces: another window re-points
 * this project at a different board, so the binding read back from disk is not
 * the one the items on screen came from. Without clearing them, the freshness
 * check would skip the refresh and leave the other board's work in place.
 */

const BOARD_A = "azure-devops:contoso/web";
const BOARD_B = "azure-devops:contoso/api";

function connection(id: string): TrackerConnection {
  return { id, kind: "azure-devops", label: id, settings: {}, hasToken: true };
}

function workItem(id: string): WorkItem {
  return {
    id,
    displayId: null,
    parent: null,
    dimensions: [],
    title: `Item ${id}`,
    itemType: "Task",
    state: "Doing",
    category: "inProgress",
    webUrl: `https://dev.azure.com/contoso/Web/_workitems/edit/${id}`,
  };
}

/** What the Rust side would answer; tests set `bound` before calling. */
let bound = BOARD_A;
let workItemCalls = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    switch (command) {
      case "tracker_kinds":
        return Promise.resolve([]);
      case "tracker_connections":
        return Promise.resolve([connection(BOARD_A), connection(BOARD_B)]);
      case "tracker_binding":
        return Promise.resolve(bound);
      case "tracker_work_items":
        workItemCalls += 1;
        return Promise.resolve([workItem(String(workItemCalls))]);
      default:
        return Promise.resolve(null);
    }
  },
}));

vi.mock("./workspace", () => ({
  useWorkspace: {
    getState: () => ({ rootPath: "C:\\work\\site" }),
    subscribe: () => () => undefined,
  },
}));

const { useTrackers } = await import("./trackers");

describe("the board a workspace is bound to", () => {
  beforeEach(() => {
    bound = BOARD_A;
    workItemCalls = 0;
    useTrackers.setState({
      connections: [],
      activeId: null,
      items: [],
      loadedAt: null,
      problem: null,
    });
  });

  it("keeps its items while they are fresh, so switching tabs costs nothing", async () => {
    await useTrackers.getState().load();
    expect(useTrackers.getState().activeId).toBe(BOARD_A);
    expect(workItemCalls).toBe(1);

    await useTrackers.getState().load();
    expect(workItemCalls).toBe(1);
    expect(useTrackers.getState().items).toHaveLength(1);
  });

  it("drops them the moment the binding on disk is another board", async () => {
    await useTrackers.getState().load();
    const shown = useTrackers.getState().items;
    expect(shown).toHaveLength(1);

    // Another window pointed this project somewhere else.
    bound = BOARD_B;
    await useTrackers.getState().load();

    expect(useTrackers.getState().activeId).toBe(BOARD_B);
    expect(workItemCalls).toBe(2);
    expect(useTrackers.getState().items).not.toEqual(shown);
  });

  it("shows no board at all when the binding points at a connection that is gone", async () => {
    bound = "azure-devops:contoso/deleted";
    await useTrackers.getState().load();

    expect(useTrackers.getState().activeId).toBeNull();
    expect(useTrackers.getState().items).toEqual([]);
    expect(workItemCalls).toBe(0);
  });
});
