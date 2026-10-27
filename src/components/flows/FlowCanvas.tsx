import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnConnectEnd,
  type OnDelete,
  type OnSelectionChangeFunc,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useT } from "../../i18n";
import { removeSteps, type Point, type PortRef } from "../../lib/flows/editing";
import { arrange } from "../../lib/flows/layout";
import { DEFAULT_LOOP_ROUNDS, ERROR_PORT, OUT_PORT, type Flow, type Wire } from "../../lib/flows/model";
import { loopWires } from "../../lib/flows/validate";
import type { RunView } from "../../stores/flows";
import { StepNode, type StepNodeData } from "./StepNode";

/** A point on the screen, where a menu opens. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** What the designer asks of the canvas while a step is dragged in from the palette. */
export interface CanvasHandle {
  /** The canvas point under a screen point, or null when the point is not over the canvas. */
  pointAt: (clientX: number, clientY: number) => Point | null;
  /** The wire under a screen point: where a step dropped there goes. */
  wireAt: (clientX: number, clientY: number) => Wire | null;
  /** Brings the whole flow back into view. */
  frame: () => void;
}

/** Everything a canvas that takes edits reports back; a run's canvas has none of it. */
export interface CanvasEditing {
  /** An edit the person made: one step back for undo. */
  onChange: (flow: Flow) => void;
  /** Places given to steps that had none - the canvas's doing, not an edit to undo. */
  onLayout: (flow: Flow) => void;
  /** A wire dragged out of a port and let go over empty canvas: the person wants a step there. */
  onPortDroppedEmpty: (from: PortRef, at: Point, screen: ScreenPoint) => void;
  onStepMenu: (stepId: string, screen: ScreenPoint) => void;
  onCanvasMenu: (at: Point, screen: ScreenPoint) => void;
  onWireMenu: (wire: Wire, at: Point, screen: ScreenPoint) => void;
  /** The wire to mark while a step from the palette is held over it. */
  highlightedWire?: string | null;
}

/**
 * The flow as a picture: steps as nodes, wires as edges, left to right.
 *
 * The canvas is told the flow and tells back what the person did to it -
 * steps moved, picked or deleted, a wire drawn or removed, a menu asked for -
 * and never edits the flow itself; the designer owns the flow and saves it.
 * In a run the same canvas shows each step's state and takes no edits.
 */
export interface FlowCanvasProps {
  flow: Flow;
  selected: readonly string[];
  onSelect: (stepIds: string[]) => void;
  /** Absent for a run view, which is read-only. */
  editing?: CanvasEditing;
  run?: RunView;
  /** The line along the bottom edge: what can be done here. */
  hint?: string;
  ref?: Ref<CanvasHandle>;
}

const NODE_TYPES = { step: StepNode };
/**
 * How the canvas frames the flow: from the top left, the way it reads, at life
 * size when it fits - never zoomed in past it, and never out so far that a step
 * cannot be read; a long flow is panned, not shrunk to confetti.
 */
const FRAME = { padding: 24, minZoom: 0.5, maxZoom: 1 };
/** Constants, not literals in the props: xyflow copies a changed prop into its store on every render. */
const DELETE_KEYS = ["Delete", "Backspace"];
/** The minimap, in the bottom corner above the hints: the flow is framed from the top left, so that corner is free. */
const MINIMAP_SIZE = { width: 150, height: 96 };
const ADD_TO_SELECTION_KEYS = ["Control", "Meta", "Shift"];
const NO_EDGES: Edge[] = [];

export function FlowCanvas(props: FlowCanvasProps) {
  // A provider of its own, so the canvas can turn screen points into its own
  // coordinates for the menus, the dangling wire and a step dropped in.
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ flow, selected, onSelect, editing, run, hint, ref }: FlowCanvasProps) {
  const readOnly = editing === undefined;
  const { screenToFlowPosition } = useReactFlow();
  const frame = useFrameSteps();
  const loops = useMemo(() => new Set(loopWires(flow)), [flow]);
  const container = useRef<HTMLDivElement>(null);

  // The nodes are xyflow's state, so that a click, a drag in progress and a
  // hover stay inside the canvas: a step the flow did not change keeps its
  // node object, and React leaves its card alone.
  const [nodes, setNodes, applyChanges] = useNodesState<Node<StepNodeData>>([]);
  useEffect(() => {
    setNodes((current) => nodesOf(flow, run, readOnly, current));
  }, [flow, run, readOnly, setNodes]);
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const picked = selected.includes(node.id);
        return node.selected === picked ? node : { ...node, selected: picked };
      }),
    );
  }, [selected, setNodes]);

  // Each wire keeps its edge object while it looks the same, as the steps keep
  // their nodes: a new object makes xyflow draw that wire again, and remaking
  // all of them on every keystroke cost a flow of 80 steps up to 100 ms a key.
  // xyflow's state too, so a click picks a wire and Del takes it out.
  const [edges, setEdges, onEdgesChange] = useEdgesState(NO_EDGES);
  const highlighted = editing?.highlightedWire ?? undefined;
  useEffect(() => {
    setEdges((current) => edgesOf(flow, loops, run, highlighted, current));
  }, [flow, loops, run, highlighted, setEdges]);

  // One callback for the canvas's whole life: xyflow calls it again whenever
  // it changes, and a callback remade with each selection reported the old
  // selection back over the new one - the two passed it to and fro until
  // React gave up (measured: "Maximum update depth exceeded" on adding a step).
  const selection = useRef({ selected, onSelect });
  useEffect(() => {
    selection.current = { selected, onSelect };
  });
  const onSelectionChange: OnSelectionChangeFunc<Node<StepNodeData>> = useCallback(({ nodes: picked }) => {
    const ids = picked.map((node) => node.id);
    const { selected: now, onSelect: tell } = selection.current;
    if (ids.length !== now.length || ids.some((id) => !now.includes(id))) tell(ids);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<StepNodeData>>[]) => {
      applyChanges(changes);
      if (editing === undefined) return;
      let next = flow;
      for (const change of changes) {
        // A drop lands in the flow; the drag before it is the canvas's own affair.
        if (change.type === "position" && change.position !== undefined && !change.dragging) {
          next = { ...next, layout: { ...(next.layout ?? arrange(next)), [change.id]: change.position } };
        }
      }
      if (next !== flow) editing.onChange(next);
    },
    [applyChanges, flow, editing],
  );

  // Steps and wires deleted together arrive together, so the flow changes once.
  const onDelete: OnDelete<Node<StepNodeData>> = useCallback(
    ({ nodes: gone, edges: cut }) => {
      if (editing === undefined) return;
      const cutIds = new Set(cut.map((edge) => edge.id));
      const without = removeSteps(
        flow,
        gone.map((node) => node.id),
      );
      editing.onChange({ ...without, wires: without.wires.filter((wire) => !cutIds.has(edgeId(wire))) });
    },
    [flow, editing],
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (editing === undefined || connection.source === connection.target) return;
      const wire: Wire = {
        from: connection.source,
        port: connection.sourceHandle ?? OUT_PORT,
        to: connection.target,
      };
      if (flow.wires.some((existing) => edgeId(existing) === edgeId(wire))) return;
      const next = { ...flow, wires: [...flow.wires, wire] };
      // A wire that closes a loop needs its limit; the wire's menu changes it.
      const closesLoop = loopWires(next).some((candidate) => edgeId(candidate) === edgeId(wire));
      editing.onChange(
        closesLoop
          ? {
              ...next,
              wires: next.wires.map((w) => (w === wire ? { ...w, maxRounds: DEFAULT_LOOP_ROUNDS } : w)),
            }
          : next,
      );
    },
    [flow, editing],
  );

  const canvasPoint = useCallback(
    (event: { clientX: number; clientY: number }) =>
      screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    [screenToFlowPosition],
  );
  const wireOf = useCallback((id: string) => flow.wires.find((wire) => edgeId(wire) === id), [flow.wires]);
  // The designer's callbacks are made anew with each render; the handlers
  // below read the newest through this, so xyflow is handed them once.
  const latest = useRef({ editing, wireOf });
  useEffect(() => {
    latest.current = { editing, wireOf };
  });

  useImperativeHandle(
    ref,
    () => ({
      pointAt: (clientX, clientY) => {
        const box = container.current?.getBoundingClientRect();
        if (box === undefined) return null;
        const inside =
          clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
        return inside ? screenToFlowPosition({ x: clientX, y: clientY }) : null;
      },
      wireAt: (clientX, clientY) => {
        const id = document
          .elementFromPoint(clientX, clientY)
          ?.closest(".react-flow__edge")
          ?.getAttribute("data-id");
        return id === undefined || id === null ? null : (wireOf(id) ?? null);
      },
      frame,
    }),
    [frame, screenToFlowPosition, wireOf],
  );

  // A wire pulled out of an output and let go over empty canvas asks for a step there.
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connection) => {
      const { editing } = latest.current;
      if (editing === undefined || connection.isValid === true || connection.toNode !== null) return;
      if (connection.fromNode === null || connection.fromHandle.type !== "source") return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      editing.onPortDroppedEmpty(
        { step: connection.fromNode.id, port: connection.fromHandle.id ?? OUT_PORT },
        canvasPoint(point),
        { x: point.clientX, y: point.clientY },
      );
    },
    [canvasPoint],
  );
  const onNodeContextMenu = useCallback((event: ReactMouseEvent, node: Node<StepNodeData>) => {
    const { editing } = latest.current;
    if (editing === undefined) return;
    event.preventDefault();
    editing.onStepMenu(node.id, { x: event.clientX, y: event.clientY });
  }, []);
  const onEdgeContextMenu = useCallback(
    (event: ReactMouseEvent, edge: Edge) => {
      const { editing, wireOf } = latest.current;
      const wire = wireOf(edge.id);
      if (editing === undefined || wire === undefined) return;
      event.preventDefault();
      editing.onWireMenu(wire, canvasPoint(event), { x: event.clientX, y: event.clientY });
    },
    [canvasPoint],
  );
  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      const { editing } = latest.current;
      if (editing === undefined) return;
      event.preventDefault();
      editing.onCanvasMenu(canvasPoint(event), { x: event.clientX, y: event.clientY });
    },
    [canvasPoint],
  );

  // A flow drawn by hand or by the AI with no positions yet gets them once, so
  // what the person sees is what the file says from then on.
  useEffect(() => {
    if (editing !== undefined && flow.layout === undefined)
      editing.onLayout({ ...flow, layout: arrange(flow) });
  }, [flow, editing]);

  return (
    // A container for the overlays to measure: the canvas narrows with the
    // sidebar and the AI panel open, and its corners have room for less.
    <div ref={container} className="@container h-full w-full" data-flow-canvas>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onDelete={onDelete}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : DELETE_KEYS}
        // A drag on empty canvas moves the view and Shift+drag draws a box round
        // the steps to pick. The mockups had a plain drag pick and Space+drag
        // move, but measured on xyflow 12 that pairing threw the view thousands
        // of pixels the wrong way for a 150px drag; the default does not.
        selectionKeyCode="Shift"
        multiSelectionKeyCode={ADD_TO_SELECTION_KEYS}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
        <FrameOnChange count={flow.steps.length} />
        {editing !== undefined && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            bgColor="var(--bg-panel)"
            maskColor="rgba(0, 0, 0, 0.12)"
            nodeColor="var(--bg-elevated)"
            nodeStrokeColor="var(--accent)"
            nodeBorderRadius={4}
            style={MINIMAP_SIZE}
            className="!mb-9 overflow-hidden rounded-md border border-line shadow-sm @max-md:!hidden"
            data-flow-minimap
          />
        )}
        <Panel position="bottom-left">
          <ZoomBar />
        </Panel>
        {hint !== undefined && (
          // One line, and only where it fits beside the zoom bar: wrapped, it ran over the bar.
          <Panel
            position="bottom-right"
            className="hidden text-[11px] whitespace-nowrap text-muted @2xl:block"
            data-flow-canvas-hint
          >
            {hint}
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/**
 * Frames the steps from the top left (`FRAME`). Read from the store when it
 * runs rather than subscribed to, so resizing the window leaves alone a view
 * the person has panned.
 */
function useFrameSteps(): () => void {
  const { getNodes, getNodesBounds, setViewport } = useReactFlow();
  const store = useStoreApi();
  return useCallback(() => {
    const nodes = getNodes();
    const { width, height } = store.getState();
    if (nodes.length === 0 || width === 0 || height === 0) return;
    const bounds = getNodesBounds(nodes);
    const room = (size: number) => size - 2 * FRAME.padding;
    const zoom = Math.min(
      FRAME.maxZoom,
      Math.max(FRAME.minZoom, Math.min(room(width) / bounds.width, room(height) / bounds.height)),
    );
    void setViewport(
      { x: FRAME.padding - bounds.x * zoom, y: FRAME.padding - bounds.y * zoom, zoom },
      { duration: 200 },
    );
  }, [getNodes, getNodesBounds, setViewport, store]);
}

/** Whether every step is inside the part of the canvas on screen. */
function useAllStepsInView(): () => boolean {
  const { getNodes, getNodesBounds } = useReactFlow();
  const store = useStoreApi();
  return useCallback(() => {
    const { width, height, transform } = store.getState();
    const [x, y, zoom] = transform;
    const bounds = getNodesBounds(getNodes());
    return (
      bounds.x * zoom + x >= 0 &&
      bounds.y * zoom + y >= 0 &&
      (bounds.x + bounds.width) * zoom + x <= width &&
      (bounds.y + bounds.height) * zoom + y <= height
    );
  }, [getNodes, getNodesBounds, store]);
}

/**
 * Frames the steps once they are measured, and again when a step is added or
 * removed out of sight - the AI drawing more of the flow. An edit made where
 * the person is looking leaves the view alone: reframing on every drop,
 * duplicate and undo zoomed the canvas away from the step just touched.
 */
function FrameOnChange({ count }: { count: number }) {
  const measured = useNodesInitialized();
  const frame = useFrameSteps();
  const allInView = useAllStepsInView();
  const framed = useRef(false);
  useEffect(() => {
    if (!measured) return;
    if (!framed.current || !allInView()) frame();
    framed.current = true;
  }, [count, measured, frame, allInView]);
  return null;
}

/** Zoom out, how far, zoom in, and back to the whole flow. */
function ZoomBar() {
  const t = useT();
  const { zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const frame = useFrameSteps();
  const button = "grid size-6 place-items-center rounded text-muted hover:bg-elevated hover:text-fg";
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line bg-panel px-1 py-0.5 text-[11.5px] shadow-sm">
      <button
        onClick={() => {
          void zoomOut();
        }}
        title={t("flows.canvas.zoomOut")}
        className={button}
      >
        <Minus size={12} />
      </button>
      <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
      <button
        onClick={() => {
          void zoomIn();
        }}
        title={t("flows.canvas.zoomIn")}
        className={button}
      >
        <Plus size={12} />
      </button>
      <button onClick={frame} title={t("flows.canvas.frame")} className={button}>
        <Maximize2 size={11} />
      </button>
    </div>
  );
}

export const edgeId = (wire: Wire) => `${wire.from}:${wire.port}->${wire.to}`;

/**
 * The nodes for a flow, reusing the node of every step whose card would
 * look the same - the step itself, its error wire and its run state - so
 * that one edit redraws one card.
 */
function nodesOf(
  flow: Flow,
  run: RunView | undefined,
  readOnly: boolean,
  current: Node<StepNodeData>[],
): Node<StepNodeData>[] {
  const positions = flow.layout ?? arrange(flow);
  const known = new Map(current.map((node) => [node.id, node]));
  return flow.steps.map((step) => {
    const view = run?.steps[step.id];
    const data: StepNodeData = {
      step,
      errorWired: flow.wires.some((wire) => wire.from === step.id && wire.port === ERROR_PORT),
      state: view?.state,
      summary: view?.summary,
      round: view?.round,
    };
    const position = positions[step.id] ?? { x: 0, y: 0 };
    const previous = known.get(step.id);
    if (previous !== undefined && sameData(previous.data, data) && samePoint(previous.position, position)) {
      return previous;
    }
    return {
      id: step.id,
      type: "step",
      position,
      selected: previous?.selected ?? false,
      draggable: !readOnly,
      // Every flow starts from its input step; it can be moved, never deleted.
      deletable: !readOnly && step.config.ability !== "input",
      data,
    };
  });
}

/** The canvas's edges for the flow's wires, reusing each of `current` that would draw the same. */
function edgesOf(
  flow: Flow,
  loops: ReadonlySet<Wire>,
  run: RunView | undefined,
  highlighted: string | undefined,
  current: Edge[],
): Edge[] {
  const known = new Map(current.map((edge) => [edge.id, edge]));
  // A picked wire stays picked through an edit elsewhere, and reads as picked.
  // A step added a moment ago may have no place yet; it counts as the left edge.
  const placed: Partial<Record<string, { x: number }>> = flow.layout ?? arrange(flow);
  const columnOf = (id: string) => placed[id]?.x ?? 0;
  return flow.wires.map((wire) => {
    const key = edgeId(wire);
    const loop = loops.has(wire);
    // A wire into an earlier column - the next row of a wrapped flow, or a
    // loop - is routed round the cards rather than drawn back across them.
    const backwards = columnOf(wire.to) < columnOf(wire.from);
    const stepView = run?.steps[wire.from];
    const travelled = stepView?.state === "done" || stepView?.state === "running";
    const before = known.get(key);
    const marked = highlighted === key || before?.selected === true;
    const edge = {
      id: key,
      selected: before?.selected ?? false,
      source: wire.from,
      sourceHandle: wire.port,
      target: wire.to,
      targetHandle: "in",
      type: backwards ? "smoothstep" : "default",
      pathOptions: backwards ? { borderRadius: 12 } : undefined,
      animated: run !== undefined && stepView?.state === "done" && run.steps[wire.to]?.state === "running",
      label: loop ? `≤ ${String(wire.maxRounds ?? 0)}` : wire.port === ERROR_PORT ? "error" : undefined,
      labelStyle: { fontSize: 10, fill: loop ? "#fbbf24" : "var(--text-muted)" },
      labelBgStyle: { fill: "var(--bg-elevated)" },
      style: {
        stroke: marked
          ? "var(--accent)"
          : wire.port === ERROR_PORT
            ? "var(--danger)"
            : loop
              ? "#fbbf24"
              : travelled
                ? "var(--accent)"
                : "#4a5160",
        strokeWidth: marked ? 3.5 : travelled ? 2 : 1.6,
        strokeDasharray: loop ? "5 4" : undefined,
      },
    };
    return before !== undefined && sameEdge(before, edge) ? before : edge;
  });
}

/** Whether two edges for the same wire draw the same: every field of theirs is a value or a flat style. */
function sameEdge(a: Edge, b: Edge): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameData(a: StepNodeData, b: StepNodeData): boolean {
  return (
    a.step === b.step &&
    a.errorWired === b.errorWired &&
    a.state === b.state &&
    a.summary === b.summary &&
    a.round === b.round
  );
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}
