import { GripVertical } from "lucide-react";
import { useT } from "../../i18n";
import { ABILITIES, PALETTE, type PaletteEntry } from "./abilities";
import type { PaletteGhost } from "./usePaletteDrag";

/**
 * The steps a flow can be made of, by group. A click adds one beside the
 * picked step, wired from it; a drag puts one exactly where it is let go -
 * onto a wire, to go between the two steps it joins.
 */
export function Palette({
  onAdd,
  onPress,
}: {
  onAdd: (entry: PaletteEntry) => void;
  onPress: (entry: PaletteEntry, event: React.PointerEvent) => void;
}) {
  const t = useT();
  return (
    <aside className="overflow-y-auto border-r border-line bg-panel px-2 py-2 select-none" data-flow-palette>
      {PALETTE.map((group) => (
        <div key={group.group} className="mb-3">
          <h4 className="mb-1 px-1 text-[10.5px] font-semibold tracking-wider text-muted uppercase">
            {t(group.group)}
          </h4>
          {group.entries.map((entry) => (
            <button
              key={entry.key}
              onPointerDown={(event) => {
                onPress(entry, event);
              }}
              onClick={() => {
                onAdd(entry);
              }}
              title={`${t(entry.note)}\n${t("flows.palette.dragHint")}`}
              className="group flex w-full cursor-grab items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-elevated active:cursor-grabbing"
              data-flow-add={entry.key}
            >
              <EntryIcon entry={entry} />
              <span className="min-w-0 flex-1">
                <b className="block truncate text-[12px] font-semibold">{t(entry.label)}</b>
                <small className="block truncate text-[10.5px] text-muted">{t(entry.note)}</small>
              </span>
              <GripVertical size={12} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}

/** The step being dragged, following the pointer until it is let go. */
export function PaletteGhostCard({ ghost }: { ghost: PaletteGhost }) {
  const t = useT();
  return (
    <div
      className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-lg border border-accent bg-panel px-2.5 py-1.5 text-[12px] shadow-xl"
      style={{ left: ghost.x + 12, top: ghost.y + 8 }}
      data-flow-drag-ghost
    >
      <EntryIcon entry={ghost.entry} />
      <b className="font-semibold">{t(ghost.entry.label)}</b>
    </div>
  );
}

function EntryIcon({ entry }: { entry: PaletteEntry }) {
  const look = ABILITIES[entry.ability];
  const Icon = entry.icon ?? look.icon;
  return (
    <span className={`grid size-6 shrink-0 place-items-center rounded-md ${look.swatch}`}>
      <Icon size={13} strokeWidth={2.4} />
    </span>
  );
}
