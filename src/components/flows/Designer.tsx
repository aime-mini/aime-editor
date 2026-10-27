import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardPaste,
  Copy,
  FlaskConical,
  History as HistoryIcon,
  LayoutGrid,
  Loader2,
  Maximize2,
  MousePointerSquareDashed,
  Play,
  Plus,
  Redo2,
  Repeat,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  Unplug,
} from "lucide-react";
import { useT } from "../../i18n";
import {
  addStep,
  disconnect,
  duplicateSteps,
  fragmentOf,
  insertOnWire,
  pasteFragment,
  removeSteps,
  type Fragment,
  type Point,
  type PortRef,
} from "../../lib/flows/editing";
import { EMPTY_HISTORY, recorded, redone, undone, type History } from "../../lib/flows/history";
import { freshStepId, freshStepName } from "../../lib/flows/ids";
import { NODE_HEIGHT, NODE_WIDTH, arrange, placeBeside } from "../../lib/flows/layout";
import { DEFAULT_LOOP_ROUNDS, OUT_PORT, type Flow, type Step, type Wire } from "../../lib/flows/model";
import { loopWires, validate } from "../../lib/flows/validate";
import { shortcutLabel, typingInField, withModifier } from "../../lib/shortcuts";
import { useFlows } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { ContextMenu, SEPARATOR, type MenuItem } from "../ContextMenu";
import { PromptModal } from "../PromptModal";
import { ABILITIES, PALETTE, newStep, type PaletteEntry } from "./abilities";
import { FlowsBreadcrumb } from "./Breadcrumb";
import { FlowCanvas, edgeId, type CanvasHandle, type ScreenPoint } from "./FlowCanvas";
import { Inspector } from "./Inspector";
import { Palette, PaletteGhostCard } from "./Palette";
import { RunDialog } from "./RunDialog";
import { DesignerGuide, SelectionPanel } from "./StepGuide";
import { usePaletteDrag } from "./usePaletteDrag";

/** How long after the last edit the flow file is written. */
const SAVE_AFTER_MS = 600;

/**
 * What was copied, for pasting into this flow or another - one clipboard for
 * the whole app session, the way an editor's own clipboard works.
 */
let copied: Fragment | null = null;

/** The menus the designer opens: on a step, on the empty canvas, on a wire, and the list of steps to add. */
type DesignerMenu =
  | { kind: "step"; id: string; screen: ScreenPoint }
  | { kind: "canvas"; at: Point; screen: ScreenPoint }
  | { kind: "wire"; wire: Wire; at: Point; screen: ScreenPoint }
  | { kind: "add"; at: Point; screen: ScreenPoint; from?: PortRef; into?: Wire };

/** A step's card centred on a point: where a step dropped or added from a menu lands. */
const centredOn = (point: Point): Point => ({
  x: Math.round(point.x - NODE_WIDTH / 2),
  y: Math.round(point.y - NODE_HEIGHT / 2),
});

/**
 * Designing one flow: the palette on the left, the canvas in the middle, the
 * picked step's settings - with its guide on top - on the right. Steps come in
 * by click or by drag, wires by dragging a port, and every edit can be taken
 * back. Every edit lands in the flow file a moment later, so there is nothing
 * to save and nothing to lose; the pill in the header says when the last edit
 * is on disk.
 */
export function Designer({ slug }: { slug: string }) {
  const t = useT();
  const stored = useFlows((s) => s.flows.find((flow) => flow.slug === slug));
  const save = useFlows((s) => s.save);
  const openHistory = useFlows((s) => s.openHistory);
  const editByDescription = useFlows((s) => s.editByDescription);
  const tryStep = useFlows((s) => s.tryStep);
  const drawing = useFlows((s) => s.drawing);
  const [asking, setAsking] = useState(false);
  /** The loop wire whose round limit is being asked for. */
  const [limiting, setLimiting] = useState<Wire | null>(null);
  // What is shown is the stored flow until the person edits it, then their
  // draft until that draft is on disk - so a flow saved from elsewhere (the
  // AI drawing it, an import) shows through the moment nothing is pending.
  const [draft, setDraft] = useState<Flow | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  /** The menu on screen, its entries made when it was opened. */
  const [menu, setMenu] = useState<{ screen: ScreenPoint; items: (MenuItem | typeof SEPARATOR)[] } | null>(
    null,
  );
  const [overWire, setOverWire] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const timer = useRef<number | null>(null);
  const edits = useRef(0);
  const canvas = useRef<CanvasHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  /** Where the pointer last was over the canvas: where Paste puts what was copied. */
  const pointer = useRef<ScreenPoint | null>(null);
  const flow = draft ?? stored?.flow ?? null;
  const saved = draft === null;

  const change = useCallback(
    (next: Flow) => {
      setDraft(next);
      edits.current += 1;
      const edit = edits.current;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        save(slug, next)
          .then(() => {
            // A newer edit is on its way to disk already; it clears the draft.
            if (edits.current === edit) setDraft(null);
          })
          .catch(failedTo(t("flows.saveFailed")));
      }, SAVE_AFTER_MS);
    },
    [save, slug, t],
  );

  /** Puts a pending draft on disk now, so nothing saved later writes over it. */
  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (draft !== null) {
      await save(slug, draft);
      setDraft(null);
    }
  }, [draft, save, slug]);

  const problems = useMemo(() => (flow === null ? [] : validate(flow)), [flow]);
  const errors = problems.filter((problem) => problem.kind === "error");

  // ---- editing ------------------------------------------------------------------------

  /** An edit the person made: kept for undo, then saved. */
  const edit = (next: Flow) => {
    if (flow !== null) setHistory((current) => recorded(current, flow, Date.now()));
    change(next);
  };
  const stepFor = (entry: PaletteEntry): Step =>
    newStep(
      entry,
      freshStepId(entry.key, flow?.steps.map((step) => step.id) ?? []),
      freshStepName(t(entry.label), flow?.steps.map((step) => step.name) ?? []),
    );
  /** A step the person asked for, picked once it is in. */
  const putIn = (next: Flow, ids: string[]) => {
    edit(next);
    setSelected(ids);
  };

  const drag = usePaletteDrag(
    (x, y) => {
      const wire = canvas.current?.wireAt(x, y) ?? null;
      setOverWire(wire === null ? null : edgeId(wire));
    },
    (entry, x, y) => {
      setOverWire(null);
      const at = canvas.current?.pointAt(x, y) ?? null;
      if (flow === null || at === null) return;
      const step = stepFor(entry);
      const wire = canvas.current?.wireAt(x, y) ?? null;
      putIn(
        wire === null ? addStep(flow, step, centredOn(at)) : insertOnWire(flow, wire, step, centredOn(at)),
        [step.id],
      );
    },
  );

  const frameCanvas = useCallback(() => {
    canvas.current?.frame();
  }, []);
  const undo = () => {
    if (flow === null) return;
    const back = undone(history, flow);
    if (back === null) return;
    setHistory(back.history);
    change(back.flow);
    setSelected((ids) => ids.filter((id) => back.flow.steps.some((step) => step.id === id)));
  };
  const redo = () => {
    if (flow === null) return;
    const forward = redone(history, flow);
    if (forward === null) return;
    setHistory(forward.history);
    change(forward.flow);
  };
  const copy = (ids: readonly string[]) => {
    if (flow !== null) copied = fragmentOf(flow, ids) ?? copied;
  };
  const paste = (at?: Point) => {
    if (flow === null || copied === null) return;
    const pasted = pasteFragment(flow, copied, at);
    putIn(pasted.flow, pasted.ids);
  };
  const duplicate = (ids: readonly string[]) => {
    if (flow === null) return;
    const twin = duplicateSteps(flow, ids);
    if (twin.ids.length > 0) putIn(twin.flow, twin.ids);
  };
  const remove = (ids: readonly string[]) => {
    if (flow === null) return;
    edit(removeSteps(flow, ids));
    setSelected([]);
  };

  // ---- keys ---------------------------------------------------------------------------

  const keys = useRef({ undo, redo, copy, paste, duplicate, selected, flow });
  useEffect(() => {
    keys.current = { undo, redo, copy, paste, duplicate, selected, flow };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A field keeps its own undo and copy; an open menu or dialog has the keys.
      if (typingInField(event.target) || document.querySelector('[role="dialog"], [role="menu"]') !== null)
        return;
      if (root.current?.isConnected !== true || !withModifier(event)) return;
      const now = keys.current;
      const key = event.key.toLowerCase();
      const act = (action: () => void) => {
        event.preventDefault();
        action();
      };
      if (key === "z" && !event.shiftKey) act(now.undo);
      else if (key === "y" || (key === "z" && event.shiftKey)) act(now.redo);
      else if (key === "d" && now.selected.length > 0)
        act(() => {
          now.duplicate(now.selected);
        });
      else if (key === "c" && now.selected.length > 0 && window.getSelection()?.toString() === "")
        act(() => {
          now.copy(now.selected);
        });
      else if (key === "v" && copied !== null) {
        const over =
          pointer.current === null ? null : canvas.current?.pointAt(pointer.current.x, pointer.current.y);
        act(() => {
          now.paste(over === null || over === undefined ? undefined : over);
        });
      } else if (key === "a" && now.flow !== null) {
        const all = now.flow.steps.map((step) => step.id);
        act(() => {
          setSelected(all);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (flow === null) return null;
  const selectedStep = selected.length === 1 ? flow.steps.find((step) => step.id === selected[0]) : undefined;

  /** A click on the palette: the step goes beside the picked one, wired from it. */
  const add = (entry: PaletteEntry) => {
    if (drag.wasDrag()) return;
    const step = stepFor(entry);
    const anchor = selectedStep ?? flow.steps.at(-1);
    const from =
      anchor !== undefined && anchor.config.ability !== "gate"
        ? { step: anchor.id, port: OUT_PORT }
        : undefined;
    putIn(addStep(flow, step, placeBeside(flow, anchor), from), [step.id]);
  };

  /** A step picked from the add menu: where the menu was opened, wired from a port or into a wire. */
  const place = (entry: PaletteEntry, at: Point, from?: PortRef, into?: Wire) => {
    const step = stepFor(entry);
    putIn(
      into === undefined
        ? addStep(flow, step, centredOn(at), from)
        : insertOnWire(flow, into, step, centredOn(at)),
      [step.id],
    );
  };

  const changeStep = (step: Step) => {
    edit({ ...flow, steps: flow.steps.map((candidate) => (candidate.id === step.id ? step : candidate)) });
  };

  // ---- menus --------------------------------------------------------------------------

  const menuItems = (open: DesignerMenu): (MenuItem | typeof SEPARATOR)[] => {
    switch (open.kind) {
      case "add":
        return PALETTE.flatMap((group) => group.entries).map((entry) => {
          const Icon = entry.icon ?? ABILITIES[entry.ability].icon;
          return {
            label: t(entry.label),
            icon: <Icon size={14} />,
            onClick: () => {
              place(entry, open.at, open.from, open.into);
            },
          };
        });
      case "step": {
        const step = flow.steps.find((candidate) => candidate.id === open.id);
        if (step === undefined) return [];
        const many = selected.includes(step.id) && selected.length > 1 ? selected : [step.id];
        const isInput = step.config.ability === "input";
        const items: (MenuItem | typeof SEPARATOR)[] = [];
        if (!isInput) {
          items.push(
            {
              label: t("flows.menu.duplicate"),
              icon: <Copy size={14} />,
              shortcut: shortcutLabel("D"),
              onClick: () => {
                duplicate(many);
              },
            },
            {
              label: t("flows.menu.copy"),
              icon: <Copy size={14} />,
              shortcut: shortcutLabel("C"),
              onClick: () => {
                copy(many);
              },
            },
            {
              label: t("flows.inspector.try"),
              icon: <FlaskConical size={14} />,
              onClick: () => {
                tryStep(slug, step.id).catch(failedTo(t("flows.inspector.try")));
              },
            },
          );
        }
        items.push({
          label: t("flows.menu.disconnect"),
          icon: <Unplug size={14} />,
          onClick: () => {
            edit(disconnect(flow, step.id));
          },
        });
        if (!isInput) {
          items.push(SEPARATOR, {
            label: t("flows.menu.delete"),
            icon: <Trash2 size={14} />,
            shortcut: "Del",
            danger: true,
            onClick: () => {
              remove(many);
            },
          });
        }
        return items;
      }
      case "canvas":
        return [
          {
            label: t("flows.menu.addHere"),
            icon: <Plus size={14} />,
            onClick: () => {
              // Opened from this one's click, after it closes.
              window.setTimeout(() => {
                openMenu({ kind: "add", at: open.at, screen: open.screen });
              });
            },
          },
          ...(copied === null
            ? []
            : [
                {
                  label: t("flows.menu.paste"),
                  icon: <ClipboardPaste size={14} />,
                  shortcut: shortcutLabel("V"),
                  onClick: () => {
                    paste(open.at);
                  },
                },
              ]),
          {
            label: t("flows.menu.selectAll"),
            icon: <MousePointerSquareDashed size={14} />,
            shortcut: shortcutLabel("A"),
            onClick: () => {
              setSelected(flow.steps.map((step) => step.id));
            },
          },
          SEPARATOR,
          {
            label: t("flows.designer.arrange"),
            icon: <LayoutGrid size={14} />,
            onClick: () => {
              edit({ ...flow, layout: arrange(flow) });
            },
          },
          {
            label: t("flows.canvas.frame"),
            icon: <Maximize2 size={14} />,
            onClick: frameCanvas,
          },
        ];
      case "wire":
        return [
          ...(loopWires(flow).some((loop) => edgeId(loop) === edgeId(open.wire))
            ? [
                {
                  label: t("flows.menu.rounds", { n: open.wire.maxRounds ?? 0 }),
                  icon: <Repeat size={14} />,
                  onClick: () => {
                    setLimiting(open.wire);
                  },
                },
              ]
            : []),
          {
            label: t("flows.menu.insertHere"),
            icon: <Plus size={14} />,
            onClick: () => {
              window.setTimeout(() => {
                openMenu({ kind: "add", at: open.at, screen: open.screen, into: open.wire });
              });
            },
          },
          SEPARATOR,
          {
            label: t("flows.menu.deleteWire"),
            icon: <Trash2 size={14} />,
            danger: true,
            onClick: () => {
              edit({ ...flow, wires: flow.wires.filter((wire) => edgeId(wire) !== edgeId(open.wire)) });
            },
          },
        ];
    }
  };

  /** Opens a menu, with its entries as they stand now - nothing changes while a menu is open. */
  function openMenu(open: DesignerMenu) {
    setMenu({ screen: open.screen, items: menuItems(open) });
  }

  const headerButton =
    "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg disabled:opacity-40";

  return (
    <div ref={root} className="flex h-full flex-col" data-flow-designer={slug}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        <FlowsBreadcrumb>
          <input
            value={flow.name}
            onChange={(e) => {
              edit({ ...flow, name: e.target.value });
            }}
            className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 font-semibold outline-none hover:bg-elevated focus:bg-elevated"
            title={t("flows.designer.name")}
          />
        </FlowsBreadcrumb>
        <span
          className="rounded-full bg-elevated px-2 py-0.5 text-[11px] text-muted"
          data-flow-saved={saved ? "yes" : "no"}
        >
          {t("flows.designer.steps", { n: flow.steps.length })} ·{" "}
          {saved ? t("flows.designer.saved") : t("flows.designer.saving")}
        </span>
        {errors.length > 0 && (
          <span
            className="flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger"
            title={errors.map((p) => p.message).join("\n")}
          >
            <TriangleAlert size={11} /> {t("flows.designer.problems", { n: errors.length })}
          </span>
        )}
        <button
          onClick={undo}
          disabled={history.past.length === 0}
          className={headerButton}
          title={`${t("flows.menu.undo")} (${shortcutLabel("Z")})`}
          data-flow-undo
        >
          <Undo2 size={12} />
        </button>
        <button
          onClick={redo}
          disabled={history.future.length === 0}
          className={headerButton}
          title={`${t("flows.menu.redo")} (${shortcutLabel("Y")})`}
          data-flow-redo
        >
          <Redo2 size={12} />
        </button>
        <button
          onClick={() => {
            setAsking(true);
          }}
          disabled={drawing}
          className={headerButton}
          title={t("flows.designer.editByDescriptionHint")}
          data-flow-edit-by-description
        >
          {drawing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{" "}
          {t("flows.designer.editByDescription")}
        </button>
        <button
          onClick={() => {
            edit({ ...flow, layout: arrange(flow) });
          }}
          className={headerButton}
          title={t("flows.designer.arrangeHint")}
        >
          <LayoutGrid size={12} /> {t("flows.designer.arrange")}
        </button>
        <button
          onClick={() => {
            openHistory(slug);
          }}
          className={headerButton}
        >
          <HistoryIcon size={12} /> {t("flows.designer.history")}
        </button>
        <button
          onClick={() => {
            setRunning(true);
          }}
          disabled={errors.length > 0}
          className="flex items-center gap-1 rounded-md bg-accent-strong px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          data-flow-run
        >
          <Play size={12} /> {t("flows.designer.run")}
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[164px_1fr_272px]">
        <Palette onAdd={add} onPress={drag.begin} />
        <section
          className="min-w-0 bg-bg"
          onPointerMove={(event) => {
            pointer.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerLeave={() => {
            pointer.current = null;
          }}
        >
          <FlowCanvas
            ref={canvas}
            flow={flow}
            selected={selected}
            onSelect={setSelected}
            editing={{
              onChange: edit,
              onLayout: change,
              onPortDroppedEmpty: (from, at, screen) => {
                openMenu({ kind: "add", at, screen, from });
              },
              onStepMenu: (id, screen) => {
                if (!selected.includes(id)) setSelected([id]);
                openMenu({ kind: "step", id, screen });
              },
              onCanvasMenu: (at, screen) => {
                openMenu({ kind: "canvas", at, screen });
              },
              onWireMenu: (wire, at, screen) => {
                openMenu({ kind: "wire", wire, at, screen });
              },
              highlightedWire: overWire,
            }}
            hint={t("flows.canvas.designHint", { undo: shortcutLabel("Z") })}
          />
        </section>
        <aside className="min-h-0 overflow-y-auto border-l border-line bg-panel">
          {selectedStep !== undefined ? (
            <Inspector
              slug={slug}
              flow={flow}
              step={selectedStep}
              problems={problems}
              onChange={changeStep}
              onChangeFlow={edit}
              onRemove={() => {
                remove([selectedStep.id]);
              }}
            />
          ) : selected.length > 1 ? (
            <SelectionPanel
              count={selected.length}
              onDuplicate={() => {
                duplicate(selected);
              }}
              onDelete={() => {
                remove(selected);
              }}
            />
          ) : (
            <DesignerGuide />
          )}
        </aside>
      </div>
      {drag.ghost !== null && <PaletteGhostCard ghost={drag.ghost} />}
      {menu !== null && (
        <ContextMenu
          x={menu.screen.x}
          y={menu.screen.y}
          items={menu.items}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      {running && (
        <RunDialog
          slug={slug}
          flow={flow}
          onClose={() => {
            setRunning(false);
          }}
        />
      )}
      {limiting !== null && (
        <PromptModal
          title={t("flows.rounds.title", { from: limiting.from, to: limiting.to })}
          hint={t("flows.rounds.hint")}
          initialValue={String(limiting.maxRounds ?? DEFAULT_LOOP_ROUNDS)}
          onSubmit={(answer) => {
            // Anything but a whole number from 1 keeps the dialog open to be corrected.
            const rounds = Number(answer);
            if (!Number.isInteger(rounds) || rounds < 1) return;
            setLimiting(null);
            edit({
              ...flow,
              wires: flow.wires.map((wire) =>
                edgeId(wire) === edgeId(limiting) ? { ...wire, maxRounds: rounds } : wire,
              ),
            });
          }}
          onClose={() => {
            setLimiting(null);
          }}
        />
      )}
      {asking && (
        <PromptModal
          title={t("flows.designer.editByDescription")}
          hint={t("flows.designer.editByDescriptionHint")}
          initialValue=""
          submitLabel={t("flows.designer.editGo")}
          onSubmit={(request) => {
            setAsking(false);
            flush()
              .then(() => editByDescription(slug, request))
              .catch(failedTo(t("flows.designer.editByDescription")));
          }}
          onClose={() => {
            setAsking(false);
          }}
        />
      )}
    </div>
  );
}
