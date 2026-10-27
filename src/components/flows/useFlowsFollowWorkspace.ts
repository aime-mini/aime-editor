import { useEffect } from "react";
import { useT } from "../../i18n";
import { useFlows } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { useWorkspace } from "../../stores/workspace";

/**
 * Keeps the flows store on the open workspace. The sidebar list and the page
 * both call it, because the page is often on screen without the list: the
 * sidebar folds to a rail beside it, and a session reopens straight onto it.
 * Left to the list alone, the page had no project to draw a flow into.
 */
export function useFlowsFollowWorkspace() {
  const t = useT();
  const rootPath = useWorkspace((s) => s.rootPath);
  const root = useFlows((s) => s.root);
  const load = useFlows((s) => s.load);
  useEffect(() => {
    if (rootPath !== null && rootPath !== root)
      void load(rootPath).catch(failedTo(t("flows.panel.loadFailed")));
  }, [rootPath, root, load, t]);
}
