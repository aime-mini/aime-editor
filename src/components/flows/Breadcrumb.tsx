import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useT } from "../../i18n";
import { useFlows } from "../../stores/flows";

/**
 * "← Flows / what is open": the way back to the flows page every flows screen
 * starts its header with - the designer, a run, the history.
 */
export function FlowsBreadcrumb({ children }: { children?: ReactNode }) {
  const t = useT();
  const openHub = useFlows((s) => s.openHub);
  return (
    <>
      <button
        onClick={openHub}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted hover:bg-elevated hover:text-fg"
        title={t("flows.designer.backToHub")}
        data-flows-back
      >
        <ArrowLeft size={13} /> {t("flows.tabTitle")}
      </button>
      {children !== undefined && <span className="text-muted">/</span>}
      {children}
    </>
  );
}
