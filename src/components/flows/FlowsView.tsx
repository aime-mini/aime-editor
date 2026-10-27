import { useEffect } from "react";
import { useFlows } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { Designer } from "./Designer";
import { FlowsHub } from "./FlowsHub";
import { HistoryList } from "./HistoryList";
import { RunScreen } from "./RunScreen";
import { useFlowsFollowWorkspace } from "./useFlowsFollowWorkspace";

/**
 * The editor area while the flows tab is in front: the run being watched,
 * else the flow being designed, else its run history, else the hub - the
 * project's flows, the person's own, the templates, and the box that draws
 * a flow from a sentence.
 */
export function FlowsView() {
  const { view, runs, flows } = useFlows();
  const watchAsks = useFlows((s) => s.watchAsks);
  const watchRunRequests = useFlows((s) => s.watchRunRequests);
  useFlowsFollowWorkspace();
  useEffect(() => watchAsks(), [watchAsks]);
  useEffect(() => {
    const watching = watchRunRequests().catch((error: unknown) => {
      failedTo("flows:run-request")(error);
      return () => undefined;
    });
    return () => {
      void watching.then((stop) => {
        stop();
      });
    };
  }, [watchRunRequests]);

  if (view.kind === "run" && view.runId in runs) return <RunScreen runId={view.runId} />;
  if (view.kind === "history") return <HistoryList slug={view.slug} />;
  if (view.kind === "designer" && flows.some((flow) => flow.slug === view.slug))
    return <Designer key={view.slug} slug={view.slug} />;
  return <FlowsHub />;
}
