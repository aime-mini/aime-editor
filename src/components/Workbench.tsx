import { useEffect, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { Bot, PanelLeft, SquareTerminal } from "lucide-react";
import { useT } from "../i18n";
import { AiPanel } from "./AiPanel";
import { BottomPanel } from "./BottomPanel";
import { EditorPane } from "./EditorPane";
import { Sidebar } from "./Sidebar";
import { useLayout } from "../stores/layout";

/** Drag bar between panels — thin, highlighted on hover/drag. */
function ResizeHandle({ horizontal = false }: { horizontal?: boolean }) {
  return (
    <PanelResizeHandle
      className={`${horizontal ? "h-[3px]" : "w-[3px]"} shrink-0 bg-line transition-colors hover:bg-accent data-[resize-handle-state=drag]:bg-accent`}
    />
  );
}

/** Thin strip shown while a panel is collapsed — one click brings it back. */
function CollapsedRail({
  icon,
  title,
  onExpand,
  horizontal = false,
}: {
  icon: ReactNode;
  title: string;
  onExpand: () => void;
  horizontal?: boolean;
}) {
  return (
    <div className={`flex h-full bg-panel ${horizontal ? "items-center pl-2" : "justify-center pt-2"}`}>
      <button
        onClick={onExpand}
        title={title}
        className="h-fit rounded p-1.5 text-muted hover:bg-elevated hover:text-accent"
      >
        {icon}
      </button>
    </div>
  );
}

/**
 * Everything a project needs open: tree, editor, AI, terminal.
 *
 * Its own module so it can be loaded on demand. Monaco is 4.4 MB of
 * JavaScript, and the welcome screen - the first thing anyone sees - has no
 * use for it; splitting here is what lets that screen paint without it
 * (ARCHITECTURE.md §1.2, "genuinely light").
 */
export default function Workbench() {
  const sidebarRef = useRef<ImperativePanelHandle>(null);
  const aiPanelRef = useRef<ImperativePanelHandle>(null);
  const bottomRef = useRef<ImperativePanelHandle>(null);
  const {
    sidebarVisible,
    aiPanelVisible,
    bottomVisible,
    setSidebarVisible,
    setAiPanelVisible,
    setBottomVisible,
  } = useLayout();
  const t = useT();

  // The store is the source of truth — Ctrl+B/Ctrl+L/Ctrl+` and status bar
  // buttons drive it, and these effects sync the panels to it.
  useEffect(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    if (sidebarVisible && panel.isCollapsed()) panel.expand();
    if (!sidebarVisible && !panel.isCollapsed()) panel.collapse();
  }, [sidebarVisible]);

  useEffect(() => {
    const panel = aiPanelRef.current;
    if (!panel) return;
    if (aiPanelVisible && panel.isCollapsed()) panel.expand();
    if (!aiPanelVisible && !panel.isCollapsed()) panel.collapse();
  }, [aiPanelVisible]);

  useEffect(() => {
    const panel = bottomRef.current;
    if (!panel) return;
    if (bottomVisible && panel.isCollapsed()) panel.expand();
    if (!bottomVisible && !panel.isCollapsed()) panel.collapse();
  }, [bottomVisible]);

  // Dragging below minSize snaps the panel into a thin rail (collapsedSize),
  // never to nothing — the rail keeps an expand button visible.
  return (
    // autoSaveId v2: invalidates layouts saved by earlier panel configurations
    <PanelGroup direction="horizontal" autoSaveId="aime-layout-v2">
      <Panel
        ref={sidebarRef}
        id="sidebar"
        order={1}
        collapsible
        collapsedSize={3}
        defaultSize={18}
        minSize={10}
        maxSize={40}
        onCollapse={() => {
          setSidebarVisible(false);
        }}
        onExpand={() => {
          setSidebarVisible(true);
        }}
        className="bg-panel"
      >
        {sidebarVisible ? (
          <Sidebar />
        ) : (
          <CollapsedRail
            icon={<PanelLeft size={16} />}
            title={t("layout.toggleSidebar")}
            onExpand={() => {
              setSidebarVisible(true);
            }}
          />
        )}
      </Panel>
      <ResizeHandle />
      <Panel id="editor" order={2} minSize={30}>
        <PanelGroup direction="vertical" autoSaveId="aime-editor-stack">
          <Panel id="editor-pane" order={1} minSize={25}>
            <EditorPane />
          </Panel>
          <ResizeHandle horizontal />
          <Panel
            ref={bottomRef}
            id="terminal"
            order={2}
            collapsible
            collapsedSize={4}
            defaultSize={28}
            minSize={10}
            maxSize={75}
            onCollapse={() => {
              setBottomVisible(false);
            }}
            onExpand={() => {
              setBottomVisible(true);
            }}
          >
            <div className={bottomVisible ? "h-full" : "hidden"}>
              <BottomPanel />
            </div>
            {!bottomVisible && (
              <CollapsedRail
                horizontal
                icon={<SquareTerminal size={16} />}
                title={t("layout.toggleTerminal")}
                onExpand={() => {
                  setBottomVisible(true);
                }}
              />
            )}
          </Panel>
        </PanelGroup>
      </Panel>
      <ResizeHandle />
      <Panel
        ref={aiPanelRef}
        id="ai"
        order={3}
        collapsible
        collapsedSize={3}
        defaultSize={26}
        minSize={15}
        maxSize={50}
        onCollapse={() => {
          setAiPanelVisible(false);
        }}
        onExpand={() => {
          setAiPanelVisible(true);
        }}
      >
        {aiPanelVisible ? (
          <AiPanel />
        ) : (
          <CollapsedRail
            icon={<Bot size={16} />}
            title={t("layout.toggleAiPanel")}
            onExpand={() => {
              setAiPanelVisible(true);
            }}
          />
        )}
      </Panel>
    </PanelGroup>
  );
}
