import { useEffect } from "react";
import { useLayout } from "../stores/layout";
import { useWorkspace } from "../stores/workspace";

/** Where the panels' state from before the flows page is kept until the page is left. */
const STORAGE_KEY = "aime.flowsPagePanels";

interface Panels {
  sidebarVisible: boolean;
  aiPanelVisible: boolean;
}

function isPanels(value: unknown): value is Panels {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof Panels, unknown>>;
  return typeof candidate.sidebarVisible === "boolean" && typeof candidate.aiPanelVisible === "boolean";
}

/**
 * The panels as they were before the page took the window - kept across a
 * restart, because the panel library saves them folded, and a window closed on
 * the flows page would otherwise come back with nothing to unfold to.
 */
function savedPanels(): Panels | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return isPanels(parsed) ? parsed : null;
  } catch (error: unknown) {
    console.warn("the panels from before the flows page could not be read back:", error);
    return null;
  }
}

function keepPanels(panels: Panels | null) {
  try {
    if (panels === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(panels));
  } catch (error: unknown) {
    console.warn("the panels from before the flows page could not be kept:", error);
  }
}

/**
 * The flows page is a page of its own: while it is in front
 * the sidebar folds to its rail and the AI panel to its strip, and leaving the
 * page puts both back the way they were. Measured on a 1280px window: between
 * the two panels the canvas had 420px, and the steps ran under the inspector.
 * Either panel can still be opened while the page is up; leaving restores what
 * was there before it.
 */
export function useFlowsPageFocus() {
  const flowsOpen = useWorkspace((s) => s.flowsOpen);
  useEffect(() => {
    if (!flowsOpen) return;
    const layout = useLayout.getState();
    const before = savedPanels() ?? {
      sidebarVisible: layout.sidebarVisible,
      aiPanelVisible: layout.aiPanelVisible,
    };
    keepPanels(before);
    layout.setSidebarVisible(false);
    layout.setAiPanelVisible(false);
    return () => {
      const now = useLayout.getState();
      now.setSidebarVisible(before.sidebarVisible);
      now.setAiPanelVisible(before.aiPanelVisible);
      keepPanels(null);
    };
  }, [flowsOpen]);
}
