import { useEffect, useState } from "react";
import { useFlows, type RunHead, type StoredFlow } from "../../stores/flows";
import { loggedAs } from "../../stores/notices";

/** How a run on disk ended; one with no ending is one the app was closed in the middle of. */
export type RunOutcome = "done" | "failed" | "cancelled" | "interrupted";

export function outcomeOf(head: RunHead): RunOutcome {
  return head.last.kind === "run-done" ? head.last.status : "interrupted";
}

/**
 * The newest run of each flow as its journal tells it. The runs in memory
 * are only this session's: without the journals, a flow that ran yesterday
 * read "never ran", and a run waiting for an approval when the app closed
 * could only be found three screens deep.
 */
export function useNewestRuns(flows: readonly StoredFlow[]): ReadonlyMap<string, RunHead> {
  const listRuns = useFlows((s) => s.listRuns);
  // Asked again whenever a run of this session starts or ends.
  const ended = useFlows((s) =>
    Object.values(s.runs)
      .map((run) => `${run.id}:${run.status}`)
      .join(","),
  );
  const [newest, setNewest] = useState<ReadonlyMap<string, RunHead>>(new Map());

  useEffect(() => {
    let stale = false;
    Promise.all(flows.map(async (stored) => [stored.slug, (await listRuns(stored.slug)).at(0)] as const))
      .then((pairs) => {
        if (stale) return;
        setNewest(new Map(pairs.filter((pair): pair is [string, RunHead] => pair[1] !== undefined)));
      })
      .catch(loggedAs("flows: reading the newest runs"));
    return () => {
      stale = true;
    };
  }, [flows, listRuns, ended]);

  return newest;
}
