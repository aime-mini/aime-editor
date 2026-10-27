import { translate } from "../../i18n";
import { useFlows } from "../../stores/flows";
import { useLayout } from "../../stores/layout";
import { told, failedTo } from "../../stores/notices";
import { useWorkspace } from "../../stores/workspace";
import { slugOf } from "./model";

/** `/flow <name> [what to run it with]` typed into the chat box. */
const FLOW_COMMAND = /^\/flow\s+(\S+)\s*([\s\S]*)$/;

/**
 * Runs a flow from the chat composer; returns whether the text was that
 * command (so the chat does not send it to the AI). The name matches a
 * flow's slug or its name; the rest of the line is the run's input.
 */
export function runFlowCommand(prompt: string): boolean {
  const match = FLOW_COMMAND.exec(prompt);
  if (match === null) return false;
  const [, name, text] = match;
  const { flows, start, openRun } = useFlows.getState();
  const slug =
    flows.find((flow) => flow.slug === name)?.slug ??
    flows.find((flow) => slugOf(flow.flow.name) === slugOf(name))?.slug;
  if (slug === undefined) {
    told(
      translate("flows.cli.unknown", { flow: name }),
      flows.map((flow) => flow.slug).join(", ") || translate("flows.panel.empty"),
    );
    return true;
  }
  useLayout.getState().setSidebarView("flows");
  useWorkspace.getState().openFlows();
  start(slug, { text: text.trim(), items: [], params: {} })
    .then(openRun)
    .catch(failedTo(translate("flows.cli.failed", { flow: slug })));
  return true;
}
